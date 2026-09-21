import type { Command } from "commander";
import type { GenerationBackend } from "../../../core/backend.js";
import { loadKonteConfig } from "../../../core/config.js";
import { JobManager } from "../../../core/job-manager.js";
import {
  activeGenerationVariantIds,
  findPendingPatches,
  loadPatchCatalog,
  patchHashesOf,
  requirePatch,
} from "../../../core/patch.js";
import { StateManager } from "../../../core/state/index.js";
import { syncFileAssets } from "../../../core/file-sync.js";
import type { BackendKind } from "../../../core/types/index.js";
import { requireVideoRoots } from "../../context.js";
import { getStage, isPatchAddress, tryParseAddress } from "../../../core/address.js";
import { isVendorBackendAsset } from "../../../core/backend-policy.js";
import { buildDependencyGraph, extractRefs } from "../../../core/graph.js";
import {
  assertAnimaticConsumed,
  assertUpstreamAccepted,
  gateDirectionForStage,
  loadDefinitionForAddress,
  loadStageDefinitions,
} from "../../load-definition.js";
import { assertPinGate } from "../../../core/pin-check.js";
import { assertPromptGate } from "../../../core/prompt-check.js";
import { applyPatch, assertPatchSpendAllowed } from "../../patch-orchestrator.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { errorMessage } from "../../../core/errors.js";

