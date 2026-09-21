import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import {
  addressToCacheSegments,
  assertValidAddressScope,
  isCompositionAddress,
  parseAddress,
  parseAddressStream,
} from "../../core/address.js";
import { FeedbackManager, listAllFeedback } from "../../core/feedback/index.js";
import { isJobTerminal, JobManager } from "../../core/job-manager.js";
import type { JobRecord } from "../../core/types/index.js";
import { buildOrphanContext, listStrayVariantDirs } from "../../core/orphans.js";
import { StateManager } from "../../core/state/index.js";
import {
  activeGenerationVariantIds,
  listPatchVariantIds,
  patchFilePath,
} from "../../core/patch.js";
import { prerollVariantDir } from "../../core/preview-preroll.js";
import { listThumbnailAddressDirs } from "../../core/thumbnail.js";
import {
  assetDir,
  patchBucketDir,
  patchChainDir,
  variantDir,
  variantsHostedBy,
} from "../../core/variant-dir.js";
import { collectDescendants } from "../../core/variant-lineage.js";
import { confirmDeletion, printAborted } from "../confirm.js";
import { loadStageDefinitions } from "../load-definition.js";
import {
  type CascadeFailedJob,
  cascadeFailPendingJobs,
  getPathSize,
  removePathSafely,
} from "./clean-utils.js";
import { matchesAddressScope } from "../../core/address.js";
import { requireVideoRoot } from "../context.js";

const KONTE_DIR = ".konte";
const CACHE_DIR = "cache";
const LOGS_DIR = "logs";
const THUMBNAILS_DIR = "thumbnails";
const AUDIO_DIR = "audio";
const MOTION_DIR = "motion";

// The three job kinds that provision the ComfyUI server rather than produce a variant.
function isProvisioningJob(job: JobRecord): boolean {
  return (
    job.kind === "comfy-model-download" ||
    job.kind === "comfy-node-install" ||
    job.kind === "comfy-node-activate"
  );
}

// What a provisioning job is called in the listing: the thing it provisioned, since it has no
// address to name it by.
function provisioningLabel(job: JobRecord): string {
  if (job.kind === "comfy-model-download") return `model ${job.model.filename}`;
  if (job.kind === "comfy-node-install") return `node ${job.node.id}`;
  if (job.kind === "comfy-node-activate") {
    return `node activation${job.cnrIds.length > 0 ? ` [${job.cnrIds.join(", ")}]` : ""}`;
  }
  return job.id;
}

type PrunedTarget = {
  address: string;
  variantCount: number;
  variantIds: string[];
  feedbackCount: number;
  paths: string[];
};

type OrphanedJob = {
  variantId: string;
  address: string;
  paths: string[];
};

// A settled comfy provisioning job (model download, node install, node activation). These carry
// no asset or variant, so the state-orphan passes never reach them and nothing else ever deleted
// one — a project accumulated a record per run forever.
type SpentProvisioningJob = {
  jobId: string;
  label: string;
  paths: string[];
};

// A patch script whose source variant is gone from state, or a patch output whose script is gone.
// Normally neither can happen — clean and `patch remove` take the pair together — so these are the
// leftovers of a hand-deleted file or an interrupted run.
// What one variant leaves under .konte besides its asset dir: its log, caches and patch script.
function variantLeftoverPaths(videoRoot: string, variantId: string): string[] {
  return [
    path.join(videoRoot, KONTE_DIR, LOGS_DIR, `${variantId}.log`),
    path.join(videoRoot, KONTE_DIR, CACHE_DIR, AUDIO_DIR, variantId),
    path.join(videoRoot, KONTE_DIR, CACHE_DIR, MOTION_DIR, variantId),
    prerollVariantDir(videoRoot, variantId),
    patchFilePath(videoRoot, variantId),
  ];
}

type OrphanedPatch = {
  variantId: string;
  kind: "script" | "output";
  address: string | null;
  paths: string[];
};

interface PruneOptions {
  addressScope?: string;
  dryRun?: boolean;
  yes?: boolean;
  no?: boolean;
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch {
    // directory is non-empty or does not exist
  }
}

