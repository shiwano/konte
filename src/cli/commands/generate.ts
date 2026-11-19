import type { Command } from "commander";
import { queueSongAnalyses } from "../../core/song-queue.js";
import {
  type DefinitionLike,
  getAssetEntry,
  getStage,
  parseStageScope,
} from "../../core/address.js";
import { loadKonteConfig } from "../../core/config.js";
import { computeDependencyLevels } from "../../core/dependency-levels.js";
import { printCapped } from "../format-list.js";
import { collectTransitiveDependents } from "../../core/graph.js";
import { plateFork } from "../../core/stale-refresh.js";
import { JobManager } from "../../core/job-manager.js";
import {
  activeGenerationVariantIds,
  findPendingPatches,
  loadPatchCatalog,
} from "../../core/patch.js";
import { JobIndex } from "../../core/job-index.js";
import { type PendingReason, describePendingJob } from "../../core/pending-jobs.js";
import { type PatchRun, applyPatches, preparePatchSpend } from "../patch-orchestrator.js";
import { selectDefinition } from "../../core/select-definition.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import {
  collectUndecidedUpstreamVariants,
  computeAcceptedStaleness,
  formatStaleCause,
} from "../../core/staleness.js";
import { StateManager } from "../../core/state/index.js";
import { type StaleRefreshStep, staleRefreshStep } from "../stale-refresh-step.js";
import type { AssetDefinition } from "../../core/types/index.js";
import { loadDirectionIfPresent } from "../../core/stage-definitions.js";
import { openVideoSession } from "../../core/video-session.js";
import { spendVerdicts } from "../finding-gates.js";
import { loadCheckContext } from "../../core/check-context.js";
import { formatFindingGroups } from "../../core/finding.js";
import { findingFixInstruction, patchSpendRequest } from "../../core/spend-gate.js";
import { errorMessage } from "../../core/errors.js";
import {
  type AcceptedStaleAsset,
  type AssetResult,
  buildGeneratePlan,
  formatAcceptedStaleNotice,
  formatGeneratePlan,
  formatUndecidedUpstreamVariantsNotice,
  type LevelResult,
  prepareSpend,
  printSpendNotices,
  registerJobsBatch,
} from "../generate-orchestrator.js";
import { formatSubmitFailure, submitRegisteredJobs } from "../spend-submit.js";
import { printRemixedBoardStems } from "../generation-selection.js";
import {
  type SkipReason,
  assetSkipReason,
  selectGenerationAssets,
} from "../../core/generation-selection.js";
import { planSupersededStemRemakes, remakeSettledLeaves } from "../../core/board-leaves.js";
import { requireVideoRoots } from "../context.js";

