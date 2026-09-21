import * as path from "node:path";
import type { Command } from "commander";
import {
  addressToCacheSegments,
  assertValidAddressScope,
  isCompositionAddress,
  matchesAddressScope,
} from "../../core/address.js";
import {
  collectDeadCompositionVariants,
  collectDeadStemVariants,
} from "../../core/composition-resource.js";
import { activeGenerationVariantIds, patchChainTargets, patchFilePath } from "../../core/patch.js";
import { listThumbnailAddressDirs } from "../../core/thumbnail.js";
import { variantDir, variantsHostedBy } from "../../core/variant-dir.js";
import { collectDescendants, isProtectedVariant } from "../../core/variant-lineage.js";
import { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/index.js";
import type { AnimaticDefinition, VideoDefinition } from "../../core/types/index.js";
import { confirmDeletion, printAborted } from "../confirm.js";
import { loadVideoAndAnimatic } from "../load-definition.js";
import {
  type CascadeFailedJob,
  cascadeFailPendingJobs,
  getPathSize,
  removePathSafely,
} from "./clean-utils.js";
import { prerollVariantDir } from "../../core/preview-preroll.js";
import { requireVideoRoot } from "../context.js";

const KONTE_DIR = ".konte";
const CACHE_DIR = "cache";
const LOGS_DIR = "logs";
const THUMBNAILS_DIR = "thumbnails";
const AUDIO_DIR = "audio";
const MOTION_DIR = "motion";

// Why a variant is deletable. Only `unaccepted` holds generated media, and only it is added by
// --delete-unaccepted.
const CLEAN_CATEGORIES = [
  "failed",
  "cancelled",
  "incomplete",
  "dead leftover",
  "unaccepted",
] as const;
type CleanCategory = (typeof CLEAN_CATEGORIES)[number];

const CATEGORY_LABELS: Record<CleanCategory, string> = {
  failed: "failed",
  cancelled: "cancelled",
  incomplete: "incomplete (no media)",
  "dead leftover": "dead leftover",
  unaccepted: "unaccepted (has media)",
};

type CleanedVariant = {
  address: string;
  variantId: string;
  status: string;
  category: CleanCategory;
  deletedPaths: string[];
};

type CleanResult = {
  removed: CleanedVariant[];
  removedCompositionCaches: string[];
  skipped: { address: string; reason: string }[];
};

interface CleanOptions {
  addressScope?: string;
  deleteUnaccepted?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  no?: boolean;
}

function countByCategory(entries: { category: CleanCategory }[]): Record<CleanCategory, number> {
  const counts = Object.fromEntries(CLEAN_CATEGORIES.map((c) => [c, 0])) as Record<
    CleanCategory,
    number
  >;
  for (const entry of entries) counts[entry.category] += 1;
  return counts;
}

async function executeClean(opts: CleanOptions): Promise<void> {
  const videoRoot = requireVideoRoot();
  const manager = await StateManager.load(videoRoot);
  // --delete-unaccepted discards a take whatever its media, so an absent variant goes too — left
  // out, it would be a state row nothing can ever remove once no checkout holds its media.
  const state = opts.deleteUnaccepted ? manager.getRecordedState() : manager.getState();

  type CollectedVariant = {
    address: string;
    variantId: string;
    status: string;
    category: CleanCategory;
    paths: string[];
  };

  if (opts.addressScope) assertValidAddressScope(opts.addressScope);

  const addresses = Object.keys(state.assets);
  const filteredAddresses = opts.addressScope
    ? addresses.filter((addr) => matchesAddressScope(addr, opts.addressScope!))
    : addresses;

  // Dead composition/stem leftovers (unaccepted variants of a leaf that the current definition can
  // no longer materialize — e.g. ghosts from an earlier definition, or the old take left behind
  // when an edited leaf was re-accepted) are pure garbage, so clean always reclaims them, without
  // requiring --all. Best-effort: a broken definition just skips this sweep, leaving the base clean
  // intact.
  let video: VideoDefinition | null = null;
  let animatic: AnimaticDefinition | null = null;
  const deadLeafKeys = new Set<string>();
  try {
    ({ video, animatic } = await loadVideoAndAnimatic(videoRoot));
    // Both composition stages carry leaves, so both leave leftovers behind.
    for (const def of [video, animatic]) {
      if (!def) continue;
      for (const { address, variantId } of [
        ...collectDeadCompositionVariants(manager, def),
        ...collectDeadStemVariants(manager, def),
      ]) {
        deadLeafKeys.add(`${address} ${variantId}`);
      }
    }
  } catch {
    // definition unreadable — skip the leaf sweep
  }

  // Composition thumbnails are a pure render cache — unlike variant thumbnails, nothing reads
  // them via metadata — so clean always reclaims them within scope; the next `probe reel-thumbnails`
  // just re-renders. They carry no state, so enumerate them straight from the filesystem.
  const thumbnailsRoot = path.join(videoRoot, KONTE_DIR, CACHE_DIR, THUMBNAILS_DIR);
  const compositionCaches: string[] = [];
  for (const { address: cacheAddress, dir } of await listThumbnailAddressDirs(thumbnailsRoot)) {
    if (!isCompositionAddress(cacheAddress)) continue;
    if (opts.addressScope && !matchesAddressScope(cacheAddress, opts.addressScope)) continue;
    compositionCaches.push(dir);
  }

  if (opts.addressScope && filteredAddresses.length === 0 && compositionCaches.length === 0) {
    console.warn(`No assets matching "${opts.addressScope}"`);
    process.exitCode = 1;
    return;
  }

  const jobManager = new JobManager(videoRoot);
  const allJobs = await jobManager.listJobs();
  const activeJobVariantIds = new Set(
    allJobs
      .filter(
        (j) =>
          j.kind === "generation" &&
          (j.status === "pending" || j.status === "queued" || j.status === "running"),
      )
      .map((j) => j.id),
  );

  // Pass 1: collect candidates
  const collected: CollectedVariant[] = [];
  const skipped: { address: string; reason: string }[] = [];
  let keptUnaccepted = 0;

  for (const address of filteredAddresses) {
    const target = state.assets[address];
    if (!target) continue;

    for (const [variantId, variant] of Object.entries(target.variants ?? {})) {
      // A variant patched into an accepted one is not itself accepted, yet its file is the patch's
      // input: dropping it would strand the accepted correction with nothing to re-derive from.
      if (isProtectedVariant(state, address, variantId)) {
        if (variant.status !== "accepted") {
          skipped.push({
            address,
            reason: `variant ${variantId} is the source of an accepted patch`,
          });
        }
        continue;
      }

      if (!variant.file && !variant.metadata?.error && !variant.metadata?.cancelledAt) {
        if (activeJobVariantIds.has(variantId)) {
          skipped.push({ address, reason: `variant ${variantId} is generating` });
          continue;
        }
      }

      // A take whose patch is mid-apply: the chain's steps are pinned to this exact variant, and
      // the finalize that follows them reads it, so cutting it now would fail that commit and leave
      // the job unable to settle.
      const applying = patchChainTargets(state, variantId)
        .map((t) => t.variantId)
        .filter((id) => activeJobVariantIds.has(id));
      if (applying.length > 0) {
        skipped.push({
          address,
          reason: `variant ${variantId} has a patch applying (${applying.join(", ")})`,
        });
        continue;
      }

      const isDeadLeaf = deadLeafKeys.has(`${address} ${variantId}`);
      if (!opts.deleteUnaccepted && variant.file && !isDeadLeaf) {
        // Names what was kept, not the flag that would delete it — `--help` carries that.
        skipped.push({
          address,
          reason: `variant ${variantId} is an unaccepted take holding generated media`,
        });
        keptUnaccepted += 1;
        continue;
      }

      const paths: string[] = [];
      paths.push(variantDir(videoRoot, address, variantId));
      // A patch script outlives nothing: it names one take, so it dies with it. Deleting it here
      // (rather than leaving it for `prune`) is what keeps "no orphaned patch" an invariant.
      paths.push(patchFilePath(videoRoot, variantId));
      paths.push(
        path.join(videoRoot, KONTE_DIR, LOGS_DIR, `${variantId}.log`),
        path.join(
          videoRoot,
          KONTE_DIR,
          CACHE_DIR,
          THUMBNAILS_DIR,
          ...addressToCacheSegments(address),
          variantId,
        ),
        path.join(videoRoot, KONTE_DIR, CACHE_DIR, AUDIO_DIR, variantId),
        path.join(videoRoot, KONTE_DIR, CACHE_DIR, MOTION_DIR, variantId),
        prerollVariantDir(videoRoot, variantId),
      );

      const category: CleanCategory = variant.metadata?.error
        ? "failed"
        : variant.metadata?.cancelledAt
          ? "cancelled"
          : isDeadLeaf
            ? "dead leftover"
            : variant.file
              ? "unaccepted"
              : "incomplete";

      collected.push({ address, variantId, status: variant.status, category, paths });
    }
  }

  const collectedKeys = new Set(collected.map((c) => `${c.address} ${c.variantId}`));

  // A variant directory holding another variant's file is not deleted while that other variant
  // survives — a patch chain's returned step hosts the file the patched take points at, so dropping
  // it would leave a take (possibly the accepted one) with no bytes. Deleting both together is
  // fine, which is why this asks about the survivors rather than refusing outright.
  for (const entry of [...collected]) {
    const orphaned = variantsHostedBy(state, entry.address, entry.variantId).filter(
      (ref) => !collectedKeys.has(`${ref.address} ${ref.variantId}`),
    );
    if (orphaned.length === 0) continue;
    collectedKeys.delete(`${entry.address} ${entry.variantId}`);
    collected.splice(collected.indexOf(entry), 1);
    skipped.push({
      address: entry.address,
      reason: `variant ${entry.variantId} holds the file of ${orphaned
        .map((r) => `${r.address} (${r.variantId})`)
        .join(", ")}`,
    });
  }

  // A lineage is deleted as a unit. Anything kept above (accepted, still generating, file-bearing
  // without --all) must keep its ancestors too, or their `derivedFrom` would dangle. Iterate to a
  // fixpoint: dropping a child can in turn rescue its own parent.
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of [...collected]) {
      const key = `${entry.address} ${entry.variantId}`;
      if (!collectedKeys.has(key)) continue;
      const stranded = collectDescendants(state, entry.address, entry.variantId).filter(
        (id) => !collectedKeys.has(`${entry.address} ${id}`),
      );
      if (stranded.length === 0) continue;
      collectedKeys.delete(key);
      collected.splice(collected.indexOf(entry), 1);
      skipped.push({
        address: entry.address,
        reason: `variant ${entry.variantId} is the source of a kept patch (${stranded.join(", ")})`,
      });
      changed = true;
    }
  }

  const categoryCounts = countByCategory(collected);

  // Confirmation is required for the actual deletion: an output format is an
  // output format, not a consent. Skipped only for --dry-run, which deletes nothing. --yes still
  // enters the call — it consents without prompting, but the summary is disclosed. Non-TTY
  // without --yes/--no fails CONFIRMATION_REQUIRED inside confirmAction.
  if ((collected.length > 0 || compositionCaches.length > 0) && !opts.dryRun) {
    let totalSize = 0;
    for (const entry of collected) {
      for (const p of entry.paths) {
        totalSize += await getPathSize(p);
      }
    }
    for (const dir of compositionCaches) {
      totalSize += await getPathSize(dir);
    }
    const subjects: string[] = [];
    if (collected.length > 0) subjects.push(`${collected.length} variant(s)`);
    if (compositionCaches.length > 0)
      subjects.push(`${compositionCaches.length} composition cache(s)`);
    const confirmed = await confirmDeletion({
      subjects,
      totalSize,
      breakdown: CLEAN_CATEGORIES.map((c) => ({
        label: CATEGORY_LABELS[c],
        count: categoryCounts[c],
      })),
      yes: opts.yes,
      no: opts.no,
    });
    if (!confirmed) {
      printAborted();
      return;
    }
  }

  // Pass 2: state mutation inside lock + filesystem deletion
  const result: CleanResult = { removed: [], removedCompositionCaches: [], skipped };

  if (opts.dryRun) {
    for (const entry of collected) {
      result.removed.push({
        address: entry.address,
        variantId: entry.variantId,
        status: entry.status,
        category: entry.category,
        deletedPaths: entry.paths,
      });
    }
    result.removedCompositionCaches = [...compositionCaches];
  } else {
    if (collected.length > 0) {
      const confirmed = await StateManager.withLock(videoRoot, async (mgr) => {
        const freshState = opts.deleteUnaccepted ? mgr.getRecordedState() : mgr.getState();
        const freshActive = activeGenerationVariantIds(await jobManager.listJobs());
        // Re-derive dead composition/stem leftovers under the lock so a concurrent accept that
        // re-materialized one between collection and now is not deleted (a TOCTOU window). The
        // DEFINITIONS are re-read too: the confirmation prompt stands for as long as a human takes,
        // and a leaf the collection called dead may be live again under an edit made meanwhile.
        // Best-effort, like the collection — a file that no longer loads leaves the stale answer in
        // place rather than failing a clean already agreed to.
        const fresh = await loadVideoAndAnimatic(videoRoot).catch(() => ({ video, animatic }));
        const freshDeadKeys = new Set<string>();
        // Both stages, exactly as the collection above — a stage missing here reads as "no longer
        // dead", so a dry run and the real delete disagree.
        for (const def of [fresh.video, fresh.animatic]) {
          if (!def) continue;
          for (const { address, variantId } of [
            ...collectDeadCompositionVariants(mgr, def),
            ...collectDeadStemVariants(mgr, def),
          ]) {
            freshDeadKeys.add(`${address} ${variantId}`);
          }
        }
        const toRemove: CollectedVariant[] = [];
        for (const entry of collected) {
          const target = freshState.assets[entry.address];
          if (!target) continue;
          const v = target.variants?.[entry.variantId];
          if (!v) continue;
          if (isProtectedVariant(freshState, entry.address, entry.variantId)) continue;
          // A file-bearing variant collected without --delete-unaccepted was collected only
          // because it was a dead composition/stem leftover; require it to still be dead under
          // the lock.
          if (
            !opts.deleteUnaccepted &&
            v.file &&
            !freshDeadKeys.has(`${entry.address} ${entry.variantId}`)
          ) {
            continue;
          }
          // Re-check the lineage under the lock too: a patch applied (or accepted) since
          // collection would otherwise lose its source here. The job listing is refreshed for the
          // same reason — a reservation created after the first pass has no terminal marker and
          // no file, so only the live jobs can tell it apart from a dead one.
          if (freshActive.has(entry.variantId)) continue;
          if (
            collectDescendants(freshState, entry.address, entry.variantId).some(
              (id) => !collectedKeys.has(`${entry.address} ${id}`),
            )
          ) {
            continue;
          }
          mgr.removeVariant(entry.address, entry.variantId);
          toRemove.push(entry);
        }
        return toRemove;
      });

      for (const entry of confirmed) {
        const deletedPaths: string[] = [];
        for (const p of entry.paths) {
          if (await removePathSafely(p)) deletedPaths.push(p);
        }
        await jobManager.deleteJob(entry.variantId);
        result.removed.push({
          address: entry.address,
          variantId: entry.variantId,
          status: entry.status,
          category: entry.category,
          deletedPaths,
        });
      }
    }

    for (const dir of compositionCaches) {
      if (await removePathSafely(dir)) result.removedCompositionCaches.push(dir);
    }
  }

  // Pass 3: cascade-fail pending jobs whose dependencies were cleaned
  const cascadeFailed: CascadeFailedJob[] = await cascadeFailPendingJobs(
    videoRoot,
    result.removed.map((r) => r.address),
    allJobs,
    jobManager,
    { dryRun: opts.dryRun },
  );

  const totalCount = result.removed.length + cascadeFailed.length;
  const cacheCount = result.removedCompositionCaches.length;

  const keptLine =
    keptUnaccepted > 0 ? ` ${keptUnaccepted} unaccepted take(s) with media kept.` : "";

  // A variant this run deliberately left behind is this run's outcome too: without it a caller
  // reads the summary as "everything in scope is gone".
  for (const entry of result.skipped) {
    console.log(`Kept: ${entry.address} — ${entry.reason}`);
  }

  if (totalCount === 0 && cacheCount === 0) {
    console.log(`Nothing to clean.${keptLine}`);
    return;
  }

  const label = opts.dryRun ? "Would remove" : "Removed";
  for (const entry of result.removed) {
    console.log(`${label}: ${entry.address} ${entry.variantId} (${entry.status})`);
  }
  for (const entry of cascadeFailed) {
    console.log(`${label}: ${entry.address} ${entry.variantId} (${entry.status})`);
  }
  for (const dir of result.removedCompositionCaches) {
    console.log(`${label}: ${path.resolve(videoRoot, dir)} (composition cache)`);
  }
  const summaryParts: string[] = [];
  if (totalCount > 0) {
    summaryParts.push(
      `${totalCount} variant(s)${cascadeFailed.length > 0 ? ` (${cascadeFailed.length} pending job(s) cascade-failed)` : ""}`,
    );
  }
  if (cacheCount > 0) summaryParts.push(`${cacheCount} composition cache(s)`);
  console.log(`\n${label} ${summaryParts.join(", ")}.`);
}

