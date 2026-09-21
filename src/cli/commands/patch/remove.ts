import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { JobManager } from "../../../core/job-manager.js";
import {
  activeGenerationVariantIds,
  patchChainTargets,
  patchFilePath,
} from "../../../core/patch.js";
import { StateManager } from "../../../core/state/index.js";
import { patchChainDir, variantDir } from "../../../core/variant-dir.js";
import { addressToCacheSegments, getAssetStage } from "../../../core/address.js";
import { collectDescendants } from "../../../core/variant-lineage.js";
import { confirmDeletion, printAborted } from "../../confirm.js";
import { requireVideoRoots } from "../../context.js";
import { getPathSize, removePathSafely } from "../clean-utils.js";
import { prerollVariantDir } from "../../../core/preview-preroll.js";

// Everything on disk keyed by one variant, the patch script included. A patch's output cannot be
// patched (`assertPatchableTarget` refuses to scaffold one and refuses to load one), but nothing
// stops a file being written at that name by hand — and it names a take about to stop existing.
function variantPaths(videoRoot: string, address: string, vid: string): string[] {
  return [
    variantDir(videoRoot, address, vid),
    path.join(videoRoot, ".konte", "logs", `${vid}.log`),
    path.join(videoRoot, ".konte", "cache", "thumbnails", ...addressToCacheSegments(address), vid),
    path.join(videoRoot, ".konte", "cache", "audio", vid),
    path.join(videoRoot, ".konte", "cache", "motion", vid),
    prerollVariantDir(videoRoot, vid),
    patchFilePath(videoRoot, vid),
  ];
}

export function registerPatchRemoveCommand(parent: Command): void {
  parent
    .command("remove <variantId>")
    .description("Delete a patch script and every variant it produced")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--no", "Abort without prompting (treat confirmation as 'no')")
    .addHelpText(
      "after",
      `
Rejects a patch for good: removes patches/<variantId>.ts along with the variants it produced, which
makes the original a review candidate again. Its accept, if it had one, simply stands. Accepting the
original beside the correction settles the review too — that dismisses the correction — but leaves
the script on disk, so it only sets the correction aside. This drops it.

Examples:
  konte patch remove v-a1b2c3        drop that patch and its outputs
  konte patch remove v-a1b2c3 -y     without the prompt`,
    )
    .action(async (variantIdArg: string, opts: { yes?: boolean; no?: boolean }) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      const filePath = patchFilePath(videoRoot, variantIdArg);

      try {
        await fs.access(filePath);
      } catch {
        throw new KonteError(
          "PATCH_NOT_FOUND",
          `No patch script for variant "${variantIdArg}" (expected ${filePath})`,
        );
      }

      const manager = await StateManager.load(videoRoot);
      const state = manager.getState();
      const address = manager.findVariantAddress(variantIdArg);

      // Only the outputs of THIS patch. A sibling reroll of the same address is not part of the
      // lineage and is left alone.
      const doomed = address ? collectDescendants(state, address, variantIdArg) : [];
      // …and everything the chain itself generated. Its addresses are derived from the source
      // variant id, never by loading the script: a syntactically broken patch must still be
      // removable, and it is what declares these.
      const stepTargets = patchChainTargets(state, variantIdArg);

      // Deleting a variant whose job is still running would strand the backend job and let the
      // waiter re-create the state row after this command reports it gone — for a step, it would
      // also let that job materialize a patched variant for a patch that no longer exists.
      const jobManager = new JobManager(videoRoot);
      const active = activeGenerationVariantIds(await jobManager.listJobs());
      const blocked = [...doomed, ...stepTargets.map((t) => t.variantId)].filter((vid) =>
        active.has(vid),
      );
      if (blocked.length > 0) {
        throw new KonteError(
          "JOB_NOT_CANCELLABLE",
          `Cannot remove this patch while it is still generating: ${blocked.join(", ")} — cancel with \`konte job cancel\` first, or wait for it to settle`,
        );
      }

      const paths = [filePath];
      if (address) {
        for (const vid of doomed) paths.push(...variantPaths(videoRoot, address, vid));
      }
      for (const t of stepTargets) paths.push(...variantPaths(videoRoot, t.address, t.variantId));
      // The chain's own directory, not each step's: it holds exactly this patch's steps, so one
      // path covers them all — including a step whose state row is already gone.
      if (address) paths.push(patchChainDir(videoRoot, getAssetStage(address), variantIdArg));

      let bytes = 0;
      for (const p of paths) bytes += await getPathSize(p);
      const subjects = [`the patch script ${filePath}`];
      if (doomed.length > 0) {
        subjects.push(`${doomed.length} variant(s) it produced (${doomed.join(", ")})`);
      }
      const proceed = await confirmDeletion({
        subjects,
        totalSize: bytes,
        yes: opts.yes,
        no: opts.no,
      });
      if (!proceed) {
        printAborted();
        return;
      }

      // Re-derive the lineage under the lock: a patch applied between the prompt and now would
      // otherwise survive its source's removal with a dangling `derivedFrom`. The active-job
      // check is repeated here on a fresh listing for the same reason — a child reserved since
      // the first check must not be deleted out from under its running job. Throwing before
      // `save()` leaves state untouched, so an abort here removes nothing.
      const removedVariants: string[] = [];
      await StateManager.withLock(videoRoot, async (m) => {
        const lineage = address ? collectDescendants(m.getState(), address, variantIdArg) : [];
        const steps = patchChainTargets(m.getState(), variantIdArg);
        const stillActive = activeGenerationVariantIds(await jobManager.listJobs());
        const running = [...lineage, ...steps.map((t) => t.variantId)].filter((vid) =>
          stillActive.has(vid),
        );
        if (running.length > 0) {
          throw new KonteError(
            "JOB_NOT_CANCELLABLE",
            `A job for this patch started while removing it: ${running.join(", ")} — cancel it with \`konte job cancel\` first, or wait for it to settle`,
          );
        }
        if (address) {
          for (const vid of lineage) {
            m.removeVariant(address, vid);
            removedVariants.push(vid);
            // Reserved since the pre-flight listing, so its paths were not collected then.
            if (!doomed.includes(vid)) paths.push(...variantPaths(videoRoot, address, vid));
          }
        }
        for (const t of steps) {
          m.removeVariant(t.address, t.variantId);
          removedVariants.push(t.variantId);
          paths.push(...variantPaths(videoRoot, t.address, t.variantId));
        }
      });
      for (const p of paths) await removePathSafely(p);
      for (const vid of removedVariants) await jobManager.deleteJob(vid);

      console.log(`Removed ${filePath}`);
      for (const vid of removedVariants) console.log(`  removed variant ${vid}`);
    });
}