export function registerGenerateCommand(program: Command): void {
  program
    .command("generate <stage>")
    .description("Generate all assets in dependency order for a stage (e.g. animatic, video)")
    .option("--plan", "Dry-run: show what would be generated without creating jobs")
    .option("-v, --verbose", "List every failed asset instead of capping")
    .action(async (scope: string, opts: { plan?: boolean; verbose?: boolean }) => {
      const { stage } = parseStageScope(scope);
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      // The file-asset sync is persisted under the state lock so it cannot clobber a concurrent
      // watcher write, and the run's read-only decisions reuse its post-sync snapshot (the
      // orchestrator does its own locked writes). A plan syncs in memory only. Resolution is
      // registered before the gate, which asks strict resolution what counts as accepted upstream.
      const session = await openVideoSession(videoRoot, {
        sync: opts.plan ? "memory" : "locked",
        through: stage === "direction" ? "reference" : stage,
        measure: true,
      });
      const { definitions: defs, graph } = session;
      let { manager } = session;
      const { video, animatic } = defs;

      // `selectDefinition` rejects the one scope with no assets (`direction`), so what it hands
      // back carries the stage already narrowed to one that owns them — which is what the
      // asset-address helpers below need. A board or video spend while the song they are cut to
      // has no read take stops here on `SONG_UNREAD`.
      const loaded = selectDefinition(stage, defs);
      const def: DefinitionLike = loaded.def;

      const assetEntryOf = (address: string): AssetDefinition => getAssetEntry(def, address);

      const config = await loadKonteConfig(roots.workspace);

      const variantCount = 1;

      // The board stems the video has taken over, re-mixed before the gate asks for them accepted.
      // A plan stands them in, in memory, so it prices what consumes them as the run will.
      if (stage === "video" && video && animatic) {
        if (opts.plan) {
          const accepted = planSupersededStemRemakes(manager, animatic, video);
          printRemixedBoardStems({ accepted }, { plan: true });
        } else {
          const result = await remakeSettledLeaves({
            videoRoot,
            stage: animatic,
            counterpart: video,
            include: "stems",
          });
          if (result.accepted.length > 0) manager = await StateManager.load(videoRoot);
          printRemixedBoardStems(result);
        }
      }

      // Shared by the plan and the run, which must price the same command.
      const describeAcceptedStale = (addresses: readonly string[]): AcceptedStaleAsset[] =>
        addresses.map((address) => {
          const staleness = computeAcceptedStaleness(
            manager.getState(),
            address,
            computeDefinitionHash(assetEntryOf(address)),
            // The verdict being explained is `assetSkipReason`'s — read it the same way.
            manager.stalenessCache(),
          );
          const cause = formatStaleCause(staleness);
          const fork = plateFork(
            address,
            collectTransitiveDependents(graph, address).map((address) => ({ address })),
            def,
          );
          const variantId = manager.getAcceptedVariant(address);
          const step = variantId
            ? staleRefreshStep({
                manager,
                address,
                variantId,
                patchHashes: manager.patchHashes(),
                animatic,
                cache: manager.stalenessCache(),
              })
            : ({ kind: "reroll" } as const);
          return {
            address,
            cause,
            ...describeAcceptedStaleStep(step, variantId),
            ...(fork ? { fork } : {}),
          };
        });

      const { levels } = computeDependencyLevels(graph);

      const selected = selectGenerationAssets({
        definitions: defs,
        stage: loaded.stage,
        manager,
        graph,
      });
      const { stageAddresses, skippedUnused } = selected;
      const jobManager = new JobManager(videoRoot);
      const patchCatalog = await loadPatchCatalog(videoRoot, manager.getState());
      const pendingPatches = findPendingPatches(
        manager.getState(),
        patchCatalog,
        activeGenerationVariantIds(await jobManager.listJobs()),
        manager.stalenessCache(),
      ).filter((p) => getStage(p.sourceAddress) === stage);
      // Before any job is created: a finding or an unaccepted upstream holding the whole stage refuses
      // the run; one holding only some assets or patches leaves them out.
      const [stageVerdict, ...patchVerdicts] = await spendVerdicts(
        await loadCheckContext({
          cueTakes: "resolved",
          videoRoot,
          definitions: defs,
          manager,
          graph,
          patches: pendingPatches,
        }),
        [
          {
            command: "generate",
            stage: loaded.stage,
            addresses: selected.spending,
            targeted: false,
          },
          ...pendingPatches.map((patch) => patchSpendRequest(patch, "patch")),
        ],
      );
      const heldPatches = pendingPatches.flatMap((patch, i) => {
        const error = patchVerdicts[i]!.error;
        return error ? [{ patch, error }] : [];
      });
      const applyingPatches = pendingPatches.filter((_, i) => !patchVerdicts[i]!.error);
      // Every asset held one by one still leaves the patches that pass to run.
      if (stageVerdict!.error && (stageVerdict!.whole || applyingPatches.length === 0)) {
        throw stageVerdict!.error;
      }
      const { held } = stageVerdict!;
      const spending = selected.spending.filter((address) => !held.has(address));
      for (const address of held.keys()) stageAddresses.delete(address);
      const heldCount = selected.spending.length - spending.length + heldPatches.length;
      const heldWhys = selected.spending.flatMap((address) => {
        const why = held.get(address);
        return why ? [why] : [];
      });
      const upstreamHeldCount = heldWhys.filter((why) => why.upstream.length > 0).length;
      const upstreamLines = [...new Set(heldWhys.flatMap((why) => why.upstream))];
      const findingHeldCount = heldWhys.filter((why) => why.findings.length > 0).length;
      const heldFindings = [...new Set(heldWhys.flatMap((why) => why.findings))];
      const spend = await prepareSpend(
        roots,
        spending.map((address) => ({ label: address, def: assetEntryOf(address) })),
        config,
      );
      if (skippedUnused.length > 0) {
        console.log(
          `Skipping ${skippedUnused.length} unused asset(s) (used by no composition, panel, or reference export): ${skippedUnused.join(", ")}`,
        );
      }
      const printHeld = () => {
        if (findingHeldCount > 0) {
          console.log(
            `\nHeld: ${findingHeldCount} asset(s) by a finding — ${findingFixInstruction(heldFindings)}, then run \`konte generate ${stage}\` again:`,
          );
          for (const line of formatFindingGroups(heldFindings)) console.log(line);
        }
        if (upstreamHeldCount > 0) {
          console.log(
            `\nHeld: ${upstreamHeldCount} asset(s) build on upstream work not yet accepted — accept it, then run \`konte generate ${stage}\` again:`,
          );
          printCapped(upstreamLines, (line) => line.trimStart(), { verbose: opts.verbose });
        }
        if (heldPatches.length > 0) {
          console.log(
            `\nHeld: ${heldPatches.length} patch(es) — clear what holds each, then run \`konte generate ${stage}\` again:`,
          );
          for (const { patch, error } of heldPatches) {
            console.log(`  ${patch.sourceAddress} (patch of ${patch.sourceVariantId})`);
            for (const line of error.items) console.log(`  ${line}`);
          }
        }
      };

      const failedAddresses = new Set<string>();

      const levelResults: LevelResult[] = [];
      const generatedDepPaths = new Set<string>();
      const rebuiltAddresses = new Set<string>();
      const pendingReasons = new Map<string, PendingReason>();

      if (opts.plan) {
        const plan = buildGeneratePlan({
          levels,
          graph,
          manager,
          stageAddresses,
          variantCount,
          getAssetDef: assetEntryOf,
          missingModels: spend.missingModels,
          missingNodes: spend.missingNodes,
          targetOf: (d) => spend.targetOf(d),
        });
        // The real run applies pending patches too, and each one spends. A plan that omitted them
        // would understate the cost of the command it is previewing.
        const plannedPatches = applyingPatches.map((p) => ({
          address: p.sourceAddress,
          source: p.sourceVariantId,
        }));
        // The skip a plan exists to catch: an edit whose regeneration this command will not do.
        const plannedAcceptedStale = describeAcceptedStale(
          plan.levels.flatMap((lvl) =>
            lvl.entries.filter((e) => e.skipReason === "accepted-stale").map((e) => e.address),
          ),
        );
        console.log(formatGeneratePlan(plan));
        printHeld();
        const planStaleNotice = formatAcceptedStaleNotice(plannedAcceptedStale);
        if (planStaleNotice) console.warn(`\n${planStaleNotice}`);
        if (plannedPatches.length > 0) {
          console.log(`\nPatches to apply: ${plannedPatches.length}`);
          for (const p of plannedPatches) {
            console.log(`  ${p.address} (patch of ${p.source})`);
          }
        }
        printSpendNotices(spend);
        return;
      }

      printSpendNotices(spend);

      // Number the levels shown to the user sequentially. The graph spans both
      // stages, so the global level index is sparse per stage (an animatic-only
      // level is empty for video and vice versa) — displaying it would skip numbers.
      const stageLevels = levels
        .map((allAddresses) => allAddresses.filter((a) => stageAddresses.has(a)))
        .filter((addresses) => addresses.length > 0);

      // One job-directory scan for the whole run; every job this run creates is added as it
      // is created, so pending-reason descriptions and later levels never re-read the directory
      // (which was quadratic in job count across a large registration).
      const jobIndex = new JobIndex(await jobManager.listJobs());
      const addKnownJob = async (jobId: string) => {
        const existing = jobIndex.get(jobId);
        if (existing) return existing;
        try {
          const rec = await jobManager.getJob(jobId);
          jobIndex.add(rec);
          return rec;
        } catch {
          return null;
        }
      };
      // Re-read a job the index already holds — a model/node prereq can complete (via the
      // worker) while a long registration runs, and the pending summary must not report a
      // satisfied prereq as still waiting. A job that is gone keeps its stale record.
      const refreshKnownJob = async (jobId: string) => {
        try {
          jobIndex.update(await jobManager.getJob(jobId));
        } catch {
          // cleaned mid-run — leave the stale record
        }
      };

      for (let levelIdx = 0; levelIdx < stageLevels.length; levelIdx++) {
        const addresses = stageLevels[levelIdx]!;

        console.log(
          `${levelIdx === 0 ? "\n" : ""}Level ${levelIdx + 1}/${stageLevels.length}: ${addresses.length} asset(s)`,
        );

        const assetResults: (AssetResult | null)[] = [];

        // Phase 1 — classify each asset and create comfy prereq jobs, collecting what this
        // level will generate so it registers in one state-lock cycle: a per-asset registration
        // pays a full state load + rewrite each, quadratic in bytes.
        const work: Array<{
          slot: number;
          address: string;
          assetDef: ReturnType<typeof assetEntryOf>;
          deps: string[];
          prereqJobIds: string[];
        }> = [];

        for (const address of addresses) {
          const assetDef = assetEntryOf(address);

          if (assetDef.kind === "file") {
            // file assets need no generation; both stages report them as synced.
            assetResults.push({ address, status: "synced", jobs: [] });
            continue;
          }

          const hasDependencyFailure = (graph.dependencies.get(address) ?? []).some((dep) =>
            failedAddresses.has(dep),
          );
          if (hasDependencyFailure) {
            failedAddresses.add(address);
            assetResults.push({
              address,
              status: "failed",
              jobs: [],
              error: "Dependency failed",
            });
            continue;
          }

          const deps = graph.dependencies.get(address) ?? [];
          // Readiness first, then the gate — see buildGeneratePlan for why that order.
          const skipReason = assetSkipReason(
            manager,
            address,
            computeDefinitionHash(assetDef),
            assetDef.deterministic === true,
            deps.some((d) => rebuiltAddresses.has(d)),
          );
          if (skipReason) {
            assetResults.push({ address, status: "skipped", skipReason, jobs: [] });
            continue;
          }

          for (const d of deps) generatedDepPaths.add(d);
          // A comfy asset's prerequisites are shared jobs the generation job depends on — on a
          // ComfyUI its models (comfy-model-download) and nodes (comfy-node-install gated by a
          // comfy-node-activate reboot) — so anything with one is pending until it is ready.
          const prereqJobIds = await spend.prereqJobs(assetDef, jobManager);
          for (const id of prereqJobIds) await addKnownJob(id);

          const slot = assetResults.push(null) - 1;
          rebuiltAddresses.add(address);
          work.push({
            slot,
            address,
            assetDef,
            deps: [...deps],
            prereqJobIds,
          });
        }

        // Phase 2 — one lock cycle registers every job this level generates.
        const registered = await registerJobsBatch(
          videoRoot,
          jobManager,
          work.map((w) => ({
            address: w.address,
            assetDef: w.assetDef,
            deps: w.deps,
            variantCount,
            dependsOnJobs: w.prereqJobIds,
            skipIfActive: true,
            comfyTarget: spend.targetOf(w.assetDef),
          })),
        );
        const pendingState = manager.getState();
        const pendingCache = manager.stalenessCache();
        for (const [i, w] of work.entries()) {
          const result = registered[i]!;
          if (result.status === "failed") failedAddresses.add(w.address);
          assetResults[w.slot] = result;
          for (const id of w.prereqJobIds) await refreshKnownJob(id);
          for (const j of result.jobs) {
            const rec = await addKnownJob(j.variantId);
            const reason: PendingReason =
              rec?.kind === "generation"
                ? describePendingJob(rec, pendingState, jobIndex, pendingCache)
                : { submittable: false, waitingOn: [] };
            pendingReasons.set(j.variantId, reason);
          }
        }

        levelResults.push({
          level: levelIdx,
          assets: assetResults.filter((r): r is AssetResult => r !== null),
        });
      }

      // Realize this stage's outstanding corrections in the same pass. A patch is work the author
      // has already declared and not yet spent on — the same status as an ungenerated asset — so
      // requiring a separate command for it would only invite forgetting. It runs after the levels
      // because its source is an existing variant, not something this run produces, and the new
      // variant is left unaccepted: an accepted original keeps winning resolution, so an unreviewed
      // correction never flows downstream on its own. With nothing accepted the correction does
      // become what resolves, staling its consumers — rebuilt by the next run, not this one, whose
      // levels are already behind us.
      const patchFailures: Array<{ source: string; error: string }> = [];
      // Only broken patches belonging to THIS stage are this run's failures. A broken patch
      // elsewhere is real, and `status` reports it, but it must not make `generate reference`
      // exit non-zero over something outside the scope it was given. A script whose source
      // variant is unknown has no stage, so it stays out of both.
      for (const err of patchCatalog.errors) {
        const errAddress = manager.findVariantAddress(err.sourceVariantId);
        if (!errAddress || getStage(errAddress) !== stage) continue;
        patchFailures.push({ source: err.sourceVariantId, error: err.message });
      }
      const patchRuns: PatchRun[] = [];
      for (const patch of applyingPatches) {
        try {
          const patchSpend = await preparePatchSpend(patch, roots, config);
          printSpendNotices(patchSpend);
          patchRuns.push({ patch, spend: patchSpend });
        } catch (err) {
          patchFailures.push({ source: patch.sourceVariantId, error: errorMessage(err) });
        }
      }
      const {
        rows: patchApplications,
        failures: applyFailures,
        steps: patchSteps,
      } = await applyPatches(patchRuns, roots, jobManager);
      patchFailures.push(...applyFailures);

      const submitFailures = await submitRegisteredJobs(
        roots,
        jobManager,
        [...levelResults.flatMap((lr) => lr.assets.flatMap((a) => a.jobs)), ...patchApplications],
        patchSteps,
      );

      // Heads-up: a same-stage upstream this run consumes has an undecided take (e.g. a reroll)
      // that resolution won't use — it binds the accepted variant, so this run builds on the
      // accepted frame until that take is accepted in its place. A cross-stage one holds the asset
      // instead (the spend gate).
      const undecidedUpstreamVariants = collectUndecidedUpstreamVariants(
        manager.getState(),
        [...generatedDepPaths],
        manager.stalenessCache(),
      );

      const acceptedStale = describeAcceptedStale(
        levelResults.flatMap((lr) =>
          lr.assets.filter((a) => a.skipReason === "accepted-stale").map((a) => a.address),
        ),
      );

      const assetCounts = { submitted: 0, pending: 0, synced: 0, failed: 0, skipped: 0 };
      const skipCounts: Record<SkipReason, number> = {
        active: 0,
        accepted: 0,
        "accepted-stale": 0,
        ready: 0,
      };
      const submittedVariantIds: string[] = [];
      const pendingDetails: Array<{
        variantId: string;
        address: string;
        submittable: boolean;
        waitingOn: string[];
      }> = [];

      for (const lr of levelResults) {
        for (const ar of lr.assets) {
          assetCounts[ar.status]++;
          if (ar.skipReason) skipCounts[ar.skipReason]++;
          for (const j of ar.jobs) {
            if (j.status === "running" || j.status === "completed") {
              submittedVariantIds.push(j.variantId);
            } else if (j.status === "pending") {
              const reason = pendingReasons.get(j.variantId) ?? {
                submittable: false,
                waitingOn: [],
              };
              pendingDetails.push({
                variantId: j.variantId,
                address: ar.address,
                submittable: reason.submittable,
                waitingOn: reason.submittable ? [] : reason.waitingOn,
              });
            }
          }
        }
      }

      const submittableCount = pendingDetails.filter((p) => p.submittable).length;
      const waitingCount = pendingDetails.length - submittableCount;

      // "started" merges the two ways a take gets under way: submitted to the backend by this
      // run, or registered with its deps already met, which the next `konte job run` submits. Only an unmet
      // dep ("waiting") is a distinct state.
      const summary = {
        started: submittedVariantIds.length + submittableCount,
        waiting: waitingCount,
        synced: assetCounts.synced,
        failed: assetCounts.failed + submitFailures.length,
        skipped: assetCounts.skipped,
      };

      // A take of the song synced as a file above lands without a job, so its reading is queued here.
      const songReadings = await queueSongAnalyses({
        videoRoot,
        direction: await loadDirectionIfPresent(videoRoot).catch(() => null),
        state: (await StateManager.load(videoRoot)).getState(),
        jobManager,
      });
      if (songReadings.length > 0) {
        console.log(`\nReading the song: ${songReadings.join(", ")}`);
      }
      const hasWork =
        summary.started > 0 ||
        summary.waiting > 0 ||
        songReadings.length > 0 ||
        patchApplications.some((p) => p.status !== "failed");
      const variantsNotice = formatUndecidedUpstreamVariantsNotice(undecidedUpstreamVariants);
      if (variantsNotice) console.warn(`\n${variantsNotice}`);
      const staleNotice = formatAcceptedStaleNotice(acceptedStale);
      if (staleNotice) console.warn(`\n${staleNotice}`);
      // Started and skipped work folds into the Summary counts below; only what the caller
      // may have to act on needs naming, so surface those (capped).
      const failed = [
        ...levelResults.flatMap((lr) =>
          lr.assets
            .filter((a) => a.status === "failed")
            .map((a) => `${a.address}  ${a.error ?? "failed"}`),
        ),
        ...submitFailures.map(formatSubmitFailure),
      ];
      if (failed.length > 0) {
        console.log("\nFailed:");
        printCapped(failed, (line) => line, { verbose: opts.verbose });
      }
      // "waiting" is the only count that can hide a genuinely stuck run, so name what each
      // blocked take is waiting on.
      if (waitingCount > 0) {
        console.log("\nWaiting on:");
        const blocked = pendingDetails
          .filter((p) => !p.submittable)
          .map((p) => `${p.address}  ${p.waitingOn.join(", ")}`);
        printCapped(blocked, (line) => line, { verbose: opts.verbose });
      }
      // A bare "N skipped" reads as a silent no-op, so say what each skip was: nothing to do
      // (accepted / already ready / in flight) vs. a take only `reroll` can replace.
      const skipParts = [
        skipCounts.accepted > 0 ? `${skipCounts.accepted} accepted` : null,
        skipCounts["accepted-stale"] > 0
          ? `${skipCounts["accepted-stale"]} accepted but stale`
          : null,
        skipCounts.ready > 0 ? `${skipCounts.ready} already ready` : null,
        skipCounts.active > 0 ? `${skipCounts.active} in flight` : null,
      ].filter((p) => p !== null);
      const skipBreakdown = skipParts.length > 0 ? ` (${skipParts.join(", ")})` : "";
      printHeld();
      if (patchApplications.length > 0) {
        console.log("\nPatches applied:");
        for (const p of patchApplications) {
          console.log(`  ${p.address}: ${p.status} → ${p.variantId} (patch of ${p.source})`);
        }
      }
      if (patchFailures.length > 0) {
        console.log("\nPatches failed:");
        for (const f of patchFailures) console.log(`  ${f.source}  ${f.error}`);
      }
      // The outcome and the one command that answers it share the last line, so a caller piping
      // through `tail -1` keeps both.
      // A run that only held work is a refusal.
      const heldOnly = !hasWork && heldCount > 0;
      const next = hasWork
        ? "run `konte job run`"
        : heldOnly
          ? `clear what holds each above, then run \`konte generate ${stage}\` again`
          : "nothing to wait on; run `konte status`";
      console.log(
        `\n${summary.started} started, ${summary.waiting} waiting, ${summary.synced} synced, ${summary.failed} failed, ${summary.skipped} skipped${skipBreakdown}${heldCount > 0 ? `, ${heldCount} held` : ""} — ${next}`,
      );

      if (summary.failed > 0 || patchFailures.length > 0 || heldOnly) {
        process.exitCode = 1;
      }
    });
}

function describeAcceptedStaleStep(
  step: StaleRefreshStep,
  variantId: string | null,
): Pick<AcceptedStaleAsset, "step" | "reroll"> {
  switch (step.kind) {
    case "restore":
      return {
        step: `the accept stands — restore the definition in ${step.file} to what made it (\`konte inspect ${variantId}\`) to keep it current`,
        reroll: true,
      };
    case "reroll":
      return { step: null, reroll: true };
    case "patch-apply":
      return { step: `konte patch apply ${step.sourceVariantId}`, reroll: false };
    case "clean":
      return { step: "konte clean (its patch script is gone)", reroll: false };
    case "accept":
      return {
        step: `konte accept ${step.variantId} (already generated, matches the current definition)`,
        reroll: false,
      };
    case "prerequisite":
      return {
        step: `write ${step.missing.join("/")} in ${step.writeIn}, then konte accept ${step.variantId} (already generated, matches the current definition)`,
        reroll: false,
      };
    case "generate":
      return { step: `konte generate ${step.stage}`, reroll: false };
    case "review":
      return { step: `konte preview ${step.stage}`, reroll: false };
    case "stands":
    case "none":
      return { step: "the accept stands", reroll: false };
  }
}