export function registerCleanCommand(program: Command): void {
  program
    .command("clean [address-scope]")
    .description("Remove failed and cancelled variants")
    .option("--delete-unaccepted", "Also delete unaccepted variants that hold generated media")
    .option("--dry-run", "Preview what would be deleted without actually deleting")
    .option("-y, --yes", "Proceed without prompting (the deletion summary is still printed)")
    .option("--no", "Abort without prompting (treat confirmation as 'no')")
    .addHelpText(
      "after",
      `
Removes failed/cancelled variants and dead composition/stem leftovers, freeing their
generated files, jobs, logs, and caches. Accepted variants are always kept, and so is
every unaccepted take that holds generated media — those are reported as kept.
--delete-unaccepted adds them to the deletion, discarding finished takes — including ones
whose media is not in this checkout.

What will be deleted is itemized by class, printed under -y too. Deletion is confirmed
first (-y to proceed, --no to abort); --dry-run previews without deleting.

The optional address-scope argument narrows what is cleaned:
  omitted                  Clean across every stage
  <address-scope>          Clean only variants matching the prefix

Examples:
  konte clean                            Remove failed/cancelled variants everywhere
  konte clean video:shot.01              Clean only variants under shot 01
  konte clean --dry-run                  Preview what would be deleted
  konte clean --delete-unaccepted        Also discard unaccepted takes that hold media`,
    )
    .action(async (addressScope: string | undefined, opts) => {
      await executeClean({ addressScope, ...opts });
    });
}
