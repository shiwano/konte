import type { Command } from "commander";
import {
  type AssetStage,
  type DefinitionLike,
  type Stage,
  assertValidAddressScope,
  getAssetEntry,
  getStage,
  isMaterializedLeafAddress,
  isDeliveryAddress,
  listAssetPaths,
  matchesAddressScope,
  tryParseAddress,
  validateAddress,
} from "../../../core/address.js";
import type { GenerationBackend } from "../../../core/backend.js";
import { assertSpendAllowed, isVendorBackendAsset } from "../../../core/backend-policy.js";
import { loadKonteConfig } from "../../../core/config.js";
import { KonteError } from "../../../core/errors.js";
import { syncFileAssets } from "../../../core/file-sync.js";
import {
  buildDependencyGraph,
  collectRerollCascade,
  listUnusedAssetPaths,
} from "../../../core/graph.js";
import { JobIndex } from "../../../core/job-index.js";
import { loadPatchCatalog, patchHashesOf } from "../../../core/patch.js";
import { JobManager } from "../../../core/job-manager.js";
import { resolveRefs } from "../../../core/ref-resolver.js";
import { collectUndecidedUpstreamTakes } from "../../../core/staleness.js";
import { holdsHumanVerdict } from "../../../core/accept-cascade.js";
import { buildAddressInfo, isProblemAddress } from "../../../core/status-sections.js";
import { StateManager } from "../../../core/state/index.js";
import type { AssetDefinition, BackendKind, JobRecord } from "../../../core/types/index.js";
import { getBackendKind } from "../../../backends/resolve-backend.js";
import {
  assertAnimaticConsumed,
  assertUpstreamAccepted,
  gateDirectionForStage,
  gateStageChecks,
  loadStageDefinitions,
} from "../../load-definition.js";
import { capList, printCapped } from "../../format-list.js";
import { TURBO_TAKE_NOTE, turboTakes } from "../../turbo-takes.js";
import { confirmAction, printAborted } from "../../confirm.js";
import { parsePositiveInt } from "../../parse-option.js";
import {
  type AssetResult,
  createPendingJobs,
  ensureComfyModelJobs,
  ensureComfyNodeJobs,
  formatComfyDownloadNotice,
  formatUndecidedUpstreamTakesNotice,
  preflightComfyAssets,
  submitAssetJobs,
} from "../../generate-orchestrator.js";
import { requireVideoRoots } from "../../context.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { computeDefinitionHash } from "../../../core/definition-hash.js";

