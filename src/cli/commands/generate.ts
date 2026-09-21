import type { Command } from "commander";
import {
  type DefinitionLike,
  getAssetEntry,
  getStage,
  listAssetPaths,
  parseStageScope,
} from "../../core/address.js";
import type { GenerationBackend } from "../../core/backend.js";
import { assertSpendAllowed, stageSpendItems } from "../../core/backend-policy.js";
import { loadKonteConfig } from "../../core/config.js";
import { computeDependencyLevels } from "../../core/dependency-levels.js";
import { printCapped } from "../format-list.js";
import { TURBO_TAKE_NOTE, turboTakes } from "../turbo-takes.js";
import { syncFileAssets } from "../../core/file-sync.js";
import {
  buildDependencyGraph,
  collectTransitiveDependents,
  listUnusedAssetPaths,
} from "../../core/graph.js";
import { plateFork } from "../../core/stale-refresh.js";
import { JobManager } from "../../core/job-manager.js";
import {
  activeGenerationVariantIds,
  findPendingPatches,
  loadPatchCatalog,
} from "../../core/patch.js";
import { JobIndex } from "../../core/job-index.js";
import { type PendingReason, describePendingJob } from "../../core/pending-jobs.js";
import { assertPinGate } from "../../core/pin-check.js";
import { assertPromptGate } from "../../core/prompt-check.js";
import { applyPatch, assertPatchSpendAllowed } from "../patch-orchestrator.js";
import { selectDefinition } from "../../core/select-definition.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import {
  collectUndecidedUpstreamTakes,
  computeAcceptedStaleness,
  formatStaleCause,
} from "../../core/staleness.js";
import { StateManager } from "../../core/state/index.js";
import type { AssetDefinition, BackendKind } from "../../core/types/index.js";
import {
  assertAnimaticConsumed,
  assertUpstreamAccepted,
  gateDirectionForStage,
  gateStageChecks,
  loadStageDefinitions,
} from "../load-definition.js";
import { errorMessage } from "../../core/errors.js";
import {
  type AcceptedStaleAsset,
  type AssetResult,
  assetSkipReason,
  buildGeneratePlan,
  createPendingJobs,
  ensureComfyModelJobs,
  ensureComfyNodeJobs,
  formatAcceptedStaleNotice,
  formatComfyDownloadNotice,
  formatGeneratePlan,
  formatUndecidedUpstreamTakesNotice,
  type LevelResult,
  preflightComfyAssets,
  reserveVariantsBatch,
  type SkipReason,
  submitAssetJobs,
  type VariantReservationRequest,
} from "../generate-orchestrator.js";
import { requireVideoRoots } from "../context.js";
import { applyResolutionDefinitions } from "../../core/definition-hashes.js";

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
      const { video, animatic, reference } = await loadStageDefinitions(videoRoot);

      // `selectDefinition` rejects the one scope with no assets (`direction`), so what it hands
      // back carries the stage already narrowed to one that owns them — which is what the
      // asset-address helpers below need.
      const loaded = selectDefinition(stage, { video, animatic, reference });
      const def: DefinitionLike = loaded.def;

      const assetEntryOf = (address: string): AssetDefinition => getAssetEntry(def, address);

      // Before the gates: they ask strict resolution what counts as accepted upstream work.
      await applyResolutionDefinitions({
        videoRoot,
        definitions: { video, animatic, reference },
      });

      // Gate on the direction before spending: an unresolved arc hole for this stage's scope aborts
      // with DIRECTION_CHECK_FAILED. realizedIds is this stage's realized shot order.
      await gateDirectionForStage({
        videoRoot,
        command: "generate",
        stage,
        realizedIds: stage === "reference" ? undefined : def.shots.map((s) => s.id),
      });

      // The prompts this stage would spend on and the frames it would pin, before any job is
      // created.
      await gateStageChecks(def, loaded.stage);

      // The spend gate, before any job is created. Definition-level (it inspects the declared
      // stage, not just what this run would submit) so the failure is deterministic.
      const config = await loadKonteConfig(roots.workspace);
      assertSpendAllowed(stageSpendItems(def, loaded.stage), config);

      const variantCount = 1;

      const syncForStage = async (m: StateManager) => {
        if (stage === "reference") {
          await syncFileAssets({ reference }, m, { measure: true });
        } else if (stage === "animatic") {
          await syncFileAssets({ reference, animatic }, m, { measure: true });
        } else {
          await syncFileAssets({ reference, animatic, video }, m, { measure: true });
        }
      };

      let manager: StateManager;
      if (opts.plan) {
        // Dry-run: sync file assets in memory only, never persist.
        manager = await StateManager.load(videoRoot);
        await syncForStage(manager);
      } else {
        // Persist the file-asset sync under the state lock so it cannot clobber a
        // concurrent watcher write; reuse the returned post-sync snapshot for the
        // run's read-only decisions (the orchestrator does its own locked writes).
        manager = await StateManager.withLock(videoRoot, async (m) => {
          await syncForStage(m);
          return m;
        });
      }

      const stageAssetPaths = new Set(listAssetPaths(def, loaded.stage));
      const graph = buildDependencyGraph(video, animatic, reference);

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
            collectTransitiveDependents(graph, address).map((assetPath) => ({ assetPath })),
            def,
          );
          return {
            address,
            cause,
            command: `konte reroll ${address}`,
            ...(fork ? { fork } : {}),
          };
        });

      // The acceptance gate below only reaches what a spend consumes, so a video shot wired to no
      // board routes around it.
      if (stage === "video") {
        assertAnimaticConsumed({ video, animatic, graph });
      }

      const { levels } = computeDependencyLevels(graph);

      // Skip assets nothing consumes — generating them would spend on output no deliverable
      // uses. Usage spans every stage (the graph is global): a reference asset is "used" once
      // it is exposed via `reference.<name>` or consumed by another reference asset, so a
      // published-but-not-yet-referenced building block still generates; only a declared asset
      // that is neither exposed nor consumed is skipped — the same rule as an unused video/
      // animatic asset.
      const skippedUnused = listUnusedAssetPaths(video, animatic, graph, reference).filter((p) =>
        stageAssetPaths.has(p),
      );
      for (const p of skippedUnused) stageAssetPaths.delete(p);
      if (skippedUnused.length > 0) {
        console.log(
          `Skipping ${skippedUnused.length} unused asset(s) (used by no composition, panel, or reference export): ${skippedUnused.join(", ")}`,
        );
      }

      // The cross-stage twin of the direction acceptance gate: a spend must not build on work no
      // human has accepted — the boards a video derives motion from, and the sheets either creative
      // stage derives identity from. Gated on what this run would really submit — an asset it would
      // skip anyway (accepted, ready, in flight) must not block the shots that still have work,
      // which is the whole point of gating per consumed dependency. The reference stage is where
      // those sheets are made, so it has no reviewed upstream of its own.
      if (stage !== "reference") {
        const spending = [...stageAssetPaths].filter((assetPath) => {
          const assetDef = assetEntryOf(assetPath);
          return (
            assetDef.kind !== "file" &&
            !assetSkipReason(
              manager,
              assetPath,
              computeDefinitionHash(assetDef),
              assetDef.deterministic === true,
            )
          );
        });
        assertUpstreamAccepted({ manager, graph, assetPaths: spending, stage, animatic });
      }

      const jobManager = new JobManager(videoRoot);
      const backendCache = new Map<BackendKind, GenerationBackend>();
      const failedAssetPaths = new Set<string>();

      const levelResults: LevelResult[] = [];
      const generatedDepPaths = new Set<string>();
      const pendingReasons = new Map<string, PendingReason>();

      // Present models/nodes get no job — their generation jobs submit immediately; if ComfyUI is
      // unreachable everything is treated as missing, so jobs are created and no-op (or
      // download/install) at run time.
      const comfyEntries: Array<{ address: string; def: AssetDefinition }> = [];
      for (const allAssetPaths of levels) {
        for (const assetPath of allAssetPaths) {
          if (!stageAssetPaths.has(assetPath)) continue;
          const assetDef = assetEntryOf(assetPath);
          if (assetDef.kind === "comfy") comfyEntries.push({ address: assetPath, def: assetDef });
        }
      }
      const { missingModels, missingNodes, comfyDownloads } = await preflightComfyAssets(
        roots,
        comfyEntries,
        config,
      );

      if (opts.plan) {
        const plan = buildGeneratePlan({
          levels,
          graph,
          manager,
          stageAssetPaths,
          variantCount,
          getAssetDef: assetEntryOf,
          missingModels: missingModels.ids,
          missingNodes: missingNodes.ids,
        });
        // The real run applies pending patches too, and each one spends. A plan that omitted them
        // would understate the cost of the command it is previewing.
        const plannedPatches = findPendingPatches(
          manager.getState(),
          await loadPatchCatalog(videoRoot, manager.getState()),
          activeGenerationVariantIds(await jobManager.listJobs()),
          manager.stalenessCache(),
        )
          .filter((p) => getStage(p.sourceAddress) === stage)
          .map((p) => ({ address: p.sourceAddress, source: p.sourceVariantId }));
        // The skip a plan exists to catch: an edit whose regeneration this command will not do.
        const plannedAcceptedStale = describeAcceptedStale(
          plan.levels.flatMap((lvl) =>
            lvl.entries.filter((e) => e.skipReason === "accepted-stale").map((e) => e.address),
          ),
        );
        console.log(formatGeneratePlan(plan));
        const planStaleNotice = formatAcceptedStaleNotice(plannedAcceptedStale);
        if (planStaleNotice) console.warn(`\n${planStaleNotice}`);
        if (plannedPatches.length > 0) {
          console.log(`\nPatches to apply: ${plannedPatches.length}`);
          for (const p of plannedPatches) {
            console.log(`  ${p.address} (patch of ${p.source})`);
          }
        }
        const noticeText = formatComfyDownloadNotice(comfyDownloads);
        if (noticeText) console.log(`\n${noticeText}`);
        return;
      }

      const noticeText = formatComfyDownloadNotice(comfyDownloads);
      if (noticeText) console.log(`\n${noticeText}`);

      // Number the levels shown to the user sequentially. The graph spans both
      // stages, so the global level index is sparse per stage (an animatic-only
      // level is empty for video and vice versa) — displaying it would skip numbers.
      const stageLevels = levels
        .map((allAssetPaths) => allAssetPaths.filter((a) => stageAssetPaths.has(a)))
        .filter((assetPaths) => assetPaths.length > 0);

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
      // daemon) while a long registration runs, and the pending summary must not report a
      // satisfied prereq as still waiting. A job that is gone keeps its stale record.
      const refreshKnownJob = async (jobId: string) => {
        try {
          jobIndex.update(await jobManager.getJob(jobId));
        } catch {
          // cleaned mid-run — leave the stale record
        }
      };

      for (let levelIdx = 0; levelIdx < stageLevels.length; levelIdx++) {
        const assetPaths = stageLevels[levelIdx]!;

        console.log(
          `${levelIdx === 0 ? "\n" : ""}Level ${levelIdx + 1}/${stageLevels.length}: ${assetPaths.length} asset(s)`,
        );

        const assetResults: (AssetResult | null)[] = [];

        // Phase 1 — classify each asset and create comfy prereq jobs, collecting what this
        // level will generate so its variants can be reserved in one state-lock cycle: the
        // per-asset reserve paid a full state load + rewrite each, quadratic in bytes.
        const work: Array<{
          slot: number;
          address: string;
          assetDef: ReturnType<typeof assetEntryOf>;
          deps: string[];
          prereqJobIds: string[];
          pending: boolean;
        }> = [];
        const reservations: VariantReservationRequest[] = [];

        for (const assetPath of assetPaths) {
          const assetDef = assetEntryOf(assetPath);
          const address = assetPath;

          if (assetDef.kind === "file") {
            // file assets need no generation; both stages report them as synced.
            assetResults.push({ address, status: "synced", jobs: [] });
            continue;
          }

          const hasDependencyFailure = (graph.dependencies.get(assetPath) ?? []).some((dep) =>
            failedAssetPaths.has(dep),
          );
          if (hasDependencyFailure) {
            failedAssetPaths.add(assetPath);
            assetResults.push({
              address,
              status: "failed",
              jobs: [],
              error: "Dependency failed",
            });
            continue;
          }

          // Readiness first, then the gate — see buildGeneratePlan for why that order.
          const skipReason = assetSkipReason(
            manager,
            address,
            computeDefinitionHash(assetDef),
            assetDef.deterministic === true,
          );
          if (skipReason) {
            assetResults.push({ address, status: "skipped", skipReason, jobs: [] });
            continue;
          }

          const deps = graph.dependencies.get(assetPath) ?? [];
          for (const d of deps) generatedDepPaths.add(d);
          // A comfy asset's models/nodes are installed by shared jobs the generation job
          // depends on (models → comfy-model-download; nodes → comfy-node-install gated by a
          // comfy-node-activate reboot), so anything with missing models/nodes is pending
          // (submitted by the worker once those are ready), never eager.
          const modelJobIds = await ensureComfyModelJobs(assetDef, jobManager, missingModels);
          const nodeJobIds = await ensureComfyNodeJobs(assetDef, jobManager, missingNodes);
          const prereqJobIds = [...modelJobIds, ...nodeJobIds];
          for (const id of prereqJobIds) await addKnownJob(id);

          const slot = assetResults.push(null) - 1;
          work.push({
            slot,
            address,
            assetDef,
            deps: [...deps],
            prereqJobIds,
            pending: deps.length > 0 || prereqJobIds.length > 0,
          });
          reservations.push({
            address,
            variantCount,
            definitionHash: computeDefinitionHash(assetDef),
            assetDef,
          });
        }

        // Phase 2 — one lock cycle reserves every variant this level generates.
        const reserved = await reserveVariantsBatch(videoRoot, reservations);

        // Phase 3 — create pending jobs / submit eager ones against the reserved variants.
        // If this aborts partway, every reserved variant that got no job file is rolled back:
        // a reservation with no job and no terminal marker reads as active forever, and every
        // later `generate` would skip its asset as "active job(s) exist".
        const jobbedVariantIds = new Set<string>();
        try {
          for (const w of work) {
            const reservedIds = reserved.get(w.address) ?? [];
            if (w.pending) {
              const result = await createPendingJobs(
                w.address,
                w.assetDef,
                w.deps,
                variantCount,
                videoRoot,
                jobManager,
                w.prereqJobIds,
                {},
                null,
                null,
                reservedIds,
              );
              assetResults[w.slot] = result;
              for (const j of result.jobs) jobbedVariantIds.add(j.variantId);
              for (const id of w.prereqJobIds) await refreshKnownJob(id);
              const pendingState = manager.getState();
              // Valid against this snapshot: the jobs registered above wrote job files, not state.
              const pendingCache = manager.stalenessCache();
              for (const j of result.jobs) {
                const rec = await addKnownJob(j.variantId);
                const reason: PendingReason =
                  rec?.kind === "generation"
                    ? describePendingJob(rec, pendingState, jobIndex, pendingCache)
                    : { submittable: false, waitingOn: [] };
                pendingReasons.set(j.variantId, reason);
              }
            } else {
              const result = await submitAssetJobs(
                w.address,
                w.assetDef,
                variantCount,
                roots,
                jobManager,
                backendCache,
                undefined,
                undefined,
                undefined,
                undefined,
                null,
                reservedIds,
              );
              if (result.status === "failed") {
                failedAssetPaths.add(w.address);
              }
              assetResults[w.slot] = result;
              for (const j of result.jobs) {
                jobbedVariantIds.add(j.variantId);
                await addKnownJob(j.variantId);
              }
            }
          }
        } catch (err) {
          await StateManager.withLock(videoRoot, async (mgr) => {
            for (const w of work) {
              for (const id of reserved.get(w.address) ?? []) {
                if (jobbedVariantIds.has(id)) continue;
                try {
                  mgr.removeVariant(w.address, id);
                } catch {
                  // already removed by the per-variant cleanup in the job creators
                }
              }
            }
          });
          throw err;
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
      const patchCatalog = await loadPatchCatalog(videoRoot, manager.getState());
      const pendingPatches = findPendingPatches(
        manager.getState(),
        patchCatalog,
        activeGenerationVariantIds(await jobManager.listJobs()),
        manager.stalenessCache(),
      ).filter((p) => getStage(p.sourceAddress) === stage);
      const patchApplications: Array<{
        source: string;
        address: string;
        variantId: string;
        status: string;
      }> = [];
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
      for (const patch of pendingPatches) {
        try {
          assertPatchSpendAllowed(patch, config);
          assertPromptGate(patch, `patches/${patch.sourceVariantId}.ts`);
          assertPinGate(patch, `patches/${patch.sourceVariantId}.ts`);
          const result = await applyPatch(patch, roots, jobManager, backendCache, config);
          for (const job of result.jobs) {
            patchApplications.push({
              source: patch.sourceVariantId,
              address: result.address,
              variantId: job.variantId,
              status: job.status,
            });
          }
          if (result.status === "failed") {
            patchFailures.push({
              source: patch.sourceVariantId,
              error: result.error ?? "generation failed",
            });
          }
        } catch (err) {
          patchFailures.push({
            source: patch.sourceVariantId,
            error: errorMessage(err),
          });
        }
      }

      // Heads-up: an upstream this run consumes has an undecided take (e.g. a reroll) that
      // resolution won't use — it binds the accepted variant, so this run builds on the accepted
      // frame until that take is accepted in its place.
      const undecidedUpstreamTakes = collectUndecidedUpstreamTakes(
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
            if (j.status === "running") {
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
      // run, or registered with its deps already met, which the watcher submits on the job
      // file's very next event. Which path a take takes turns on whether its asset declares deps
      // at all — not on progress — so splitting the two made the same healthy run read
      // differently stage to stage. Only an unmet dep ("waiting") is a distinct state.
      const summary = {
        started: submittedVariantIds.length + submittableCount,
        waiting: waitingCount,
        synced: assetCounts.synced,
        failed: assetCounts.failed,
        skipped: assetCounts.skipped,
      };

      // Generation is async: this command returns as soon as the jobs are registered.
      const hasWork = summary.started > 0 || summary.waiting > 0;
      const rerollCommand =
        acceptedStale.length > 0
          ? `konte reroll ${acceptedStale.map((a) => a.address).join(" ")}`
          : null;
      const takesNotice = formatUndecidedUpstreamTakesNotice(undecidedUpstreamTakes);
      if (takesNotice) console.warn(`\n${takesNotice}`);
      const staleNotice = formatAcceptedStaleNotice(acceptedStale);
      if (staleNotice) console.warn(`\n${staleNotice}`);
      // Started and skipped work folds into the Summary counts below; only what the caller
      // may have to act on needs naming, so surface those (capped).
      const failed = levelResults.flatMap((lr) =>
        lr.assets
          .filter((a) => a.status === "failed")
          .map((a) => `${a.address}  ${a.error ?? "failed"}`),
      );
      if (failed.length > 0) {
        console.log("\nFailed:");
        printCapped(failed, (line) => line, { verbose: opts.verbose });
      }
      // "waiting" is the only count that can hide a genuinely stuck run, so name what each
      // blocked take is waiting on.
      const onTurbo = await turboTakes(
        videoRoot,
        levelResults.flatMap((lr) =>
          lr.assets.flatMap((a) =>
            a.jobs.map((j) => ({ address: a.address, variantId: j.variantId })),
          ),
        ),
      );
      if (onTurbo.length > 0) {
        console.log(`\nOn turbo — ${TURBO_TAKE_NOTE}:`);
        printCapped(onTurbo, (t) => t.address, { verbose: opts.verbose });
      }
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
      const next = rerollCommand
        ? hasWork
          ? `run \`${rerollCommand}\`, then \`konte job wait\``
          : `run \`${rerollCommand}\``
        : hasWork
          ? "run `konte job wait`"
          : "nothing to wait on; run `konte status`";
      console.log(
        `\n${summary.started} started, ${summary.waiting} waiting, ${summary.synced} synced, ${summary.failed} failed, ${summary.skipped} skipped${skipBreakdown} — ${next}`,
      );

      if (summary.failed > 0 || patchFailures.length > 0) {
        process.exitCode = 1;
      }
    });
}
