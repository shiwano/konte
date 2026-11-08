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
import {
  activeGenerationVariantIds,
  listPatchVariantIds,
  patchChainTargets,
  patchFilePath,
} from "../../core/patch.js";
import { listThumbnailAddressDirs } from "../../core/variant-thumbnails.js";
import { variantDir, variantsHostedBy } from "../../core/variant-dir.js";
import {
  acceptedConsumers,
  collectDescendants,
  isProtectedVariant,
} from "../../core/variant-lineage.js";
import { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/index.js";
import type {
  AnimaticDefinition,
  ReferenceDefinition,
  VideoDefinition,
} from "../../core/types/index.js";
import { confirmDeletion, formatBreakdown, printAborted, NO_FLAG_DESCRIPTION } from "../confirm.js";
import { loadDirectionIfPresent, loadStageDefinitions } from "../../core/stage-definitions.js";
import { directionPartHashes } from "../../core/direction-hash.js";
import { applyResolutionDefinitions } from "../../core/definition-hashes.js";
import type { StalenessCache } from "../../core/staleness.js";
import { getPathSize, removePathSafely } from "./clean-utils.js";
import {
  collectOrphans,
  orphanBreakdown,
  orphanCounts,
  type OrphanCounts,
  type OrphanDefinitions,
  orphanPlanPaths,
  orphanSubjects,
  orphanTotal,
  orphanVariantKeys,
  removeOrphans,
} from "./clean-orphans.js";
import { type CascadeFailedJob, cascadeFailPendingJobs } from "../../core/job-cascade.js";
import { prerollVariantDir } from "../../core/preview-preroll.js";
import { requireVideoRoot } from "../context.js";

const KONTE_DIR = ".konte";
const CACHE_DIR = "cache";
const LOGS_DIR = "logs";
const THUMBNAILS_DIR = "thumbnails";
const AUDIO_DIR = "audio";
const MOTION_DIR = "motion";

// Why a variant is deletable. The last three hold generated media; only `undecided` is added by
// --delete-undecided.
const CLEAN_CATEGORIES = [
  "failed",
  "cancelled",
  "incomplete",
  "dead leftover",
  "dismissed",
  "stale",
  "undecided",
] as const;
type CleanCategory = (typeof CLEAN_CATEGORIES)[number];

const CATEGORY_LABELS: Record<CleanCategory, string> = {
  failed: "failed",
  cancelled: "cancelled",
  incomplete: "incomplete (no media)",
  "dead leftover": "dead leftover",
  dismissed: "dismissed (has media)",
  stale: "stale beside a current accept (has media)",
  undecided: "undecided (has media)",
};

// Why a variant in scope is kept.
const KEEP_REASONS = [
  "made-from",
  "accepted-patch-source",
  "generating",
  "patch-applying",
  "undecided",
  "file-host",
  "kept-patch-source",
] as const;
type KeepReason = (typeof KEEP_REASONS)[number];

const KEEP_REASON_LABELS: Record<KeepReason, string> = {
  "made-from": "an accepted take was made from it",
  "accepted-patch-source": "source of an accepted patch",
  generating: "generating",
  "patch-applying": "has a patch applying",
  undecided: "undecided take holding generated media",
  "file-host": "holds the file of a kept take",
  "kept-patch-source": "source of a kept patch",
};

type CleanedVariant = {
  address: string;
  category: CleanCategory;
};

type CleanResult = {
  removed: CleanedVariant[];
  removedCompositionCaches: string[];
};

interface CleanOptions {
  addressScope?: string;
  deleteUndecided?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  no?: boolean;
}

function isStale(
  manager: StateManager,
  address: string,
  variantId: string,
  cache: StalenessCache,
): boolean | null {
  const s = manager.variantStaleness(address, variantId, cache);
  return s ? s.inputStale || s.definitionStale : null;
}

function isStaleBesideCurrentAccept(
  manager: StateManager,
  address: string,
  variantId: string,
  cache: StalenessCache,
): boolean {
  const accepted = manager.getAcceptedVariant(address);
  if (!accepted || accepted === variantId) return false;
  return (
    isStale(manager, address, accepted, cache) === false &&
    isStale(manager, address, variantId, cache) === true
  );
}

// `complete` only when every stage entry loaded — a missing definition axis reads a stale take as
// current.
async function loadDefinitions(
  videoRoot: string,
  manager: StateManager,
  opts: { reload?: boolean } = {},
): Promise<{
  video: VideoDefinition | null;
  animatic: AnimaticDefinition | null;
  reference: ReferenceDefinition | null;
  failed: string[];
  complete: boolean;
}> {
  const stages = await loadStageDefinitions(videoRoot, { tolerant: true, reload: opts.reload });
  await applyResolutionDefinitions({ videoRoot, definitions: stages, state: manager.getState() });
  const failed = Object.keys(stages.errors);
  return {
    video: stages.video,
    animatic: stages.animatic,
    reference: stages.reference,
    failed,
    complete: failed.length === 0,
  };
}

// What orphaned targets are judged against, or the stage files that do not load.
async function loadOrphanDefinitions(
  videoRoot: string,
  loaded: Awaited<ReturnType<typeof loadDefinitions>> | null,
): Promise<OrphanDefinitions | { unloaded: string[] }> {
  if (!loaded) return { unloaded: ["the stage files"] };
  const unloaded = loaded.failed.map((stage) => `${stage}.tsx`);
  let directionParts: string[] = [];
  try {
    const direction = await loadDirectionIfPresent(videoRoot);
    directionParts = direction ? [...directionPartHashes(direction).keys()] : [];
  } catch {
    unloaded.unshift("direction.ts");
  }
  if (!loaded.video && unloaded.length === 0) unloaded.push("video.tsx");
  if (unloaded.length > 0 || !loaded.video) return { unloaded };
  return {
    video: loaded.video,
    animatic: loaded.animatic,
    reference: loaded.reference,
    directionParts,
  };
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
  // Lineage is judged on the recorded state: an absent child still holds its parent. Only
  // --delete-undecided makes an absent variant a candidate — left out, it would be a state row
  // nothing can ever remove once no checkout holds its media.
  const state = manager.getRecordedState();
  const absent = opts.deleteUndecided ? new Set<string>() : manager.absentVariantIds();

  type CollectedVariant = {
    address: string;
    variantId: string;
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
  let definitionsComplete = false;
  let loaded: Awaited<ReturnType<typeof loadDefinitions>> | null = null;
  const deadLeafKeys = new Set<string>();
  try {
    loaded = await loadDefinitions(videoRoot, manager);
    ({ video, animatic, complete: definitionsComplete } = loaded);
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

  const jobManager = new JobManager(videoRoot);
  const allJobs = await jobManager.listJobs();
  const activeJobVariantIds = activeGenerationVariantIds(allJobs);

  // Orphaned targets go whole, accepted takes included — judged only on stage files that all load.
  const orphanDefs = await loadOrphanDefinitions(videoRoot, loaded);
  const definitions = "unloaded" in orphanDefs ? null : orphanDefs;
  const patchScriptIds = new Set(await listPatchVariantIds(videoRoot));
  const plan = await collectOrphans({
    videoRoot,
    manager,
    state,
    definitions,
    patchScriptIds,
    addressScope: opts.addressScope,
    allJobs,
    activeJobVariantIds,
  });
  const planned = orphanCounts(plan);
  const leftToOrphans = orphanVariantKeys(plan);

  if (
    opts.addressScope &&
    filteredAddresses.length === 0 &&
    compositionCaches.length === 0 &&
    orphanTotal(planned) === 0 &&
    plan.skippedActivePatches.length === 0
  ) {
    console.warn(`No assets matching "${opts.addressScope}"`);
    process.exitCode = 1;
    return;
  }

  // Pass 1: collect candidates
  const collected: CollectedVariant[] = [];
  const kept: KeepReason[] = [];
  const consumers = acceptedConsumers(state);
  const stalenessCache = manager.stalenessCache();

  for (const address of filteredAddresses) {
    const target = state.assets[address];
    if (!target) continue;

    for (const [variantId, variant] of Object.entries(target.variants ?? {})) {
      if (absent.has(variantId) || leftToOrphans.has(`${address} ${variantId}`)) continue;
      // An accepted take's patch source or input is not itself accepted, yet dropping it would
      // leave the accepted take with nothing to re-derive it from.
      if (isProtectedVariant(state, address, variantId, consumers)) {
        if (variant.status === "accepted") continue;
        kept.push(consumers.has(`${address} ${variantId}`) ? "made-from" : "accepted-patch-source");
        continue;
      }

      if (!variant.file && !variant.metadata?.error && !variant.metadata?.cancelledAt) {
        if (activeJobVariantIds.has(variantId)) {
          kept.push("generating");
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
        kept.push("patch-applying");
        continue;
      }

      const isDeadLeaf = deadLeafKeys.has(`${address} ${variantId}`);
      const isDismissed = variant.status === "dismissed";
      const isStaleLeftover =
        definitionsComplete &&
        !isDeadLeaf &&
        variant.status === "none" &&
        !!variant.file &&
        isStaleBesideCurrentAccept(manager, address, variantId, stalenessCache);
      if (
        !opts.deleteUndecided &&
        variant.file &&
        !isDeadLeaf &&
        !isDismissed &&
        !isStaleLeftover
      ) {
        kept.push("undecided");
        continue;
      }

      const paths: string[] = [];
      paths.push(variantDir(videoRoot, address, variantId));
      // A patch script names one take, so it dies with it: "no orphaned patch" stays an invariant.
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
            : isDismissed
              ? "dismissed"
              : isStaleLeftover
                ? "stale"
                : variant.file
                  ? "undecided"
                  : "incomplete";

      collected.push({ address, variantId, category, paths });
    }
  }

  const collectedKeys = new Set(collected.map((c) => `${c.address} ${c.variantId}`));
  // The orphan pass runs first and takes its own variants, so a take it removes strands nothing.
  const leaving = (key: string) => collectedKeys.has(key) || leftToOrphans.has(key);

  // A variant directory holding another variant's file is not deleted while that other variant
  // survives — a patch chain's returned step hosts the file the patched take points at, so dropping
  // it would leave a take (possibly the accepted one) with no bytes. Deleting both together is
  // fine, which is why this asks about the survivors rather than refusing outright.
  for (const entry of [...collected]) {
    const orphaned = variantsHostedBy(state, entry.address, entry.variantId).filter(
      (ref) => !leaving(`${ref.address} ${ref.variantId}`),
    );
    if (orphaned.length === 0) continue;
    collectedKeys.delete(`${entry.address} ${entry.variantId}`);
    collected.splice(collected.indexOf(entry), 1);
    kept.push("file-host");
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
        (id) => !leaving(`${entry.address} ${id}`),
      );
      if (stranded.length === 0) continue;
      collectedKeys.delete(key);
      collected.splice(collected.indexOf(entry), 1);
      kept.push("kept-patch-source");
      changed = true;
    }
  }

  const categoryCounts = countByCategory(collected);

  // Confirmation is required for the actual deletion: an output format is an
  // output format, not a consent. Skipped only for --dry-run, which deletes nothing. --yes still
  // enters the call — it consents without prompting, but the summary is disclosed. Non-TTY
  // without --yes/--no fails CONFIRMATION_REQUIRED inside confirmAction.
  if (
    (collected.length > 0 || compositionCaches.length > 0 || orphanTotal(planned) > 0) &&
    !opts.dryRun
  ) {
    let totalSize = 0;
    for (const p of [
      ...collected.flatMap((entry) => entry.paths),
      ...compositionCaches,
      ...orphanPlanPaths(videoRoot, plan),
    ]) {
      totalSize += await getPathSize(p);
    }
    const acceptedOrphans = plan.targets.reduce((n, t) => n + t.acceptedCount, 0);
    const confirmed = await confirmDeletion({
      subjects: summarySubjects(collected.length, compositionCaches.length, planned),
      totalSize,
      note:
        acceptedOrphans > 0
          ? `including ${acceptedOrphans} accepted take(s) at addresses no longer declared`
          : undefined,
      breakdown: breakdownRows(categoryCounts, planned),
      yes: opts.yes,
      no: opts.no,
    });
    if (!confirmed) {
      printAborted();
      return;
    }
  }

  // Pass 2: state mutation inside lock + filesystem deletion
  const result: CleanResult = { removed: [], removedCompositionCaches: [] };
  let removedOrphans: OrphanCounts = planned;
  let removedOrphanAddresses = plan.targets.map((t) => t.address);

  if (opts.dryRun) {
    for (const entry of collected) {
      result.removed.push({ address: entry.address, category: entry.category });
    }
    result.removedCompositionCaches = [...compositionCaches];
  } else {
    ({ counts: removedOrphans, removedAddresses: removedOrphanAddresses } = await removeOrphans({
      videoRoot,
      plan,
      definitions,
      patchScriptIds,
      jobManager,
    }));

    if (collected.length > 0) {
      const confirmed = await StateManager.withLock(videoRoot, async (mgr) => {
        const freshState = mgr.getRecordedState();
        const freshActive = activeGenerationVariantIds(await jobManager.listJobs());
        // Re-derive dead composition/stem leftovers under the lock so a concurrent accept that
        // re-materialized one between collection and now is not deleted (a TOCTOU window). The
        // DEFINITIONS are re-read too: the confirmation prompt stands for as long as a human takes,
        // and a leaf the collection called dead may be live again under an edit made meanwhile.
        // Reloaded, since a cached module would answer with the definition the collection read. A
        // stage that no longer loads keeps what it would have decided.
        const fresh = await loadDefinitions(videoRoot, mgr, { reload: true }).catch(() => ({
          video,
          animatic,
          complete: false,
        }));
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
        // Judged before any removal: a write invalidates the staleness memo.
        const freshCache = mgr.stalenessCache();
        const freshStaleKeys = new Set(
          fresh.complete
            ? collected
                .filter(
                  (e) =>
                    e.category === "stale" &&
                    isStaleBesideCurrentAccept(mgr, e.address, e.variantId, freshCache),
                )
                .map((e) => `${e.address} ${e.variantId}`)
            : [],
        );
        const toRemove: CollectedVariant[] = [];
        const freshConsumers = acceptedConsumers(freshState);
        for (const entry of collected) {
          const target = freshState.assets[entry.address];
          if (!target) continue;
          const v = target.variants?.[entry.variantId];
          if (!v) continue;
          if (isProtectedVariant(freshState, entry.address, entry.variantId, freshConsumers)) {
            continue;
          }
          // A file-bearing variant collected without --delete-undecided was collected only
          // because it was dismissed, stale beside a current accept, or a dead composition/stem
          // leftover; require it to still be so under the lock.
          const key = `${entry.address} ${entry.variantId}`;
          if (
            !opts.deleteUndecided &&
            v.file &&
            v.status !== "dismissed" &&
            !(v.status === "none" && freshStaleKeys.has(key)) &&
            !freshDeadKeys.has(key)
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
        for (const p of entry.paths) await removePathSafely(p);
        await jobManager.deleteJob(entry.variantId);
        result.removed.push({ address: entry.address, category: entry.category });
      }
    }

    for (const dir of compositionCaches) {
      if (await removePathSafely(dir)) result.removedCompositionCaches.push(dir);
    }
  }

  // Pass 3: cascade-fail pending jobs whose dependencies were cleaned
  const cascadeFailed: CascadeFailedJob[] = await cascadeFailPendingJobs(
    videoRoot,
    [...result.removed.map((r) => r.address), ...removedOrphanAddresses],
    allJobs,
    jobManager,
    { dryRun: opts.dryRun },
  );

  // A variant this run deliberately left behind is this run's outcome too: without it a caller
  // reads the summary as "everything in scope is gone".
  if (kept.length > 0) {
    console.log(`Kept ${kept.length} variant(s):`);
    for (const line of formatBreakdown(
      KEEP_REASONS.map((r) => ({
        label: KEEP_REASON_LABELS[r],
        count: kept.filter((k) => k === r).length,
      })),
    )) {
      console.log(line);
    }
  }

  const removedCount = result.removed.length;
  const cacheCount = result.removedCompositionCaches.length;
  if (removedCount === 0 && cacheCount === 0 && orphanTotal(removedOrphans) === 0) {
    console.log("Nothing to clean.");
  } else {
    const subjects = opts.dryRun
      ? summarySubjects(removedCount, cacheCount, removedOrphans)
      : [...summarySubjects(removedCount, cacheCount, null), ...orphanSubjects(removedOrphans)];
    if (cascadeFailed.length > 0) {
      subjects.push(`${cascadeFailed.length} pending job(s) cascade-failed`);
    }
    if (!opts.dryRun) {
      console.log(`Removed ${subjects.join(", ")}.`);
    } else {
      // A real run itemized the classes in its confirmation; a dry run has none.
      console.log(`Would remove ${subjects.join(", ")}:`);
      for (const line of formatBreakdown(
        breakdownRows(countByCategory(result.removed), removedOrphans),
      )) {
        console.log(line);
      }
    }
  }

  const held = (n: number, what: string, remedy: string) => {
    if (n > 0) console.log(`Skipped ${n} ${what} — ${remedy}.`);
  };
  held(plan.skippedActive.length, "orphaned target(s) with an active job", "retry once it settles");
  held(
    plan.skippedActivePatches.length,
    "patch leftover(s) whose lineage has an active job",
    "retry once it settles",
  );
  held(
    plan.skippedHosting.length,
    "orphaned target(s) still holding a live variant's file",
    "widen the scope to take both",
  );
  if (plan.keptForAccepted.length > 0) {
    console.log(
      `Kept ${plan.keptForAccepted.length} orphaned target(s) an accepted take was made from — removable once another take is accepted there.`,
    );
  }
  if ("unloaded" in orphanDefs) {
    console.log(
      `Orphaned targets not checked: ${orphanDefs.unloaded.join(", ")} does not load — fix it and rerun.`,
    );
  }
}

// A headline the breakdown under it itemizes: one total for the orphaned leftovers.
function summarySubjects(variants: number, caches: number, orphans: OrphanCounts | null): string[] {
  const subjects: string[] = [];
  if (variants > 0) subjects.push(`${variants} variant(s)`);
  if (caches > 0) subjects.push(`${caches} composition cache(s)`);
  const orphanCount = orphans ? orphanTotal(orphans) : 0;
  if (orphanCount > 0) subjects.push(`${orphanCount} orphaned leftover(s)`);
  return subjects;
}

function breakdownRows(
  categories: Record<CleanCategory, number>,
  orphans: OrphanCounts,
): { label: string; count: number }[] {
  return [
    ...CLEAN_CATEGORIES.map((c) => ({ label: CATEGORY_LABELS[c], count: categories[c] })),
    ...orphanBreakdown(orphans),
  ];
}

export function registerCleanCommand(program: Command): void {
  program
    .command("clean [address-scope]")
    .description("Remove failed, dismissed and orphaned takes, and what they leave behind")
    .option("--delete-undecided", "Also delete undecided variants that hold generated media")
    .option("--dry-run", "Preview what would be deleted without actually deleting")
    .option("--no", NO_FLAG_DESCRIPTION)
    .addHelpText(
      "after",
      `
Removes, freeing their generated files, jobs, logs and caches:
  - variants: failed/cancelled/dismissed ones, undecided takes gone stale beside an accept
    that is not, and dead composition/stem leftovers. Accepted variants are kept, and so is
    every take an accepted one was made from, and every other undecided take that holds
    generated media — those are reported as kept. --delete-undecided adds them, discarding
    finished takes — including ones whose media is not in this checkout.
  - orphaned targets: an address no longer in the definition (e.g. after deleting a
    shot/asset from video.tsx) — the entire target goes: every variant (including
    accepted), its feedback, and the state entry. One an accepted take at a live address
    was made from is kept and listed instead. Checked only when every stage file loads.
  - orphaned jobs and patch leftovers: a job file whose variant is gone from state, a patch
    script whose take is gone, a take whose patch script is gone (active jobs are never
    touched)
  - spent provisioning jobs: settled comfy model-download / node-install / node-activate
    records nothing pending depends on. Unscoped runs only.
  - stray variant directories: a variant directory under assets/ that no state row records.
    Unscoped runs only.

What will be deleted is itemized by class, printed under -y too. Deletion is confirmed
first (-y to proceed, --no to abort).

The optional address-scope argument narrows what is cleaned:
  omitted                  Clean across every stage
  <address-scope>          Clean only what matches the prefix

Examples:
  konte clean                            Clean everywhere
  konte clean video:shot.01              Clean only under shot 01
  konte clean --dry-run                  Preview what would be deleted
  konte clean --delete-undecided         Also discard undecided takes that hold media`,
    )
    .action(async (addressScope: string | undefined, opts) => {
      await executeClean({ addressScope, ...opts });
    });
}
