import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import {
  assertValidAddressScope,
  isCompositionAddress,
  matchesAddressScope,
  patchSourceVariantIdOf,
} from "../../core/address.js";
import {
  collectDeadCompositionVariants,
  collectDeadStemVariants,
} from "../../core/composition-resource.js";
import {
  listPatchVariantIds,
  loadPatchCatalog,
  patchAssetAddress,
  patchStepEntries,
} from "../../core/patch.js";
import { listThumbnailAddressDirs } from "../../core/variant-thumbnails.js";
import { activeGenerationVariantIds } from "../../core/job-index.js";
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
  variantPaths,
} from "./clean-orphans.js";
import {
  CLEAN_CATEGORIES,
  type CleanCategory,
  KEEP_REASONS,
  type KeepReason,
  type PatchStepPolicy,
  planClean,
} from "./clean-plan.js";
import { type CascadeFailedJob, cascadeFailPendingJobs } from "../../core/job-cascade.js";
import { contactSheetDir } from "../../core/contact-sheet.js";
import { requireVideoRoot, requireWorkspaceRoot } from "../context.js";
import { listVideos, VIDEOS_DIR } from "../../core/roots.js";
import { declareScope } from "../scope.js";
import { currentPoolVariant } from "../patch-orchestrator.js";

const KONTE_DIR = ".konte";
const CACHE_DIR = "cache";
const THUMBNAILS_DIR = "thumbnails";

const CATEGORY_LABELS: Record<CleanCategory, string> = {
  failed: "failed",
  cancelled: "cancelled",
  incomplete: "incomplete (no media)",
  "dead leftover": "dead leftover",
  dismissed: "dismissed (has media)",
  stale: "stale beside a current accept (has media)",
  "unused patch step": "patch step nothing kept uses (has media)",
  undecided: "undecided (has media)",
};

const KEEP_REASON_LABELS: Record<KeepReason, string> = {
  "made-from": "an accepted take was made from it",
  "accepted-patch-source": "source of an accepted patch",
  generating: "generating",
  "patch-applying": "has a patch applying",
  undecided: "undecided take holding generated media",
  "file-host": "holds the file of a kept take",
  "kept-patch-source": "source of a kept patch",
  "reusable-patch-step": "patch step the next apply reuses",
  "patch-step-input": "input of a kept take",
  reclassified: "no longer deletable for the reason confirmed",
};

type CleanedVariant = {
  address: string;
  category: CleanCategory;
};