async function executePrune(opts: PruneOptions): Promise<void> {
  const videoRoot = requireVideoRoot();

  // Successfully loaded definitions are required: without them we cannot tell which addresses are
  // genuinely orphaned versus temporarily unreadable — a broken reference.tsx must abort prune,
  // never silently null out and orphan every reference target.
  const { video, animatic, reference } = await loadStageDefinitions(videoRoot);

  // `validCompositionAddresses` doubles as the live set for the composition-cache pass below;
  // `isOrphan` is shared with `doctor` so prune and its warning never disagree on what an orphan is.
  const patchScriptIds = new Set(await listPatchVariantIds(videoRoot));
  const manager = await StateManager.load(videoRoot);
  // Recorded, absent variants included: an orphaned target takes them with it, and their directories
  // are not stray.
  const state = manager.getRecordedState();
  const { validCompositionAddresses, isOrphan } = buildOrphanContext(
    video,
    animatic,
    reference,
    patchScriptIds,
    state,
  );

  if (opts.addressScope) assertValidAddressScope(opts.addressScope);

  const orphanAddresses = Object.keys(state.assets).filter(isOrphan);
  const scoped = opts.addressScope
    ? orphanAddresses.filter((addr) => matchesAddressScope(addr, opts.addressScope!))
    : orphanAddresses;

  // Feedback now lives in per-stream files, not on the asset state — count it up front so the
  // prune summary can still report how much feedback each pruned target sheds.
  const feedbackCounts = new Map<string, number>();
  for (const { address } of await listAllFeedback(videoRoot)) {
    feedbackCounts.set(address, (feedbackCounts.get(address) ?? 0) + 1);
  }

  // Feedback attached to an address that is no longer a state asset AND is orphaned by the
  // definition (e.g. whole-shot notes on a shot deleted from direction). The state-orphan pass
  // can't see these — they have no variants — so gather them to prune their stream entries too.
  const feedbackOnlyOrphans = [...feedbackCounts.keys()].filter(
    (addr) =>
      !state.assets[addr] &&
      isOrphan(addr) &&
      (!opts.addressScope || matchesAddressScope(addr, opts.addressScope)),
  );

  // Orphaned composition caches: a shot was removed from the definition (or lost its shotFn),
  // leaving its render cache on disk. Composition addresses are not state assets, so the
  // state-orphan pass above never sees them — enumerate them from the filesystem, dropping
  // only caches whose composition address is no longer valid.
  const thumbnailsRoot = path.join(videoRoot, KONTE_DIR, CACHE_DIR, THUMBNAILS_DIR);
  const orphanCompositionCaches: string[] = [];
  for (const { address: cacheAddress, dir } of await listThumbnailAddressDirs(thumbnailsRoot)) {
    if (!isCompositionAddress(cacheAddress) || validCompositionAddresses.has(cacheAddress))
      continue;
    if (opts.addressScope && !matchesAddressScope(cacheAddress, opts.addressScope)) continue;
    orphanCompositionCaches.push(dir);
  }

  const jobManager = new JobManager(videoRoot);
  const allJobs = await jobManager.listJobs();

  // Orphaned jobs: generation job files whose (address, variant) no longer exists in state — e.g.
  // a variant removed by an earlier edit or reset that left its job/log/caches behind. The
  // state-orphan pass keys off `state.assets`, so it never sees a job whose variant is already gone
  // from state; enumerate them from the job list instead. Skip active jobs (pending/queued/running):
  // `reserveVariants` records a variant before its job is created, so an in-flight job's variant is
  // in state, but deleting a live job's files would strand a backend job — never prune one.
  const activeJobVariantIds = new Set(
    allJobs
      .filter(
        (j) =>
          j.kind === "generation" &&
          (j.status === "pending" || j.status === "queued" || j.status === "running"),
      )
      .map((j) => j.id),
  );
  const orphanedJobs: OrphanedJob[] = [];
  for (const job of allJobs) {
    if (job.kind !== "generation") continue;
    const target = state.assets[job.address];
    if (target?.variants?.[job.variantId]) continue;
    if (activeJobVariantIds.has(job.variantId)) continue;
    if (opts.addressScope && !matchesAddressScope(job.address, opts.addressScope)) continue;
    const paths = [
      path.join(videoRoot, KONTE_DIR, LOGS_DIR, `${job.variantId}.log`),
      path.join(videoRoot, KONTE_DIR, CACHE_DIR, AUDIO_DIR, job.variantId),
      path.join(videoRoot, KONTE_DIR, CACHE_DIR, MOTION_DIR, job.variantId),
      prerollVariantDir(videoRoot, job.variantId),
    ];
    try {
      paths.push(variantDir(videoRoot, job.address, job.variantId));
      paths.push(
        path.join(
          videoRoot,
          KONTE_DIR,
          CACHE_DIR,
          THUMBNAILS_DIR,
          ...addressToCacheSegments(job.address),
          job.variantId,
        ),
      );
    } catch {
      // unparseable address: drop the job/log/audio/motion files, skip the asset/thumbnail dirs
    }
    orphanedJobs.push({ variantId: job.variantId, address: job.address, paths });
  }

  // Spent provisioning jobs. Deleting a settled one loses nothing: its id derives from what it
  // provisions, and `ensure*Job` resets any terminal record it finds anyway, so the next run that
  // needs the model/pack recreates the job and re-checks the server. What the record holds is
  // history — which is worth keeping until it is the only thing left in `job list`.
  //
  // Scoped runs skip them: a provisioning job has no address, so no scope can be said to match it.
  const spentProvisioningJobs: SpentProvisioningJob[] = [];
  if (!opts.addressScope) {
    // A live job's dependency is off limits even when the dependency itself has settled: the
    // dependent reads it back to decide whether it may run, and a missing one fails it outright.
    const dependedOn = new Set(
      allJobs.filter((j) => !isJobTerminal(j.status)).flatMap((j) => j.dependsOnJobs ?? []),
    );
    for (const job of allJobs) {
      if (!isProvisioningJob(job) || !isJobTerminal(job.status)) continue;
      if (dependedOn.has(job.id)) continue;
      spentProvisioningJobs.push({
        jobId: job.id,
        label: provisioningLabel(job),
        paths: [path.join(videoRoot, KONTE_DIR, LOGS_DIR, `${job.id}.log`)],
      });
    }
  }

  // Orphaned patches, both directions. A script whose source variant is gone can never be applied
  // again; a variant whose script is gone can never be re-derived, and its `derivedFrom` points at
  // a correction no file describes. Listing filenames is enough here — no module is imported, so a
  // syntactically broken patch is still prunable.
  const orphanedPatches: OrphanedPatch[] = [];
  // Kept apart from `skippedActive`: that list is described to the user as orphaned *targets*, and
  // a patch leftover held back by a live job is a different thing with a different remedy.
  const skippedActivePatches: string[] = [];
  for (const variantId of patchScriptIds) {
    if (manager.findVariantAddress(variantId) || manager.absentVariantIds().has(variantId))
      continue;
    // Its variant is gone, so its address is unknowable — which means a scoped run cannot tell
    // whether it belongs to the scope. Leave it for an unscoped `prune` rather than widening the
    // scope the user asked for.
    if (opts.addressScope) continue;
    orphanedPatches.push({
      variantId,
      kind: "script",
      address: null,
      paths: [patchFilePath(videoRoot, variantId)],
    });
  }
  for (const [address, target] of Object.entries(state.assets)) {
    if (opts.addressScope && !matchesAddressScope(address, opts.addressScope)) continue;
    // Expand each stranded output through its own descendants first. Removing a variant whose
    // script is gone while keeping something patched on top of it would replace one orphan with
    // another — a live variant whose `derivedFrom` names a variant that no longer exists. A
    // lineage is pruned as a unit, exactly as `clean` treats it.
    const stranded = new Set<string>();
    for (const [variantId, variant] of Object.entries(target.variants ?? {})) {
      if (!variant.derivedFrom || patchScriptIds.has(variant.derivedFrom)) continue;
      stranded.add(variantId);
      for (const id of collectDescendants(state, address, variantId)) stranded.add(id);
    }
    // An active job anywhere in the lineage holds the whole lineage back — pruning around it
    // would strand that job or re-orphan its ancestors. Reported rather than dropped, so a run
    // that cleaned nothing says why instead of "nothing to prune".
    if ([...stranded].some((id) => activeJobVariantIds.has(id))) {
      if (stranded.size > 0) skippedActivePatches.push(`${address} (${stranded.size} variant(s))`);
      continue;
    }
    for (const variantId of stranded) {
      const paths = [
        // A descendant may carry its own patch script; it names a take about to stop existing.
        patchFilePath(videoRoot, variantId),
        path.join(videoRoot, KONTE_DIR, LOGS_DIR, `${variantId}.log`),
        path.join(videoRoot, KONTE_DIR, CACHE_DIR, AUDIO_DIR, variantId),
        path.join(videoRoot, KONTE_DIR, CACHE_DIR, MOTION_DIR, variantId),
        prerollVariantDir(videoRoot, variantId),
      ];
      try {
        paths.push(variantDir(videoRoot, address, variantId));
        paths.push(
          path.join(
            videoRoot,
            KONTE_DIR,
            CACHE_DIR,
            THUMBNAILS_DIR,
            ...addressToCacheSegments(address),
            variantId,
          ),
        );
      } catch {
        // unparseable address: drop the job/log/audio/motion files only
      }
      orphanedPatches.push({ variantId, kind: "output", address, paths });
    }
  }

  // Unscoped runs only: a directory with no state row has no address a scope could match.
  const strayVariantDirs = opts.addressScope ? [] : await listStrayVariantDirs(videoRoot, state);

  if (
    opts.addressScope &&
    scoped.length === 0 &&
    orphanCompositionCaches.length === 0 &&
    feedbackOnlyOrphans.length === 0 &&
    orphanedJobs.length === 0 &&
    orphanedPatches.length === 0 &&
    // Held-back-by-a-live-job is not "nothing matched" — saying so would send the user looking
    // for a scope typo instead of waiting for the job.
    skippedActivePatches.length === 0
  ) {
    const msg = `No orphaned assets matching "${opts.addressScope}"`;
    console.warn(msg);
    process.exitCode = 1;
    return;
  }

  // Collect candidates
  const collected: PrunedTarget[] = [];
  // Orphaned targets held back because a generation job for one of their variants is still in flight
  // (address removed from the definition while the variant is legitimately mid-generation). Deleting
  // the target would strand the backend job, so skip the whole target — the same "never touch active
  // jobs" guard the orphaned-job pass uses — and report it so the orphan isn't silently left behind.
  const skippedActive: string[] = [];
  // Orphaned targets held back because a variant elsewhere still points at a file inside one of
  // theirs — a patched take, whose file is the chain's returned step's. Unscoped, the two go
  // together (the step is orphaned only once its script is gone, which strands the take as well);
  // a scope that names one side and not the other is what this catches.
  const skippedHosting: string[] = [];

  // An active job holds its whole target back, so those go first — a host must not read a variant
  // in a skipped target as "leaving anyway" and delete the file out from under it.
  const survivingAddresses = new Set<string>();
  for (const address of scoped) {
    const variants = state.assets[address]?.variants ?? {};
    if (Object.keys(variants).some((vid) => activeJobVariantIds.has(vid))) {
      skippedActive.push(address);
      survivingAddresses.add(address);
    }
  }
  const removedVariantKeys = new Set<string>();
  const rebuildRemovedKeys = () => {
    removedVariantKeys.clear();
    for (const address of scoped) {
      if (survivingAddresses.has(address)) continue;
      for (const vid of Object.keys(state.assets[address]?.variants ?? {})) {
        removedVariantKeys.add(`${address} ${vid}`);
      }
    }
    for (const patch of orphanedPatches) {
      if (patch.kind === "output" && patch.address && !survivingAddresses.has(patch.address)) {
        removedVariantKeys.add(`${patch.address} ${patch.variantId}`);
      }
    }
  };
  // Held back to a fixpoint: keeping one target can be what makes another a host of a survivor.
  for (let changed = true; changed; ) {
    changed = false;
    rebuildRemovedKeys();
    for (const address of scoped) {
      if (survivingAddresses.has(address)) continue;
      const stillPointing = Object.keys(state.assets[address]?.variants ?? {})
        .flatMap((vid) => variantsHostedBy(state, address, vid))
        .filter((ref) => !removedVariantKeys.has(`${ref.address} ${ref.variantId}`));
      if (stillPointing.length === 0) continue;
      survivingAddresses.add(address);
      skippedHosting.push(
        `${address} (holds the file of ${stillPointing
          .map((r) => `${r.address} ${r.variantId}`)
          .join(", ")})`,
      );
      changed = true;
    }
  }

  for (const address of scoped) {
    const target = state.assets[address];
    if (!target) continue;
    if (survivingAddresses.has(address)) continue;
    const variants = target.variants ?? {};

    const paths: string[] = [];
    try {
      paths.push(assetDir(videoRoot, address));
    } catch {
      // unparseable address: skip filesystem cleanup, still drop the state key
    }
    paths.push(
      path.join(
        videoRoot,
        KONTE_DIR,
        CACHE_DIR,
        THUMBNAILS_DIR,
        ...addressToCacheSegments(address),
      ),
    );
    for (const variantId of Object.keys(variants)) {
      paths.push(...variantLeftoverPaths(videoRoot, variantId));
    }

    collected.push({
      address,
      variantCount: Object.keys(variants).length,
      variantIds: Object.keys(variants),
      feedbackCount: feedbackCounts.get(address) ?? 0,
      paths,
    });
  }

  // Confirmation is required for the actual deletion: an output format is an
  // output format, not a consent. Skipped only for --dry-run, which deletes nothing. --yes still
  // enters the call — it consents without prompting, but the summary is disclosed. Non-TTY
  // without --yes/--no fails CONFIRMATION_REQUIRED inside confirmAction.
  const hasWork =
    collected.length > 0 ||
    orphanCompositionCaches.length > 0 ||
    feedbackOnlyOrphans.length > 0 ||
    orphanedJobs.length > 0 ||
    orphanedPatches.length > 0 ||
    spentProvisioningJobs.length > 0 ||
    strayVariantDirs.length > 0;
  if (hasWork && !opts.dryRun) {
    let totalSize = 0;
    for (const entry of collected) {
      for (const p of entry.paths) {
        totalSize += await getPathSize(p);
      }
    }
    for (const dir of orphanCompositionCaches) {
      totalSize += await getPathSize(dir);
    }
    for (const job of orphanedJobs) {
      for (const p of job.paths) {
        totalSize += await getPathSize(p);
      }
    }
    for (const patch of orphanedPatches) {
      for (const p of patch.paths) {
        totalSize += await getPathSize(p);
      }
    }
    for (const job of spentProvisioningJobs) {
      for (const p of job.paths) {
        totalSize += await getPathSize(p);
      }
    }
    const subjects: string[] = [];
    if (collected.length > 0) subjects.push(`${collected.length} orphaned target(s)`);
    if (orphanCompositionCaches.length > 0)
      subjects.push(`${orphanCompositionCaches.length} orphaned composition cache(s)`);
    if (feedbackOnlyOrphans.length > 0)
      subjects.push(`${feedbackOnlyOrphans.length} orphaned feedback target(s)`);
    if (orphanedJobs.length > 0) subjects.push(`${orphanedJobs.length} orphaned job(s)`);
    if (spentProvisioningJobs.length > 0)
      subjects.push(`${spentProvisioningJobs.length} spent provisioning job(s)`);
    if (orphanedPatches.length > 0)
      subjects.push(`${orphanedPatches.length} orphaned patch leftover(s)`);
    for (const dir of strayVariantDirs) {
      totalSize += await getPathSize(path.join(videoRoot, dir));
    }
    if (strayVariantDirs.length > 0)
      subjects.push(`${strayVariantDirs.length} stray variant director(ies)`);
    const confirmed = await confirmDeletion({
      subjects,
      totalSize,
      note: "including accepted",
      yes: opts.yes,
      no: opts.no,
    });
    if (!confirmed) {
      printAborted();
      return;
    }
  }

  // State mutation inside lock + filesystem deletion
  const removed: PrunedTarget[] = [];
  const removedCompositionCaches: string[] = [];
  const removedFeedbackOnly: Array<{ address: string; feedbackCount: number }> = [];
  const removedJobs: OrphanedJob[] = [];
  const removedProvisioningJobs: SpentProvisioningJob[] = [];
  const removedPatches: OrphanedPatch[] = [];
  const removedStrayDirs: string[] = [];

  const feedbackOnlyEntry = (address: string) => ({
    address,
    feedbackCount: feedbackCounts.get(address) ?? 0,
  });

  if (opts.dryRun) {
    removed.push(...collected);
    removedCompositionCaches.push(...orphanCompositionCaches);
    removedFeedbackOnly.push(...feedbackOnlyOrphans.map(feedbackOnlyEntry));
    removedJobs.push(...orphanedJobs);
    removedProvisioningJobs.push(...spentProvisioningJobs);
    removedPatches.push(...orphanedPatches);
    removedStrayDirs.push(...strayVariantDirs);
  } else {
    if (collected.length > 0) {
      const confirmedTargets = await StateManager.withLock(videoRoot, async (mgr) => {
        const toRemove: PrunedTarget[] = [];
        // The confirmation prompt sat open for as long as a human took; a `generate` in that window
        // may have reserved a new variant on one of these targets and put its job in flight, so the
        // active-job guard is re-applied on a fresh listing before anything is dropped.
        const freshActive = activeGenerationVariantIds(await jobManager.listJobs());
        for (const entry of collected) {
          const target = mgr.getRecordedState().assets[entry.address];
          if (!target) continue;
          const variantIds = Object.keys(target.variants ?? {});
          if (variantIds.some((id) => freshActive.has(id))) {
            skippedActive.push(entry.address);
            continue;
          }
          mgr.removeAsset(entry.address);
          // A variant reserved since the survey goes with the target — its job row and leftovers too.
          const late = variantIds.filter((id) => !entry.variantIds.includes(id));
          toRemove.push({
            ...entry,
            variantIds: [...entry.variantIds, ...late],
            paths: [...entry.paths, ...late.flatMap((id) => variantLeftoverPaths(videoRoot, id))],
          });
        }
        return toRemove;
      });

      for (const entry of confirmedTargets) {
        for (const p of entry.paths) {
          await removePathSafely(p);
        }
        for (const variantId of entry.variantIds) await jobManager.deleteJob(variantId);
        // Drop the target's feedback stream entries too (its thumbnail dir is already in
        // `entry.paths`). Bare-shot feedback-only targets are never in `collected`, so this
        // only affects the variant-bearing asset addresses being pruned.
        if ((feedbackCounts.get(entry.address) ?? 0) > 0) {
          try {
            const { stage } = parseAddress(entry.address);
            await FeedbackManager.withLock(videoRoot, stage, async (fbMgr) => {
              fbMgr.removeAddress(entry.address);
            });
          } catch {
            // unparseable address: nothing to remove
          }
        }
        removed.push(entry);
      }

      // best-effort: collapse now-empty stage directories
      const dirsToCheck = new Set<string>();
      for (const entry of removed) {
        try {
          const parsed = parseAddress(entry.address);
          dirsToCheck.add(path.join(videoRoot, "assets", parsed.stage));
          // A patch step sits two levels deeper (`patch/<vid>/<name>`), so its chain and the
          // stage's patch bucket are collapsible too. The descending-length sort below empties
          // them innermost-first.
          if (parsed.kind === "patch") {
            dirsToCheck.add(patchChainDir(videoRoot, parsed.stage, parsed.sourceVariantId));
            dirsToCheck.add(patchBucketDir(videoRoot, parsed.stage));
          }
        } catch {
          // unparseable address: nothing to collapse
        }
      }
      for (const dir of [...dirsToCheck].sort((a, b) => b.length - a.length)) {
        await removeIfEmpty(dir);
      }
    }

    for (const dir of orphanCompositionCaches) {
      if (await removePathSafely(dir)) removedCompositionCaches.push(dir);
    }

    // Feedback-only orphans: drop their stream entries. Their frames need no sweep of their own —
    // they cache in the shot composition's dir, which the composition-cache pass above owns.
    for (const address of feedbackOnlyOrphans) {
      try {
        const { stage } = parseAddressStream(address);
        await FeedbackManager.withLock(videoRoot, stage, (fbMgr) =>
          Promise.resolve(fbMgr.removeAddress(address)),
        );
        removedFeedbackOnly.push(feedbackOnlyEntry(address));
      } catch {
        // unparseable address / unreadable stream: skip
      }
    }

    // Orphaned jobs: their variant is already absent from state, so there is nothing to mutate
    // under the lock — just reclaim the job/log/cache files left behind.
    for (const job of orphanedJobs) {
      let removedAny = false;
      for (const p of job.paths) {
        if (await removePathSafely(p)) removedAny = true;
      }
      if (await jobManager.deleteJob(job.variantId)) removedAny = true;
      if (removedAny) removedJobs.push(job);
    }

    // Spent provisioning jobs: a job record and its log, nothing in state to mutate. The record
    // goes under a compare-and-delete — the confirmation prompt above can sit for as long as a
    // human takes, and a `generate` in that window resets one of these records or hangs a new
    // dependent off it; deleting the prerequisite then fails that dependent with "it was cleaned".
    for (const job of spentProvisioningJobs) {
      const deleted = await jobManager.deleteJobIf(
        job.jobId,
        (current, list) =>
          isJobTerminal(current.status) &&
          !list().some(
            (j) => !isJobTerminal(j.status) && (j.dependsOnJobs ?? []).includes(job.jobId),
          ),
      );
      if (!deleted) continue;
      for (const p of job.paths) await removePathSafely(p);
      removedProvisioningJobs.push(job);
    }

    // Orphaned patch leftovers. An "output" one still has a state row, so drop that under the
    // lock before reclaiming its files; a "script" one is a bare file.
    const strandedOutputs = orphanedPatches.filter(
      (p): p is OrphanedPatch & { address: string } => p.kind === "output" && p.address !== null,
    );
    // A patch applied since the survey could have reserved one of these ids, or added a child to a
    // lineage being pruned. Re-check both on a fresh listing under the lock and skip whatever is
    // no longer safe, rather than deleting a live job's variant or re-orphaning its ancestors.
    const skippedPatches = new Set<string>();
    // Descendants that only appeared under the lock. Their files are reclaimed alongside the
    // surveyed ones below — removing the state row without them would leave the bytes behind.
    const lateDescendants: Array<{ address: string; variantId: string }> = [];
    if (strandedOutputs.length > 0) {
      await StateManager.withLock(videoRoot, async (mgr) => {
        const stillActive = activeGenerationVariantIds(await jobManager.listJobs());
        const fresh = mgr.getRecordedState();
        const surveyed = new Set(strandedOutputs.map((p) => p.variantId));
        for (const patch of strandedOutputs) {
          const lineage = [
            patch.variantId,
            ...collectDescendants(fresh, patch.address, patch.variantId),
          ];
          if (lineage.some((id) => stillActive.has(id))) {
            skippedPatches.add(patch.variantId);
            skippedActivePatches.push(`${patch.address} ${patch.variantId}`);
            continue;
          }
          // Remove the whole lineage as it stands NOW, not just the surveyed id: a child added
          // since the survey would otherwise outlive its parent with a dangling `derivedFrom`.
          for (const id of lineage) {
            if (!fresh.assets[patch.address]?.variants?.[id]) continue;
            mgr.removeVariant(patch.address, id);
            if (!surveyed.has(id)) lateDescendants.push({ address: patch.address, variantId: id });
          }
        }
      });
    }
    for (const late of lateDescendants) {
      orphanedPatches.push({
        variantId: late.variantId,
        kind: "output",
        address: late.address,
        paths: [
          patchFilePath(videoRoot, late.variantId),
          path.join(videoRoot, KONTE_DIR, LOGS_DIR, `${late.variantId}.log`),
          path.join(videoRoot, KONTE_DIR, CACHE_DIR, AUDIO_DIR, late.variantId),
          path.join(videoRoot, KONTE_DIR, CACHE_DIR, MOTION_DIR, late.variantId),
          variantDir(videoRoot, late.address, late.variantId),
        ],
      });
    }
    for (const patch of orphanedPatches) {
      if (skippedPatches.has(patch.variantId)) continue;
      let removedAny = false;
      for (const p of patch.paths) {
        if (await removePathSafely(p)) removedAny = true;
      }
      if (await jobManager.deleteJob(patch.variantId)) removedAny = true;
      if (removedAny) removedPatches.push(patch);
    }

    // Re-listed under the lock: a writer lays out a variant's directory before the save that
    // records it, holding the lock across both, so a directory stray at the survey may be a
    // registration that has landed since.
    if (strayVariantDirs.length > 0) {
      const stillStray = await StateManager.withLock(
        videoRoot,
        async (mgr) => new Set(await listStrayVariantDirs(videoRoot, mgr.getRecordedState())),
      );
      const parents = new Set<string>();
      for (const dir of strayVariantDirs) {
        if (!stillStray.has(dir)) continue;
        if (await removePathSafely(path.join(videoRoot, dir))) removedStrayDirs.push(dir);
        for (let parent = path.dirname(dir); parent !== "assets"; parent = path.dirname(parent)) {
          parents.add(parent);
        }
      }
      for (const dir of [...parents].sort((a, b) => b.length - a.length)) {
        await removeIfEmpty(path.join(videoRoot, dir));
      }
    }
  }

  // Cascade-fail pending jobs whose dependencies were pruned
  const cascadeFailed: CascadeFailedJob[] = await cascadeFailPendingJobs(
    videoRoot,
    removed.map((r) => r.address),
    allJobs,
    jobManager,
    { dryRun: opts.dryRun },
  );

  const totalCount = removed.length + cascadeFailed.length;
  const cacheCount = removedCompositionCaches.length;
  const feedbackOnlyCount = removedFeedbackOnly.length;
  const jobCount = removedJobs.length;

  if (
    totalCount === 0 &&
    cacheCount === 0 &&
    feedbackOnlyCount === 0 &&
    jobCount === 0 &&
    removedProvisioningJobs.length === 0 &&
    removedPatches.length === 0 &&
    removedStrayDirs.length === 0
  ) {
    if (skippedActive.length > 0 || skippedActivePatches.length > 0) {
      const held = [...skippedActive, ...skippedActivePatches];
      console.log(
        `Nothing to prune. Skipped ${held.length} leftover(s) with an active job: ${held.join(", ")} — retry once it settles.`,
      );
    } else {
      console.log("Nothing to prune.");
    }
    return;
  }

  const label = opts.dryRun ? "Would prune" : "Pruned";
  for (const entry of removed) {
    const parts = [`${entry.variantCount} variant(s)`];
    if (entry.feedbackCount > 0) parts.push(`${entry.feedbackCount} feedback`);
    console.log(`${label}: ${entry.address} (${parts.join(", ")})`);
  }
  for (const entry of cascadeFailed) {
    console.log(`${label}: ${entry.address} ${entry.variantId} (${entry.status})`);
  }
  for (const dir of removedCompositionCaches) {
    console.log(`${label}: ${path.resolve(videoRoot, dir)} (composition cache)`);
  }
  for (const entry of removedFeedbackOnly) {
    console.log(`${label}: ${entry.address} (${entry.feedbackCount} feedback)`);
  }
  for (const job of removedJobs) {
    console.log(`${label}: ${job.address} ${job.variantId} (orphaned job)`);
  }
  for (const job of removedProvisioningJobs) {
    console.log(`${label}: ${job.jobId} ${job.label} (spent provisioning job)`);
  }
  for (const patch of removedPatches) {
    const what = patch.kind === "script" ? "orphaned patch script" : "patch output with no script";
    console.log(`${label}: ${patch.address ?? "-"} ${patch.variantId} (${what})`);
  }
  for (const dir of removedStrayDirs) {
    console.log(`${label}: ${dir} (stray variant directory)`);
  }
  const summaryParts: string[] = [];
  if (totalCount > 0) {
    summaryParts.push(
      `${removed.length} orphaned target(s)${cascadeFailed.length > 0 ? ` (${cascadeFailed.length} pending job(s) cascade-failed)` : ""}`,
    );
  }
  if (cacheCount > 0) summaryParts.push(`${cacheCount} orphaned composition cache(s)`);
  if (feedbackOnlyCount > 0) summaryParts.push(`${feedbackOnlyCount} orphaned feedback target(s)`);
  if (jobCount > 0) summaryParts.push(`${jobCount} orphaned job(s)`);
  if (removedProvisioningJobs.length > 0)
    summaryParts.push(`${removedProvisioningJobs.length} spent provisioning job(s)`);
  if (removedPatches.length > 0)
    summaryParts.push(`${removedPatches.length} orphaned patch leftover(s)`);
  if (removedStrayDirs.length > 0)
    summaryParts.push(`${removedStrayDirs.length} stray variant director(ies)`);
  console.log(`\n${label} ${summaryParts.join(", ")}.`);
  if (skippedActive.length > 0) {
    console.log(
      `Skipped ${skippedActive.length} orphaned target(s) with an active job: ${skippedActive.join(", ")} — retry once it settles.`,
    );
  }
  if (skippedActivePatches.length > 0) {
    console.log(
      `Skipped ${skippedActivePatches.length} patch leftover(s) whose lineage has an active job: ${skippedActivePatches.join(", ")} — retry once it settles.`,
    );
  }
  if (skippedHosting.length > 0) {
    console.log(
      `Skipped ${skippedHosting.length} orphaned target(s) still holding a live variant's file: ${skippedHosting.join(", ")} — widen the scope to take both.`,
    );
  }
}

