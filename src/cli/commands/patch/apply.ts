import { consumedBoardStems, remakeSettledLeaves } from "../../../core/board-leaves.js";
import { printRemixedBoardStems } from "../../generation-selection.js";
import type { Command } from "commander";
import { loadKonteConfig } from "../../../core/config.js";
import { JobManager } from "../../../core/job-manager.js";
import {
  activeGenerationVariantIds,
  findPendingPatches,
  loadPatchCatalog,
  patchHashesOf,
  requirePatch,
  type LoadedPatch,
  type PatchCatalog,
} from "../../../core/patch.js";
import { StateManager } from "../../../core/state/index.js";
import { syncFileAssets } from "../../../core/file-sync.js";
import { requireVideoRoots } from "../../context.js";
import { getStage, isPatchAddress } from "../../../core/address.js";
import type { SpendRoutes } from "../../../core/backend-policy.js";
import { buildDependencyGraph, extractRefs } from "../../../core/graph.js";
import { loadStageDefinitions } from "../../load-definition.js";
import { loadCheckContext, loadStageDefsTolerant, spendGate } from "../../finding-gates.js";
import { loadReference } from "../../../core/loader.js";
import type { SpendCommand } from "../../../core/finding.js";
import type { VideoRoots } from "../../../core/roots.js";
import type { KonteConfig } from "../../../core/types/index.js";
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
      const manager = await StateManager.load(videoRoot);
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

      const config = await loadKonteConfig(roots.workspace);
      const spends = await gatePatchApply(roots, catalog, targets, config, "patch");

      const applied: Array<{ variantId: string; address: string; source: string; status: string }> =
        [];

      for (const patch of targets) {
        try {
          const result = await applyPatch(patch, roots, jobManager, config, spends.get(patch)!);
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

/**
 * The gates a patch spend passes before anything is reserved: the vendor allowlist per chain, then the
 * spend gate per patch — its own prompts and pins, the findings over its stage, and the upstream it
 * builds on.
 */
export async function gatePatchApply(
  roots: VideoRoots,
  catalog: PatchCatalog,
  targets: readonly LoadedPatch[],
  config: KonteConfig,
  command: SpendCommand,
): Promise<Map<LoadedPatch, SpendRoutes>> {
  const videoRoot = roots.video;
  const spends = new Map<LoadedPatch, SpendRoutes>();
  for (const patch of targets) {
    spends.set(patch, await assertPatchSpendAllowed(patch, config, roots.workspace));
  }
  // A reference patch builds on no shot stage, so a shot stage that will not load does not stop it.
  const definitions = targets.some((p) => getStage(p.sourceAddress) !== "reference")
    ? await loadStageDefinitions(videoRoot)
    : { ...(await loadStageDefsTolerant(videoRoot)), reference: await loadReference(videoRoot) };
  const { video, animatic, reference } = definitions;
  await applyResolutionDefinitions({
    videoRoot,
    definitions,
    patchHashes: patchHashesOf(catalog),
  });
  // Sync `file` assets under the state lock, as generate and reroll do, before asking what is
  // accepted.
  let manager = await StateManager.withLock(videoRoot, async (m) => {
    await syncFileAssets({ reference, animatic, video }, m, { measure: true });
    return m;
  });
  const graph = video && animatic ? buildDependencyGraph(video, animatic, reference) : null;
  // The board stems the video patches consume, re-mixed before the gate asks for them accepted.
  const videoPatches = targets.filter((p) => getStage(p.sourceAddress) === "video");
  if (video && animatic && graph && videoPatches.length > 0) {
    const remixed = await remakeSettledLeaves({
      videoRoot,
      stage: animatic,
      counterpart: video,
      addresses: consumedBoardStems(
        graph,
        videoPatches.map((p) => p.sourceAddress),
        videoPatches.flatMap((p) => Object.values(p.assets).flatMap((def) => extractRefs(def))),
      ),
      include: "stems",
    });
    if (remixed.accepted.length > 0) manager = await StateManager.load(videoRoot);
    printRemixedBoardStems(remixed);
  }
  const ctx = await loadCheckContext({
    videoRoot,
    definitions: { reference, animatic, video },
    manager,
    graph,
    patches: targets,
  });
  await spendGate(
    ctx,
    targets.map((patch) => ({
      command,
      stage: getStage(patch.sourceAddress) as "reference" | "animatic" | "video",
      patch: patch.sourceVariantId,
      assetPaths: [patch.sourceAddress],
      targeted: true,
      // A chain's own steps are produced by this very application, so they are not upstream work.
      extraRefs: Object.values(patch.assets)
        .flatMap((def) => extractRefs(def))
        .filter((ref) => !isPatchAddress(ref)),
    })),
  );
  return spends;
}