export function registerRerollCommand(program: Command): void {
  program
    .command("reroll [targets...]")
    .description("Generate new variants for named assets, an address-scope, or every failed target")
    .option("--count <n>", "Number of variants to generate per asset", "1")
    .option("--failed", "Only targets whose takes are all dead or failed")
    .option(
      "--with-dependents",
      "Also rebuild every same-stage asset that depends on each one, stopping at an accepted take",
    )
    .option("-y, --yes", "Skip the unaccept confirmation prompt")
    .option("--no", "Abort without prompting (treat confirmation as 'no')")
    .option("-v, --verbose", "List every affected asset instead of capping")
    .addHelpText(
      "after",
      `
A target is either an address (one asset) or an address-scope that sweeps every
rerollable asset under it — a stage, a shot, the timeline, the plate roster. Naming an
asset that cannot be rerolled (a file, a deterministic op, a composition or stem) is
an error; the same asset reached through a scope is skipped in silence, as is one no
deliverable consumes and one holding an accepted take. --failed narrows to what
\`konte status\` reports under Problems (every take dead or failed, nothing accepted
or ready behind it) and may be passed
alone to sweep the whole video. A sweep prices itself and asks before spending, so a
non-TTY run needs --yes. A scope that matched no rerollable asset fails; --failed with
nothing to retry says so and exits 0.

Generates fresh variants for each asset so you can pick among alternatives;
the new variants are never auto-accepted. If a named asset already has an accepted
variant, that accept is dropped (so the reroll — not the old take — becomes what
ref/preview/downstream resolve) after confirmation: a TTY prompts, a non-TTY run needs
--yes to proceed or --no to abort. --yes still prints what it unaccepts. Multiple
addresses may span different stages — they are grouped and processed together in
dependency order,
and if one listed asset is an upstream of another, the downstream builds on the
freshly generated variant. With --with-dependents it also cascades: each asset plus
every same-stage asset that transitively depends on it are rebuilt in dependency
order, each downstream variant pinned to the freshly generated upstream (so it builds
on the new variant even if an older one is still accepted). The cascade stops at a
dependent holding an accepted generation or patch take: that take, and whatever is
reached only through it, is left as it is. Cross-stage dependents are
not auto-collected — list them explicitly, or regenerate a downstream stage with
\`konte generate\` after reviewing this one. --with-dependents cannot be combined with
--count > 1 (exploring alternatives is a leaf concern, orthogonal to an upstream cascade).

A deterministic asset (a \`local\` op) is refused: the same inputs give the same output,
so there is no alternative to pick, and \`konte generate <stage>\` re-bakes it once one
moves. A composition or stem is refused too — its accept materializes it.

A reroll that came out worse is undone with \`konte dismiss <variantId>\`: a dismissed
take never resolves, so the address falls back to the take before it, undecided and
undeleted.

Examples:
  konte reroll animatic:shot.01.first --count 3   3 alternatives of one panel
  konte reroll animatic:shot.03.frame animatic:shot.05.frame   reroll both
  konte reroll animatic:shot.01.first --with-dependents   rebuild it and shot.01.last
  konte reroll animatic --yes                     every unaccepted rerollable asset of the board
  konte reroll video:shot.05 --yes                every unaccepted asset of one shot
  konte reroll --failed --yes                     retry every target status calls a problem`,
    )
    .action(
      async (
        targets: string[],
        opts: {
          count: string;
          failed?: boolean;
          withDependents?: boolean;
          yes?: boolean;
          no?: boolean;
          verbose?: boolean;
        },
      ) => {
        const roots = requireVideoRoots();
        const videoRoot = roots.video;
        const uniqueTargets = [...new Set(targets)];

        if (uniqueTargets.length === 0 && !opts.failed) {
          throw new KonteError(
            "INVALID_OPTION",
            "Nothing to reroll: name at least one address or address-scope, or pass --failed",
          );
        }

        // Delivery targets are synthesized at export time: their upscale definition and the
        // resolved source video are wired by `planDelivery`, not by reroll. Rerolling one
        // would run the source asset's definition with an unresolved upstream, so reject early.
        // Read off the typed string, before anything is expanded: these two messages name the
        // command that does own the address, which a "nothing matched" sweep result would not.
        for (const address of uniqueTargets) {
          if (isDeliveryAddress(address)) {
            throw new KonteError(
              "DELIVERY_NOT_REROLLABLE",
              `Cannot reroll "${address}": delivery targets are produced by \`konte export\``,
            );
          }
          if (isMaterializedLeafAddress(address)) {
            throw new KonteError(
              "INVALID_ASSET_TYPE",
              `Cannot reroll "${address}": composition/stem targets are materialized from their inputs, not generated`,
            );
          }
        }

        const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
        await applyResolutionDefinitions({
          videoRoot,
          definitions: { video, animatic, reference },
        });
        const variantCount = parsePositiveInt(opts.count, "--count");

        if (opts.withDependents && variantCount > 1) {
          throw new KonteError(
            "INVALID_OPTION",
            "`--count` cannot be combined with `--with-dependents`: exploring multiple " +
              "alternatives is a leaf concern, orthogonal to rebuilding a dependency chain",
          );
        }

        const stageEntries = [
          ["reference", reference],
          ["animatic", animatic],
          ["video", video],
        ] as const satisfies ReadonlyArray<readonly [AssetStage, DefinitionLike]>;
        const definitionByStage = new Map<Stage, DefinitionLike>(stageEntries);
        const definitionForAddress = (address: string): DefinitionLike => {
          const definition = definitionByStage.get(getStage(address));
          if (!definition) {
            throw new KonteError(
              "INVALID_ADDRESS",
              `Address "${address}" references the direction stage, which is feedback-only with no asset definition`,
            );
          }
          return definition;
        };

        const graph = buildDependencyGraph(video, animatic, reference);

        // Every declared asset of the video, so a scope sweep reads one list rather than one per
        // stage — a scope may name a stage, but `--failed` alone names none.
        const declared = new Map<string, AssetStage>();
        for (const [stage, definition] of stageEntries) {
          for (const assetPath of listAssetPaths(definition, stage)) declared.set(assetPath, stage);
        }
        // Spending on an asset no deliverable consumes is waste whichever command asks for it, so a
        // sweep drops those exactly as `generate` does. A named one still rerolls: whoever typed
        // its address is looking at it.
        const unused = new Set(listUnusedAssetPaths(video, animatic, graph, reference));
        // What a sweep may spend on. A named asset failing any of these gets the message saying
        // which (below); reached through a scope it was never what was asked for, so it is dropped.
        // A human's accept is replaced only when its address is named.
        const isSweepable = (assetPath: string): boolean => {
          if (unused.has(assetPath)) return false;
          if (holdsHumanVerdict(manager, assetPath)) return false;
          if (isDeliveryAddress(assetPath) || isMaterializedLeafAddress(assetPath)) return false;
          const assetDef = getAssetEntry(definitionForAddress(assetPath), assetPath);
          return (
            assetDef.kind !== "file" &&
            assetDef.deterministic !== true &&
            getBackendKind(assetDef) !== null
          );
        };

        // A target naming one asset parses as an address; everything else is a scope. The split is
        // structural rather than a lookup in `declared`, so a typo in the name slot still reaches
        // `validateAddress` and is told which asset does not exist, instead of sweeping to nothing.
        const namedAddresses = uniqueTargets.filter((t) => tryParseAddress(t) !== null);
        const scopeTargets = uniqueTargets.filter((t) => tryParseAddress(t) === null);
        for (const scope of scopeTargets) {
          assertValidAddressScope(scope);
          if (scope === "direction" || scope.startsWith("direction:")) {
            throw new KonteError(
              "INVALID_ADDRESS",
              `Cannot reroll "${scope}": the direction is feedback-only and declares no generated asset`,
            );
          }
        }

        // A named address answers for itself before anything narrows the run: whichever filter would
        // drop it later, naming an asset reroll cannot produce is an error, not a quiet no-op.
        for (const address of namedAddresses) {
          const definition = definitionForAddress(address);
          validateAddress(address, definition);
          const assetDef = getAssetEntry(definition, address);
          if (assetDef.kind === "file") {
            throw new KonteError(
              "INVALID_ASSET_TYPE",
              `Cannot reroll "${address}": file assets cannot be rerolled`,
            );
          }
          // A deterministic asset gives the same output for the same inputs, so there is no
          // alternative to pick — reroll's whole purpose. Named addresses
          // only: a deterministic dependent collected by --with-dependents is how a cascade
          // rebuilds, and says nothing about the ask.
          if (assetDef.deterministic === true) {
            throw new KonteError(
              "DETERMINISTIC_NOT_REROLLABLE",
              `Cannot reroll "${address}": a deterministic asset has no alternative take to pick — ` +
                `run \`konte generate ${getStage(address)}\` to re-bake it`,
            );
          }
          if (!getBackendKind(assetDef)) {
            throw new KonteError(
              "INVALID_ASSET_TYPE",
              `Cannot reroll "${address}": asset kind "${assetDef.kind}" has no generation backend`,
            );
          }
        }

        // Persist the file-asset sync under the state lock so it cannot clobber a concurrent watcher
        // write, and read every decision below off the one post-sync snapshot it returns. It runs
        // before the gates rather than after them because `--failed` judges against it: an unsynced
        // read would call an address ready that `status` has already moved to Problems.
        const manager = await StateManager.withLock(videoRoot, async (m) => {
          await syncFileAssets({ reference, animatic, video }, m, { measure: true });
          return m;
        });

        const declaredPaths = [...declared.keys()];
        // `--failed` with no target sweeps the whole video: the retry an agent reaches for after a
        // batch run should not have to name where the failures landed.
        const sweptAddresses: string[] = [];
        if (uniqueTargets.length === 0) {
          sweptAddresses.push(...declaredPaths.filter(isSweepable));
        } else {
          // Judged per scope, not over the union: a run naming two scopes where only one matches has
          // a scope that did nothing, and reporting the union as non-empty would swallow it.
          for (const scope of scopeTargets) {
            const matched = declaredPaths.filter(
              (assetPath) => matchesAddressScope(assetPath, scope) && isSweepable(assetPath),
            );
            if (matched.length === 0) {
              throw new KonteError(
                "INVALID_ADDRESS",
                `No rerollable asset under "${scope}": every match is a file, a deterministic op, ` +
                  `a materialized leaf, accepted, or consumed by nothing`,
              );
            }
            sweptAddresses.push(...matched);
          }
        }
        const requested = [...new Set([...namedAddresses, ...sweptAddresses])];

        // --failed narrows to what `konte status` reports under Problems, through that section's own
        // predicate and the same inputs — a patch script edited since its output landed ages that
        // take out for both. Applied before the gates below, so a run with nothing to retry says so
        // instead of demanding a stage's direction acceptance first.
        let candidates = requested;
        if (opts.failed) {
          const failedState = manager.getState();
          const allJobs = await new JobManager(videoRoot).listJobs();
          const jobsByVariantId = new Map<string, JobRecord>();
          for (const job of allJobs) {
            if (job.kind === "generation") jobsByVariantId.set(job.variantId, job);
          }
          const jobIndex = new JobIndex(allJobs);
          const patchHashes = patchHashesOf(await loadPatchCatalog(videoRoot, failedState));
          const stalenessCache = manager.stalenessCache();
          candidates = candidates.filter((address) => {
            const assetDef = getAssetEntry(definitionForAddress(address), address);
            return isProblemAddress(
              buildAddressInfo(
                address,
                failedState,
                jobsByVariantId,
                assetDef.kind,
                computeDefinitionHash(assetDef),
                jobIndex,
                false,
                undefined,
                false,
                null,
                patchHashes,
                stalenessCache,
              ),
            );
          });
        }

        if (candidates.length === 0) {
          // Only reachable under --failed (a sweep that matched nothing already threw): no failure
          // to retry is the answer a retry loop asked for, so it is a clean exit with the reason on
          // stdout rather than a silent no-op.
          console.log(
            "Nothing to reroll: no target has a dead or failed take — run `konte status`",
          );
          return;
        }

        type Primary = {
          address: string;
          assetPath: string;
          def: AssetDefinition;
          stage: Stage;
          definition: DefinitionLike;
          deps: string[];
        };
        // Every refusal a named address owes was answered above, and a swept one passed
        // `isSweepable`, so what reaches here is work.
        const primaries: Primary[] = [];
        for (const address of candidates) {
          const definition = definitionForAddress(address);
          const stage = getStage(address);
          const assetDef = getAssetEntry(definition, address);
          primaries.push({
            address,
            assetPath: address,
            def: assetDef,
            stage,
            definition,
            deps: [...(graph.dependencies.get(address) ?? [])],
          });
        }

        // reroll spends like generate (it can produce a declared asset from scratch), so it passes
        // through the same direction gate — closing the "reroll one shot at a time" bypass. Gate
        // once per distinct stage the addresses touch.
        for (const stage of new Set(primaries.map((p) => p.stage))) {
          const definition = definitionByStage.get(stage);
          await gateDirectionForStage({
            videoRoot,
            command: "reroll",
            stage,
            realizedIds: stage === "reference" ? undefined : definition?.shots.map((s) => s.id),
          });
          if (definition) await gateStageChecks(definition, stage);
        }

        // Combined work list, keyed by address so overlapping cascades (or an address that is
        // another's dependent) collapse to one item. Primaries are seeded first, so a listed
        // address always wins over a merely-collected dependent (it keeps its --count). With
        // --with-dependents, every same-stage asset that transitively depends on a primary is
        // added, up to a dependent holding a human verdict. Cross-stage dependents are excluded on purpose — a downstream stage is
        // regenerated through its own review cycle once this one is accepted, unless the user
        // lists it explicitly. Compositions carry no backend job (the watcher materializes them)
        // and file assets can't be rerolled, so both are skipped.
        type WorkItem = {
          address: string;
          assetPath: string;
          def: AssetDefinition;
          deps: string[];
          stage: Stage;
          definition: DefinitionLike;
          isPrimary: boolean;
        };
        const workItemByAddress = new Map<string, WorkItem>();
        for (const p of primaries) {
          workItemByAddress.set(p.address, { ...p, isPrimary: true });
        }
        if (opts.withDependents) {
          for (const p of primaries) {
            for (const { assetPath, def } of collectRerollCascade(
              graph,
              p.assetPath,
              p.definition,
              (dependent) => holdsHumanVerdict(manager, dependent),
            )) {
              if (workItemByAddress.has(assetPath)) continue;
              workItemByAddress.set(assetPath, {
                address: assetPath,
                assetPath,
                def,
                deps: [...(graph.dependencies.get(assetPath) ?? [])],
                stage: p.stage,
                definition: p.definition,
                isPrimary: false,
              });
            }
          }
        }

        // Process upstreams before downstreams so a downstream item can pin to a fresh upstream
        // produced earlier in this run.
        const topoIndex = new Map<string, number>();
        graph.topologicalOrder.forEach((p, i) => topoIndex.set(p, i));
        const workItems = [...workItemByAddress.values()].sort(
          (a, b) => (topoIndex.get(a.assetPath) ?? 0) - (topoIndex.get(b.assetPath) ?? 0),
        );

        // reroll spends like generate, so its creative-stage items pass the same upstream-acceptance
        // gate: the board a take builds on and the sheets it conditions on are reviewed before the
        // take is redone. The `reference` stage is exempt: rerolling a sheet is how it gets to
        // review in the first place.
        for (const stage of ["animatic", "video"] as const) {
          const assetPaths = workItems.filter((w) => w.stage === stage).map((w) => w.assetPath);
          if (assetPaths.length === 0) continue;
          assertUpstreamAccepted({ manager, graph, assetPaths, stage, animatic });
        }
        // Same reason, one level out: a video take rerolled off a shot that consumes no board never
        // meets the gate above. Asked of what this run spends on, not of the definition, which may
        // pass over the asset being redone. A timeline asset belongs to no one shot, so there the
        // whole definition answers.
        const vendorVideo = workItems.filter(
          (w) => w.stage === "video" && isVendorBackendAsset(w.def.kind),
        );
        if (vendorVideo.length > 0) {
          const shotIds = vendorVideo
            .map((w) => tryParseAddress(w.assetPath))
            .flatMap((parsed) => (parsed?.kind === "shot" ? [parsed.shotId] : []));
          const timelineSpend = shotIds.length < vendorVideo.length;
          assertAnimaticConsumed({
            video,
            animatic,
            graph,
            ...(timelineSpend ? {} : { spendingShotIds: shotIds }),
          });
        }

        // A dependency this run rerolls, or one another run is still generating, is waited on as
        // `generate` waits on it: the job pends until the upstream lands. Every other dependency must
        // resolve now, and is refused here, before any job exists — a refusal mid-submit would leave
        // the jobs created ahead of it spent, unreported and still hidden behind their old accepts.
        const jobManager = new JobManager(videoRoot);
        const jobIndex = new JobIndex(await jobManager.listJobs());
        const awaitsDep = (dep: string): boolean =>
          workItemByAddress.has(dep) || jobIndex.hasActiveJobFor(dep);
        const unresolvedDeps: string[] = [];
        for (const w of workItems) {
          for (const dep of w.deps) {
            if (awaitsDep(dep)) continue;
            try {
              resolveRefs([dep], manager);
            } catch (err) {
              if (!(err instanceof KonteError) || err.code !== "DEPENDENCY_NOT_RESOLVED") throw err;
              unresolvedDeps.push(
                `  ${w.address} — ${dep}: run \`konte generate ${getStage(dep)}\` first`,
              );
            }
          }
        }
        if (unresolvedDeps.length > 0) {
          throw new KonteError(
            "DEPENDENCY_NOT_RESOLVED",
            `${unresolvedDeps.length} dependency(ies) have no ready asset and no job generating them:\n` +
              unresolvedDeps.join("\n"),
          );
        }

        // A reroll is "redo this, I want to review the new take". While the old variant stays
        // accepted it keeps winning resolution (ref, preview, downstream), hiding the reroll — so
        // this run drops the accept on every asset it regenerates. That is a state change, so
        // confirm up front, before any spend: a TTY prompts, a non-TTY run must pass --yes (or
        // --no to abort). Nothing accepted → nothing to confirm. The unaccept itself lands after
        // the jobs are created (below), so a preflight/submit failure leaves the accept untouched.
        const acceptedByAddress = new Map<string, string>();
        for (const w of workItems) {
          const variantId = manager.getAcceptedVariant(w.address);
          if (variantId) acceptedByAddress.set(w.address, variantId);
        }
        const hasAcceptedTarget = acceptedByAddress.size > 0;
        const decided = [...acceptedByAddress.keys()];
        const capped = (addresses: string[]): string => {
          const { shown, hidden } = capList(addresses, { verbose: opts.verbose });
          return hidden > 0 ? `${shown.join(", ")} (+${hidden} more)` : shown.join(", ");
        };
        // A sweep is priced before it runs: `konte reroll video` can be a hundred jobs, and whoever
        // typed a stage name enumerated none of them. A named address is its own enumeration, so it
        // still prompts only for the accept it would drop.
        const promptLines: string[] = [];
        if (scopeTargets.length > 0 || uniqueTargets.length === 0) {
          const takeCount = workItems.reduce((n, w) => n + (w.isPrimary ? variantCount : 1), 0);
          promptLines.push(
            `${takeCount} take(s) will be generated across ${workItems.length} asset(s): ${capped(workItems.map((w) => w.address))}.`,
          );
        }
        if (decided.length > 0) {
          promptLines.push(
            `${decided.length} accepted variant(s) will be unaccepted so the new take becomes the reviewed one: ${capped(decided)}.`,
          );
        }
        if (promptLines.length > 0) {
          // --yes waives the question, not the disclosure.
          if (opts.yes) console.log(promptLines.join("\n"));
          const proceed = await confirmAction(`${promptLines.join("\n")}\nContinue?`, {
            yes: opts.yes,
            no: opts.no,
          });
          if (!proceed) {
            printAborted();
            return;
          }
        }

        const config = await loadKonteConfig(roots.workspace);
        // The spend gate, before a variant id is reserved or a job written.
        assertSpendAllowed(
          workItems.map((w) => ({ label: w.address, kind: w.def.kind })),
          config,
        );
        // Resolve which declared comfy models/nodes are missing once across the whole work list,
        // then gate each comfy asset's job on its own subset — exactly as generate does. Missing
        // ones make that asset pending until they install.
        const { missingModels, missingNodes, comfyDownloads } = await preflightComfyAssets(
          roots,
          workItems.filter((w) => w.def.kind === "comfy"),
          config,
        );

        const backendCache = new Map<BackendKind, GenerationBackend>();

        // Variant id (== job id) of each work item we just (re)created, keyed by its address so a
        // downstream item (possibly in another stage) can both wait on and pin to the new
        // upstream variant. Only single-variant items are recorded — a --count>1 item has no one
        // variant to pin, so its downstreams resolve normally.
        const newVariantByAddress = new Map<string, string>();
        const jobRows: Array<{ address: string; variantId: string; status: string }> = [];
        // A submit that failed synchronously (submitAssetJobs returns status "failed" with the
        // backend error). Collected so the run reports it and exits non-zero — mirroring generate
        // — instead of dropping the error and exiting 0.
        const failures: Array<{ address: string; error: string }> = [];
        // An address this run produced no live take for — every submit failed, or a dependency did.
        const deadAddresses = new Set<string>();

        for (const w of workItems) {
          const wBackendKind = getBackendKind(w.def);
          if (!wBackendKind) continue;

          if (w.deps.some((d) => deadAddresses.has(d))) {
            deadAddresses.add(w.address);
            failures.push({ address: w.address, error: "Dependency failed" });
            continue;
          }

          const modelJobIds = await ensureComfyModelJobs(w.def, jobManager, missingModels);
          const nodeJobIds = await ensureComfyNodeJobs(w.def, jobManager, missingNodes);
          const prereqJobIds = [...modelJobIds, ...nodeJobIds];

          // Upstreams within this run: wait on their new jobs and pin to their new variants so
          // this item builds on the fresh upstream, not an older accepted one.
          const upstreamJobIds: string[] = [];
          const pinnedDeps: Record<string, string> = {};
          for (const d of w.deps) {
            const vid = newVariantByAddress.get(d);
            if (vid === undefined) continue;
            upstreamJobIds.push(vid);
            pinnedDeps[d] = vid;
          }

          const count = w.isPrimary ? variantCount : 1;
          let result: AssetResult;
          if (prereqJobIds.length > 0 || w.deps.some(awaitsDep)) {
            result = await createPendingJobs(
              w.address,
              w.def,
              w.deps,
              count,
              videoRoot,
              jobManager,
              [...prereqJobIds, ...upstreamJobIds],
              pinnedDeps,
            );
          } else {
            const resolvedDeps = resolveRefs(w.deps, manager, {});
            result = await submitAssetJobs(
              w.address,
              w.def,
              count,
              roots,
              jobManager,
              backendCache,
              resolvedDeps,
            );
          }

          for (const j of result.jobs) jobRows.push({ address: w.address, ...j });
          if (result.status === "failed") {
            failures.push({ address: w.address, error: result.error ?? "generation failed" });
            if (result.jobs.every((j) => j.status === "failed")) deadAddresses.add(w.address);
          }
          if (result.jobs.length === 1) {
            newVariantByAddress.set(w.address, result.jobs[0]!.variantId);
          }
        }

        // The jobs now exist, so drop the accept the user confirmed on: each regenerated asset's
        // fresh variant becomes what resolution picks. Read the accepted variant under the lock —
        // not the pre-submit snapshot — so a variant a concurrent accept moved to can't make
        // setUnaccepted throw, and a newly-accepted target is caught too. Guarded by the up-front
        // consent, and deferred to here so a preflight/submit throw above never clears an accept
        // without producing the reroll. An asset whose submit failed synchronously produced no
        // reroll, so it keeps its accept (its old variant stays both accepted and resolved).
        const unaccepted: string[] = [];
        if (hasAcceptedTarget) {
          const failedAddresses = new Set(failures.map((f) => f.address));
          await StateManager.withLock(videoRoot, async (m) => {
            for (const w of workItems) {
              if (failedAddresses.has(w.address)) continue;
              const vid = m.getAcceptedVariant(w.address);
              if (!vid) continue;
              m.setUnaccepted(w.address, vid);
              unaccepted.push(w.address);
            }
          });
        }

        // Heads-up: an upstream of a rerolled target has an undecided take that this reroll
        // won't use — it resolves the accepted variant. Skip deps that were regenerated in this
        // run (their downstreams pin to the fresh variant), and dedup across targets by address.
        const undecidedUpstreamTakes: ReturnType<typeof collectUndecidedUpstreamTakes> = [];
        const seenTake = new Set<string>();
        for (const p of primaries) {
          const remainingDeps = p.deps.filter((d) => !newVariantByAddress.has(d));
          const takes = collectUndecidedUpstreamTakes(
            manager.getState(),
            remainingDeps,
            manager.stalenessCache(),
          );
          for (const t of takes) {
            if (seenTake.has(t.address)) continue;
            seenTake.add(t.address);
            undecidedUpstreamTakes.push(t);
          }
        }

        const takesNotice = formatUndecidedUpstreamTakesNotice(undecidedUpstreamTakes);
        if (takesNotice) console.warn(`${takesNotice}\n`);
        const noticeText = formatComfyDownloadNotice(comfyDownloads);
        if (noticeText) console.log(`${noticeText}\n`);
        const onTurbo = new Set((await turboTakes(videoRoot, jobRows)).map((r) => r.variantId));
        for (const row of jobRows) {
          const turbo = onTurbo.has(row.variantId) ? " (turbo)" : "";
          console.log(`  ${row.address}: ${row.status} → ${row.variantId}${turbo}`);
        }
        if (onTurbo.size > 0) console.log(`\nturbo — ${TURBO_TAKE_NOTE}`);
        if (failures.length > 0) {
          console.log("\nFailed:");
          printCapped(failures, (f) => `${f.address}  ${f.error}`, { verbose: opts.verbose });
        }
        // The outcome and the one command that answers it share the last line, so a caller
        // piping through `tail -1` keeps both.
        const assetCount = new Set(jobRows.map((r) => r.address)).size;
        const parts = [
          `${jobRows.length} take(s) across ${assetCount} asset(s)`,
          comfyDownloads.models.length > 0 || comfyDownloads.nodes.length > 0
            ? `${comfyDownloads.models.length} model(s), ${comfyDownloads.nodes.length} custom node(s) to install first`
            : null,
          failures.length > 0 ? `${failures.length} failed` : null,
        ].filter((part) => part !== null);
        const next = jobRows.length > 0 ? "run `konte job wait`" : "run `konte status`";
        console.log(`\n${parts.join(", ")} — ${next}`);

        if (failures.length > 0) process.exitCode = 1;
      },
    );
}