export function registerPruneCommand(program: Command): void {
  program
    .command("prune [address-scope]")
    .description("Purge orphaned targets and jobs no longer present in the definition or state")
    .option("--dry-run", "Preview what would be deleted without actually deleting")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--no", "Abort without prompting (treat confirmation as 'no')")
    .addHelpText(
      "after",
      `
Removes the orphaned leftovers \`konte doctor\` surfaces, plus job records nothing needs:
  - orphaned targets: an address no longer in the definition (e.g. after deleting a
    shot/asset from video.tsx) — the entire target goes: every variant (including
    accepted), its feedback, generated files, and the state entry
  - orphaned jobs: a job file whose variant is already gone from state, left behind with
    its logs and caches (active jobs are never touched)
  - spent provisioning jobs: settled comfy model-download / node-install / node-activate
    records nothing pending depends on. They hold no state — the next run that needs the
    model or pack recreates the job and re-checks the server — so this is history, dropped
    once it is only clutter in \`job list\`. Unscoped runs only: they have no address.
  - stray variant directories: a variant directory under assets/ that no state row records —
    a registration that died before its save, or a variant another checkout deleted.
    Unscoped runs only.

The optional address-scope argument filters which orphaned leftovers are pruned:
  omitted                  Prune all orphaned leftovers
  <address-scope>          Prune only those matching the prefix

Examples:
  konte prune                            Prune all orphaned leftovers
  konte prune --dry-run                  Preview what would be deleted
  konte prune video                      Prune orphaned video targets/jobs
  konte prune animatic:shot.01         Prune orphaned leftovers under shot 01`,
    )
    .action(async (addressScope: string | undefined, opts) => {
      await executePrune({ addressScope, ...opts });
    });
}