type CleanResult = {
  removed: CleanedVariant[];
  removedCompositionCaches: string[];
  removedContactSheets: string[];
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

async function loadPatchStepPolicy(
  videoRoot: string,
  manager: StateManager,
  absent: ReadonlySet<string>,
): Promise<PatchStepPolicy> {
  const state = manager.getState();
  let catalog: Awaited<ReturnType<typeof loadPatchCatalog>>;
  try {
    catalog = await loadPatchCatalog(videoRoot, state, absent);
  } catch {
    return { reusable: new Set(), unloadedSources: "all" };
  }
  const reusable = new Set<string>();
  for (const patch of catalog.patches.values()) {
    const source = state.assets[patch.sourceAddress]?.variants?.[patch.sourceVariantId];
    if (!source) continue;
    // The returned step runs again on every apply, so its take is never reused.
    for (const [name, def] of patchStepEntries(patch)) {
      if (name === patch.outputName) continue;
      const address = patchAssetAddress(patch, name);
      const current = currentPoolVariant(manager, address, def, {
        address: patch.sourceAddress,
        variant: source,
      });
      if (current) reusable.add(`${address} ${current.variantId}`);
    }
  }
  return {
    reusable,
    unloadedSources: new Set(catalog.errors.map((e) => e.sourceVariantId)),
  };
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

// Both composition stages carry leaves, so both leave leftovers behind.
function deadLeafKeysOf(
  manager: StateManager,
  defs: Array<VideoDefinition | AnimaticDefinition | null>,
): Set<string> {
  const keys = new Set<string>();
  for (const def of defs) {
    if (!def) continue;
    for (const { address, variantId } of [
      ...collectDeadCompositionVariants(manager, def),
      ...collectDeadStemVariants(manager, def),
    ]) {
      keys.add(`${address} ${variantId}`);
    }
  }
  return keys;
}

function countByCategory(entries: { category: CleanCategory }[]): Record<CleanCategory, number> {
  const counts = Object.fromEntries(CLEAN_CATEGORIES.map((c) => [c, 0])) as Record<
    CleanCategory,
    number
  >;
  for (const entry of entries) counts[entry.category] += 1;
  return counts;
}

async function executeClean(videoRoot: string, opts: CleanOptions): Promise<void> {
  const manager = await StateManager.load(videoRoot);
  // Lineage is judged on the recorded state: an absent child still holds its parent. Only
  // --delete-undecided makes an absent variant a candidate — left out, it would be a state row
  // nothing can ever remove once no checkout holds its media.
  const state = manager.getRecordedState();
  const absent = opts.deleteUndecided ? new Set<string>() : manager.absentVariantIds();

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
  let deadLeafKeys = new Set<string>();
  try {
    loaded = await loadDefinitions(videoRoot, manager);
    ({ video, animatic, complete: definitionsComplete } = loaded);
    deadLeafKeys = deadLeafKeysOf(manager, [video, animatic]);
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
  // Contact sheets are keyed by the invocation that drew them, not by an address.
  const contactSheetFiles = opts.addressScope ? [] : await listContactSheetFiles(videoRoot);
  const contactSheets = contactSheetFiles.filter(isSheetImage);

  const jobManager = new JobManager(videoRoot);
  const allJobs = await jobManager.listJobs();
  const activeJobVariantIds = activeGenerationVariantIds(allJobs);

  // Orphaned targets go whole, accepted takes included — judged only on stage files that all load.
  const orphanDefs = await loadOrphanDefinitions(videoRoot, loaded);
  const definitions = "unloaded" in orphanDefs ? null : orphanDefs;
  const patchScriptIds = new Set(await listPatchVariantIds(videoRoot));
  const stepPolicy = await loadPatchStepPolicy(videoRoot, manager, manager.absentVariantIds());
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
  const stalenessCache = manager.stalenessCache();
  const firstPlan = planClean({
    state,
    addresses: filteredAddresses,
    absent,
    leaving: leftToOrphans,
    deadLeaves: deadLeafKeys,
    isStaleLeftover: (address, variantId) =>
      definitionsComplete &&
      isStaleBesideCurrentAccept(manager, address, variantId, stalenessCache),
    stepPolicy,
    activeJobVariantIds,
    deleteUndecided: !!opts.deleteUndecided,
  });
  const collected = firstPlan.remove;
  const kept: KeepReason[] = [...firstPlan.kept];

  const categoryCounts = countByCategory(collected);

  // Confirmation is required for the actual deletion: an output format is an
  // output format, not a consent. Skipped only for --dry-run, which deletes nothing. --yes still
  // enters the call — it consents without prompting, but the summary is disclosed. Non-TTY
  // without --yes/--no fails CONFIRMATION_REQUIRED inside confirmAction.
  if (
    (collected.length > 0 ||
      compositionCaches.length > 0 ||
      contactSheetFiles.length > 0 ||
      orphanTotal(planned) > 0) &&
    !opts.dryRun
  ) {
    let totalSize = 0;
    for (const p of [
      ...collected.flatMap((c) => variantPaths(videoRoot, c.address, c.variantId)),
      ...compositionCaches,
      ...contactSheetFiles,
      ...orphanPlanPaths(videoRoot, plan),
    ]) {
      totalSize += await getPathSize(p);
    }
    const acceptedOrphans = plan.targets.reduce((n, t) => n + t.acceptedCount, 0);
    const confirmed = await confirmDeletion({
      subjects: summarySubjects(
        collected.length,
        compositionCaches.length,
        contactSheets.length,
        planned,
      ),
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
  const result: CleanResult = {
    removed: [],
    removedCompositionCaches: [],
    removedContactSheets: [],
  };
  let removedOrphans: OrphanCounts = planned;
  let removedOrphanAddresses = plan.targets.map((t) => t.address);

  if (opts.dryRun) {
    for (const entry of collected) {
      result.removed.push({ address: entry.address, category: entry.category });
    }
    result.removedCompositionCaches = [...compositionCaches];
    result.removedContactSheets = [...contactSheets];
  } else {
    ({ counts: removedOrphans, removedAddresses: removedOrphanAddresses } = await removeOrphans({
      videoRoot,
      plan,
      definitions,
      patchScriptIds,
      jobManager,
    }));

    if (collected.length > 0) {
      const confirmed = new Map(collected.map((c) => [`${c.address} ${c.variantId}`, c.category]));
      const lockPlan = await StateManager.withLock(videoRoot, async (mgr) => {
        // Judged again on what holds now: the confirmation prompt stands for as long as a human
        // takes. The DEFINITIONS are re-read too, reloaded, since a cached module would answer
        // with the definition the collection read. A stage that no longer loads keeps what it
        // would have decided.
        const fresh = await loadDefinitions(videoRoot, mgr, { reload: true }).catch(() => ({
          video,
          animatic,
          complete: false,
        }));
        const freshCache = mgr.stalenessCache();
        const judgesSteps =
          !opts.deleteUndecided && collected.some((c) => patchSourceVariantIdOf(c.address));
        const plan = planClean({
          state: mgr.getRecordedState(),
          addresses: [...new Set(collected.map((c) => c.address))],
          absent: opts.deleteUndecided ? new Set<string>() : mgr.absentVariantIds(),
          leaving: new Set(),
          only: confirmed,
          deadLeaves: deadLeafKeysOf(mgr, [fresh.video, fresh.animatic]),
          isStaleLeftover: (address, variantId) =>
            fresh.complete && isStaleBesideCurrentAccept(mgr, address, variantId, freshCache),
          stepPolicy: judgesSteps
            ? await loadPatchStepPolicy(videoRoot, mgr, mgr.absentVariantIds())
            : { reusable: new Set(), unloadedSources: "all" },
          activeJobVariantIds: activeGenerationVariantIds(await jobManager.listJobs()),
          deleteUndecided: !!opts.deleteUndecided,
        });
        for (const c of plan.remove) mgr.removeVariant(c.address, c.variantId);
        return plan;
      });

      kept.push(...lockPlan.kept);
      for (const entry of lockPlan.remove) {
        for (const p of variantPaths(videoRoot, entry.address, entry.variantId)) {
          await removePathSafely(p);
        }
        await jobManager.deleteJob(entry.variantId);
        result.removed.push({ address: entry.address, category: entry.category });
      }
    }

    for (const dir of compositionCaches) {
      if (await removePathSafely(dir)) result.removedCompositionCaches.push(dir);
    }
    for (const file of contactSheetFiles) {
      if ((await removePathSafely(file)) && isSheetImage(file)) {
        result.removedContactSheets.push(file);
      }
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
  const sheetCount = result.removedContactSheets.length;
  if (
    removedCount === 0 &&
    cacheCount === 0 &&
    sheetCount === 0 &&
    orphanTotal(removedOrphans) === 0
  ) {
    console.log("Nothing to clean.");
  } else {
    const subjects = opts.dryRun
      ? summarySubjects(removedCount, cacheCount, sheetCount, removedOrphans)
      : [
          ...summarySubjects(removedCount, cacheCount, sheetCount, null),
          ...orphanSubjects(removedOrphans),
        ];
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

async function listContactSheetFiles(videoRoot: string): Promise<string[]> {
  const dir = contactSheetDir(videoRoot);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.map((name) => path.join(dir, name));
}

function isSheetImage(file: string): boolean {
  return file.endsWith(".jpg");
}

// A headline the breakdown under it itemizes: one total for the orphaned leftovers.
function summarySubjects(
  variants: number,
  caches: number,
  sheets: number,
  orphans: OrphanCounts | null,
): string[] {
  const subjects: string[] = [];
  if (variants > 0) subjects.push(`${variants} variant(s)`);
  if (caches > 0) subjects.push(`${caches} composition cache(s)`);
  if (sheets > 0) subjects.push(`${sheets} contact sheet(s)`);
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
  const clean = program
    .command("clean [address-scope]")
    .description("Remove failed, dismissed and orphaned takes, and what they leave behind")
    .option("--delete-undecided", "Also delete undecided variants that hold generated media")
    .option("--dry-run", "Preview what would be deleted without actually deleting")
    .option("--all-videos", "Clean every video in the workspace")
    .option("--no", NO_FLAG_DESCRIPTION)
    .addHelpText(
      "after",
      `
Removes, freeing their generated files, jobs, logs and caches:
  - variants: failed/cancelled/dismissed ones, undecided takes gone stale beside an accept
    that is not, a patch step's take nothing kept uses and the next apply does not reuse,
    and dead composition/stem leftovers. Accepted variants are kept, and so is
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
  - contact sheets: every sheet a probe or review drew; the next one redraws it. Unscoped
    runs only.

What will be deleted is itemized by class, printed under -y too. Deletion is confirmed
first (-y to proceed, --no to abort). --all-videos confirms each video.

The optional address-scope argument narrows what is cleaned:
  omitted                  Clean across every stage
  <address-scope>          Clean only what matches the prefix

Examples:
  konte clean                            Clean everywhere
  konte clean video:shot.01              Clean only under shot 01
  konte clean --dry-run                  Preview what would be deleted
  konte clean --delete-undecided         Also discard undecided takes that hold media
  konte clean --all-videos -y            Clean every video in the workspace`,
    )
    .action(
      async (
        addressScope: string | undefined,
        { allVideos, ...opts }: Omit<CleanOptions, "addressScope"> & { allVideos?: boolean },
      ) => {
        if (!allVideos) {
          await executeClean(requireVideoRoot(), { addressScope, ...opts });
          return;
        }
        if (addressScope) assertValidAddressScope(addressScope);
        const workspaceRoot = requireWorkspaceRoot();
        const names = await listVideos(workspaceRoot);
        if (names.length === 0) {
          console.log(`This workspace has no videos.`);
          return;
        }
        for (const [i, name] of names.entries()) {
          console.log(`${i > 0 ? "\n" : ""}Video: ${name}`);
          await executeClean(path.join(workspaceRoot, VIDEOS_DIR, name), { addressScope, ...opts });
        }
      },
    );
  declareScope(clean, { scope: "workspace" });
}