export function registerPatchApplyCommand(parent: Command): void {
  parent
    .command("apply [variantId]")
    .description("Run a patch script over its variant, producing a corrected variant")
    .addHelpText(
      "after",
      `
Runs patches/<variantId>.ts with that exact take pinned as its source, producing a NEW variant at
the same address that points back at it. The original is left untouched, so a patch can be re-run
after editing its prompt and always builds on the same image. Every output is kept: re-applying
adds a take beside the previous one. The newest is the shown one, and an output the current script
no longer describes is marked stale in review. With no argument, applies every patch that currently
has no up-to-date output — the same set \`konte generate\` picks up.

Examples:
  konte patch apply v-a1b2c3   apply that one patch
  konte patch apply            apply every patch with no current output`,
    )
    .action(async (variantIdArg: string | undefined) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      let manager = await StateManager.load(videoRoot);
      const catalog = await loadPatchCatalog(
        videoRoot,
        manager.getState(),
        manager.absentVariantIds(),
      );
      // Before anything resolves. The catalog IS the patch axis, so it is handed over rather than
      // imported a second time.
      await applyResolutionDefinitions({ videoRoot, patchHashes: patchHashesOf(catalog) });

      const jobManager = new JobManager(videoRoot);
      const targets = variantIdArg
        ? [requirePatch(catalog, variantIdArg)]
        : findPendingPatches(
            manager.getState(),
            catalog,
            activeGenerationVariantIds(await jobManager.listJobs()),
            manager.stalenessCache(),
          );

      // A script that failed to load is a failure of this run, not a footnote: the correction the
      // author wrote is not going to happen, so it belongs in `failures` and in the exit code.
      // (Only on the sweep — a named target's load error already threw out of `requirePatch`.)
      const failures: Array<{ source: string; error: string }> = variantIdArg
        ? []
        : catalog.errors.map((e) => ({
            source: e.sourceVariantId,
            error: `${e.filePath}: ${e.message}`,
          }));

      if (targets.length === 0 && failures.length === 0) {
        console.log("No patches to apply");
        return;
      }

      // A patch spends, so it passes the same gates generate does — the direction gate once per
      // stage the targets touch, and the vendor allowlist per patch definition.
      const config = await loadKonteConfig(roots.workspace);
      for (const patch of targets) assertPatchSpendAllowed(patch, config);
      // A correction's own prompts and pins, gated like a stage's. A patch declares no waivers of
      // its own.
      for (const patch of targets) {
        assertPromptGate(patch, `patches/${patch.sourceVariantId}.ts`);
        assertPinGate(patch, `patches/${patch.sourceVariantId}.ts`);
      }
      for (const stage of new Set(targets.map((p) => getStage(p.sourceAddress)))) {
        const definition =
          stage === "reference"
            ? null
            : await loadDefinitionForAddress(
                videoRoot,
                targets.find((p) => getStage(p.sourceAddress) === stage)!.sourceAddress,
              );
        await gateDirectionForStage({
          videoRoot,
          command: "patch",
          stage,
          realizedIds: definition?.shots.map((s) => s.id),
        });
      }
      // A patch spends on top of its take's upstream, so it passes the same acceptance gate
      // generate does. A patch script resolves its own refs beyond the source take (see applyPatch),
      // and those have no graph node, so they are gated alongside the source address.
      // Creative stages only, for the same reason reroll's gate skips the other one: a `reference`
      // sheet has no reviewed upstream.
      const gatedPatches = targets.filter((p) => {
        const stage = getStage(p.sourceAddress);
        return stage === "animatic" || stage === "video";
      });
      if (gatedPatches.length > 0) {
        const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
        await applyResolutionDefinitions({
          videoRoot,
          definitions: { video, animatic, reference },
          patchHashes: patchHashesOf(catalog),
        });
        // Sync `file` assets under the state lock, as generate and reroll do, before asking what is
        // accepted.
        manager = await StateManager.withLock(videoRoot, async (m) => {
          await syncFileAssets({ reference, animatic, video }, m, { measure: true });
          return m;
        });
        const graph = buildDependencyGraph(video, animatic, reference);
        // A patch spends like a generate, so it meets the same wiring gate. The spend is the patch's
        // own steps, not the definition's: a footage shot the definition calls no spender is one a
        // comfy step still spends on. A timeline source belongs to no one shot, so there the whole
        // definition answers.
        const vendorPatches = gatedPatches.filter(
          (p) =>
            getStage(p.sourceAddress) === "video" &&
            Object.values(p.assets).some((def) => isVendorBackendAsset(def.kind)),
        );
        if (vendorPatches.length > 0) {
          const shotIds = vendorPatches
            .map((p) => tryParseAddress(p.sourceAddress))
            .flatMap((parsed) => (parsed?.kind === "shot" ? [parsed.shotId] : []));
          const timelineSpend = shotIds.length < vendorPatches.length;
          assertAnimaticConsumed({
            video,
            animatic,
            graph,
            ...(timelineSpend ? {} : { spendingShotIds: shotIds }),
          });
        }
        for (const stage of new Set(gatedPatches.map((p) => getStage(p.sourceAddress)))) {
          const staged = gatedPatches.filter((p) => getStage(p.sourceAddress) === stage);
          assertUpstreamAccepted({
            manager,
            graph,
            animatic,
            stage,
            assetPaths: staged.map((p) => p.sourceAddress),
            // A chain's own steps are not upstream work — they are produced by this very
            // application, so they are excluded from the gate.
            extraRefs: staged.flatMap((p) =>
              Object.values(p.assets)
                .flatMap((def) => extractRefs(def))
                .filter((ref) => !isPatchAddress(ref)),
            ),
          });
        }
      }

      const backendCache = new Map<BackendKind, GenerationBackend>();
      const applied: Array<{ variantId: string; address: string; source: string; status: string }> =
        [];

      for (const patch of targets) {
        try {
          const result = await applyPatch(patch, roots, jobManager, backendCache, config);
          for (const job of result.jobs) {
            applied.push({
              variantId: job.variantId,
              // The chain's own address while a step is running, the corrected take's once the
              // patched variant is registered — which is what `result.address` already says.
              address: result.address,
              source: patch.sourceVariantId,
              status: job.status,
            });
          }
          if (result.status === "failed") {
            failures.push({
              source: patch.sourceVariantId,
              error: result.error ?? "generation failed",
            });
          }
        } catch (err) {
          failures.push({
            source: patch.sourceVariantId,
            error: errorMessage(err),
          });
        }
      }

      for (const row of applied) {
        console.log(`  ${row.address}: ${row.status} → ${row.variantId} (patch of ${row.source})`);
      }
      if (failures.length > 0) {
        console.log("\nFailed:");
        for (const f of failures) console.log(`  ${f.source}  ${f.error}`);
      }

      if (failures.length > 0) process.exitCode = 1;
    });
}
