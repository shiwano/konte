import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  addressToCacheSegments,
  matchesAddressScope,
  parseAddress,
  parseAddressStream,
} from "../../core/address.js";
import { FeedbackManager, listAllFeedback } from "../../core/feedback/index.js";
import { isJobTerminal, type JobManager } from "../../core/job-manager.js";
import type {
  AnimaticDefinition,
  JobRecord,
  KonteState,
  ReferenceDefinition,
  VideoDefinition,
} from "../../core/types/index.js";
import { buildOrphanContext, listStrayVariantDirs } from "../../core/orphans.js";
import { StateManager } from "../../core/state/index.js";
import { activeGenerationVariantIds, patchFilePath } from "../../core/patch.js";
import { prerollVariantDir } from "../../core/preview-preroll.js";
import {
  assetDir,
  patchBucketDir,
  patchChainDir,
  variantDir,
  variantsHostedBy,
} from "../../core/variant-dir.js";
import { collectDescendants } from "../../core/variant-lineage.js";
import { removePathSafely } from "./clean-utils.js";

const KONTE_DIR = ".konte";
const CACHE_DIR = "cache";
const LOGS_DIR = "logs";
const THUMBNAILS_DIR = "thumbnails";
const AUDIO_DIR = "audio";
const MOTION_DIR = "motion";

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

type OrphanedTarget = {
  address: string;
  variantIds: string[];
  acceptedCount: number;
  hasFeedback: boolean;
  paths: string[];
};

type OrphanedJob = {
  variantId: string;
  address: string;
  paths: string[];
};

// A settled comfy provisioning job (model download, node install, node activation).
type SpentProvisioningJob = {
  jobId: string;
  label: string;
  paths: string[];
};

// A patch script whose source variant is gone from state, or a patch output whose script is gone.
// Normally neither can happen — clean and `patch remove` take the pair together — so these are the
// leftovers of a hand-deleted file or an interrupted run.
type OrphanedPatch = {
  variantId: string;
  kind: "script" | "output";
  address: string | null;
  paths: string[];
};

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

function variantAssetPaths(videoRoot: string, address: string, variantId: string): string[] {
  try {
    return [
      variantDir(videoRoot, address, variantId),
      path.join(
        videoRoot,
        KONTE_DIR,
        CACHE_DIR,
        THUMBNAILS_DIR,
        ...addressToCacheSegments(address),
        variantId,
      ),
    ];
  } catch {
    // unparseable address: no asset or thumbnail dir to name
    return [];
  }
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch {
    // directory is non-empty or does not exist
  }
}

// What an orphaned address is judged against. Null when a stage entry does not load: an unreadable
// reference.tsx must never read as "every reference target is undeclared".
export type OrphanDefinitions = {
  video: VideoDefinition;
  animatic: AnimaticDefinition | null;
  reference: ReferenceDefinition | null;
  directionParts: string[];
};

export type OrphanPlan = {
  targets: OrphanedTarget[];
  feedbackOnly: string[];
  jobs: OrphanedJob[];
  provisioningJobs: SpentProvisioningJob[];
  patches: OrphanedPatch[];
  strayDirs: string[];
  keptForAccepted: string[];
  skippedActive: string[];
  skippedActivePatches: string[];
  skippedHosting: string[];
};

export type OrphanCounts = {
  targets: number;
  feedbackOnly: number;
  jobs: number;
  provisioningJobs: number;
  patches: number;
  strayDirs: number;
};

const ORPHAN_LABELS: Record<keyof OrphanCounts, string> = {
  targets: "orphaned target",
  feedbackOnly: "orphaned feedback target",
  jobs: "orphaned job",
  provisioningJobs: "spent provisioning job",
  patches: "orphaned patch leftover",
  strayDirs: "stray variant directory",
};

const ORPHAN_PLURALS: Record<keyof OrphanCounts, string> = {
  targets: "orphaned target(s)",
  feedbackOnly: "orphaned feedback target(s)",
  jobs: "orphaned job(s)",
  provisioningJobs: "spent provisioning job(s)",
  patches: "orphaned patch leftover(s)",
  strayDirs: "stray variant director(ies)",
};

// One `<count> <class>` per non-zero class, for a line that names what went.
export function orphanSubjects(counts: OrphanCounts): string[] {
  return (Object.keys(ORPHAN_PLURALS) as (keyof OrphanCounts)[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${ORPHAN_PLURALS[key]}`);
}

export function orphanCounts(plan: OrphanPlan): OrphanCounts {
  return {
    targets: plan.targets.length,
    feedbackOnly: plan.feedbackOnly.length,
    jobs: plan.jobs.length,
    provisioningJobs: plan.provisioningJobs.length,
    patches: plan.patches.length,
    strayDirs: plan.strayDirs.length,
  };
}

export function orphanBreakdown(counts: OrphanCounts): { label: string; count: number }[] {
  return (Object.keys(ORPHAN_LABELS) as (keyof OrphanCounts)[]).map((key) => ({
    label: ORPHAN_LABELS[key],
    count: counts[key],
  }));
}

export function orphanTotal(counts: OrphanCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

// Every path the plan deletes, for the confirmation's size.
export function orphanPlanPaths(videoRoot: string, plan: OrphanPlan): string[] {
  return [
    ...plan.targets.flatMap((t) => t.paths),
    ...plan.jobs.flatMap((j) => j.paths),
    ...plan.provisioningJobs.flatMap((j) => j.paths),
    ...plan.patches.flatMap((p) => p.paths),
    ...plan.strayDirs.map((dir) => path.join(videoRoot, dir)),
  ];
}

// The variants the plan takes, keyed `<address> <variantId>`, so the per-variant pass leaves them
// to it.
export function orphanVariantKeys(plan: OrphanPlan): Set<string> {
  const keys = new Set<string>();
  for (const target of plan.targets) {
    for (const id of target.variantIds) keys.add(`${target.address} ${id}`);
  }
  for (const patch of plan.patches) {
    if (patch.kind === "output" && patch.address) keys.add(`${patch.address} ${patch.variantId}`);
  }
  return keys;
}

export async function collectOrphans(opts: {
  videoRoot: string;
  manager: StateManager;
  state: KonteState;
  definitions: OrphanDefinitions | null;
  patchScriptIds: ReadonlySet<string>;
  addressScope?: string;
  allJobs: JobRecord[];
  activeJobVariantIds: ReadonlySet<string>;
}): Promise<OrphanPlan> {
  const { videoRoot, manager, state, definitions, patchScriptIds, allJobs, activeJobVariantIds } =
    opts;
  const inScope = (addr: string) =>
    !opts.addressScope || matchesAddressScope(addr, opts.addressScope);

  const plan: OrphanPlan = {
    targets: [],
    feedbackOnly: [],
    jobs: [],
    provisioningJobs: [],
    patches: [],
    strayDirs: [],
    keptForAccepted: [],
    skippedActive: [],
    skippedActivePatches: [],
    skippedHosting: [],
  };

  // `isOrphan` is shared with `doctor` so clean and its warning never disagree on what an orphan is.
  let scoped: string[] = [];
  const feedbackAddresses = new Set<string>();
  if (definitions) {
    const { isOrphan, acceptedMadeFrom } = buildOrphanContext(
      definitions.video,
      definitions.animatic,
      definitions.reference,
      patchScriptIds,
      state,
      definitions.directionParts,
    );
    scoped = Object.keys(state.assets).filter(isOrphan).filter(inScope);
    // Undeclared, yet what an accepted take was made from: kept, and said so.
    plan.keptForAccepted = Object.keys(state.assets)
      .filter(inScope)
      .filter((address) => acceptedMadeFrom(address).length > 0);

    // Feedback attached to an address that is no longer a state asset AND is orphaned by the
    // definition (e.g. whole-shot notes on a shot deleted from direction).
    for (const { address } of await listAllFeedback(videoRoot)) feedbackAddresses.add(address);
    plan.feedbackOnly = [...feedbackAddresses].filter(
      (addr) => !state.assets[addr] && isOrphan(addr) && inScope(addr),
    );
  }

  // Orphaned jobs: generation job files whose (address, variant) no longer exists in state. Active
  // jobs are skipped: `reserveVariants` records a variant before its job is created, and deleting a
  // live job's files would strand a backend job.
  for (const job of allJobs) {
    if (job.kind !== "generation") continue;
    if (state.assets[job.address]?.variants?.[job.variantId]) continue;
    if (activeJobVariantIds.has(job.variantId)) continue;
    if (!inScope(job.address)) continue;
    plan.jobs.push({
      variantId: job.variantId,
      address: job.address,
      paths: [
        ...variantLeftoverPaths(videoRoot, job.variantId).filter(
          (p) => p !== patchFilePath(videoRoot, job.variantId),
        ),
        ...variantAssetPaths(videoRoot, job.address, job.variantId),
      ],
    });
  }

  // Spent provisioning jobs. Scoped runs skip them: a provisioning job has no address.
  if (!opts.addressScope) {
    // A live job's dependency is off limits even when the dependency itself has settled: the
    // dependent reads it back to decide whether it may run, and a missing one fails it outright.
    const dependedOn = new Set(
      allJobs.filter((j) => !isJobTerminal(j.status)).flatMap((j) => j.dependsOnJobs ?? []),
    );
    for (const job of allJobs) {
      if (!isProvisioningJob(job) || !isJobTerminal(job.status)) continue;
      if (dependedOn.has(job.id)) continue;
      plan.provisioningJobs.push({
        jobId: job.id,
        label: provisioningLabel(job),
        paths: [path.join(videoRoot, KONTE_DIR, LOGS_DIR, `${job.id}.log`)],
      });
    }
  }

  // Orphaned patches, both directions. A script whose source variant is gone can never be applied
  // again; a variant whose script is gone can never be re-derived. Listing filenames is enough — no
  // module is imported, so a syntactically broken patch is still removable.
  for (const variantId of patchScriptIds) {
    if (manager.findVariantAddress(variantId) || manager.absentVariantIds().has(variantId))
      continue;
    // Its variant is gone, so its address is unknowable — a scoped run cannot tell whether it
    // belongs to the scope.
    if (opts.addressScope) continue;
    plan.patches.push({
      variantId,
      kind: "script",
      address: null,
      paths: [patchFilePath(videoRoot, variantId)],
    });
  }
  for (const [address, target] of Object.entries(state.assets)) {
    if (!inScope(address)) continue;
    // Expand each stranded output through its own descendants first: a lineage goes as a unit.
    const stranded = new Set<string>();
    for (const [variantId, variant] of Object.entries(target.variants ?? {})) {
      if (!variant.derivedFrom || patchScriptIds.has(variant.derivedFrom)) continue;
      stranded.add(variantId);
      for (const id of collectDescendants(state, address, variantId)) stranded.add(id);
    }
    // An active job anywhere in the lineage holds the whole lineage back.
    if ([...stranded].some((id) => activeJobVariantIds.has(id))) {
      if (stranded.size > 0) plan.skippedActivePatches.push(address);
      continue;
    }
    for (const variantId of stranded) {
      plan.patches.push({
        variantId,
        kind: "output",
        address,
        paths: [
          ...variantLeftoverPaths(videoRoot, variantId),
          ...variantAssetPaths(videoRoot, address, variantId),
        ],
      });
    }
  }

  // Unscoped runs only: a directory with no state row has no address a scope could match.
  plan.strayDirs = opts.addressScope ? [] : await listStrayVariantDirs(videoRoot, state);

  // An active job holds its whole target back, so those go first — a host must not read a variant
  // in a skipped target as "leaving anyway" and delete the file out from under it.
  const survivingAddresses = new Set<string>();
  for (const address of scoped) {
    const variants = state.assets[address]?.variants ?? {};
    if (Object.keys(variants).some((vid) => activeJobVariantIds.has(vid))) {
      plan.skippedActive.push(address);
      survivingAddresses.add(address);
    }
  }
  // Orphaned targets held back because a variant elsewhere still points at a file inside one of
  // theirs — a patched take, whose file is the chain's returned step's. Held back to a fixpoint:
  // keeping one target can be what makes another a host of a survivor.
  const removedVariantKeys = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    removedVariantKeys.clear();
    for (const address of scoped) {
      if (survivingAddresses.has(address)) continue;
      for (const vid of Object.keys(state.assets[address]?.variants ?? {})) {
        removedVariantKeys.add(`${address} ${vid}`);
      }
    }
    for (const patch of plan.patches) {
      if (patch.kind === "output" && patch.address && !survivingAddresses.has(patch.address)) {
        removedVariantKeys.add(`${patch.address} ${patch.variantId}`);
      }
    }
    for (const address of scoped) {
      if (survivingAddresses.has(address)) continue;
      const stillPointing = Object.keys(state.assets[address]?.variants ?? {})
        .flatMap((vid) => variantsHostedBy(state, address, vid))
        .filter((ref) => !removedVariantKeys.has(`${ref.address} ${ref.variantId}`));
      if (stillPointing.length === 0) continue;
      survivingAddresses.add(address);
      plan.skippedHosting.push(address);
      changed = true;
    }
  }

  for (const address of scoped) {
    const target = state.assets[address];
    if (!target || survivingAddresses.has(address)) continue;
    const variantIds = Object.keys(target.variants ?? {});
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
    for (const variantId of variantIds) paths.push(...variantLeftoverPaths(videoRoot, variantId));
    plan.targets.push({
      address,
      variantIds,
      acceptedCount: variantIds.filter((id) => target.variants?.[id]?.status === "accepted").length,
      hasFeedback: feedbackAddresses.has(address),
      paths,
    });
  }
  // A patch output inside a target that goes whole is the target's.
  const targetAddresses = new Set(plan.targets.map((t) => t.address));
  plan.patches = plan.patches.filter((p) => !p.address || !targetAddresses.has(p.address));

  return plan;
}

// Deletes what the plan names, re-checking each guard under the lock. Returns what was removed and
// adds to the plan's skip lists what a concurrent writer put out of reach since the survey.
export async function removeOrphans(opts: {
  videoRoot: string;
  plan: OrphanPlan;
  definitions: OrphanDefinitions | null;
  patchScriptIds: ReadonlySet<string>;
  jobManager: JobManager;
}): Promise<{ counts: OrphanCounts; removedAddresses: string[] }> {
  const { videoRoot, plan, definitions, patchScriptIds, jobManager } = opts;
  const counts: OrphanCounts = {
    targets: 0,
    feedbackOnly: 0,
    jobs: 0,
    provisioningJobs: 0,
    patches: 0,
    strayDirs: 0,
  };
  const removedAddresses: string[] = [];

  if (plan.targets.length > 0 && definitions) {
    const confirmedTargets = await StateManager.withLock(videoRoot, async (mgr) => {
      const toRemove: OrphanedTarget[] = [];
      // The confirmation prompt sat open for as long as a human took; a `generate` in that window
      // may have reserved a new variant on one of these targets and put its job in flight.
      const freshActive = activeGenerationVariantIds(await jobManager.listJobs());
      // An accept in that window can make a target what an accepted take was made from.
      const fresh = buildOrphanContext(
        definitions.video,
        definitions.animatic,
        definitions.reference,
        patchScriptIds,
        mgr.getRecordedState(),
        definitions.directionParts,
      );
      for (const entry of plan.targets) {
        const target = mgr.getRecordedState().assets[entry.address];
        if (!target) continue;
        const variantIds = Object.keys(target.variants ?? {});
        if (variantIds.some((id) => freshActive.has(id))) {
          plan.skippedActive.push(entry.address);
          continue;
        }
        if (fresh.acceptedMadeFrom(entry.address).length > 0) {
          plan.keptForAccepted.push(entry.address);
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

    const dirsToCheck = new Set<string>();
    for (const entry of confirmedTargets) {
      for (const p of entry.paths) await removePathSafely(p);
      for (const variantId of entry.variantIds) await jobManager.deleteJob(variantId);
      try {
        const parsed = parseAddress(entry.address);
        if (entry.hasFeedback) {
          await FeedbackManager.withLock(videoRoot, parsed.stage, async (fbMgr) => {
            fbMgr.removeAddress(entry.address);
          });
        }
        // best-effort: collapse now-empty stage directories. A patch step sits two levels deeper
        // (`patch/<vid>/<name>`), so its chain and the stage's patch bucket are collapsible too.
        dirsToCheck.add(path.join(videoRoot, "assets", parsed.stage));
        if (parsed.kind === "patch") {
          dirsToCheck.add(patchChainDir(videoRoot, parsed.stage, parsed.sourceVariantId));
          dirsToCheck.add(patchBucketDir(videoRoot, parsed.stage));
        }
      } catch {
        // unparseable address: no feedback stream or directory to touch
      }
      removedAddresses.push(entry.address);
      counts.targets += 1;
    }
    for (const dir of [...dirsToCheck].sort((a, b) => b.length - a.length)) {
      await removeIfEmpty(dir);
    }
  }

  // Feedback-only orphans: drop their stream entries. Their frames cache in the shot composition's
  // dir, which the composition-cache pass owns.
  for (const address of plan.feedbackOnly) {
    try {
      const { stage } = parseAddressStream(address);
      await FeedbackManager.withLock(videoRoot, stage, (fbMgr) =>
        Promise.resolve(fbMgr.removeAddress(address)),
      );
      counts.feedbackOnly += 1;
    } catch {
      // unparseable address / unreadable stream: skip
    }
  }

  // Orphaned jobs: their variant is already absent from state, so there is nothing to mutate under
  // the lock.
  for (const job of plan.jobs) {
    let removedAny = false;
    for (const p of job.paths) {
      if (await removePathSafely(p)) removedAny = true;
    }
    if (await jobManager.deleteJob(job.variantId)) removedAny = true;
    if (removedAny) counts.jobs += 1;
  }

  // Spent provisioning jobs go under a compare-and-delete: a `generate` while the confirmation sat
  // open may have reset one of these records or hung a new dependent off it.
  for (const job of plan.provisioningJobs) {
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
    counts.provisioningJobs += 1;
  }

  // Orphaned patch leftovers. An "output" one still has a state row, so drop that under the lock
  // before reclaiming its files; a "script" one is a bare file.
  const patches = [...plan.patches];
  const strandedOutputs = patches.filter(
    (p): p is OrphanedPatch & { address: string } => p.kind === "output" && p.address !== null,
  );
  const skippedPatches = new Set<string>();
  // A take whose media is absent from this checkout leaves no file to remove; its row is the removal.
  const rowsRemoved = new Set<string>();
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
          plan.skippedActivePatches.push(patch.variantId);
          continue;
        }
        // Remove the whole lineage as it stands NOW: a child added since the survey would otherwise
        // outlive its parent with a dangling `derivedFrom`.
        for (const id of lineage) {
          if (!fresh.assets[patch.address]?.variants?.[id]) continue;
          mgr.removeVariant(patch.address, id);
          rowsRemoved.add(id);
          if (surveyed.has(id)) continue;
          patches.push({
            variantId: id,
            kind: "output",
            address: patch.address,
            paths: [
              ...variantLeftoverPaths(videoRoot, id),
              ...variantAssetPaths(videoRoot, patch.address, id),
            ],
          });
        }
      }
    });
  }
  for (const patch of patches) {
    if (skippedPatches.has(patch.variantId)) continue;
    let removedAny = rowsRemoved.has(patch.variantId);
    for (const p of patch.paths) {
      if (await removePathSafely(p)) removedAny = true;
    }
    if (await jobManager.deleteJob(patch.variantId)) removedAny = true;
    if (removedAny) counts.patches += 1;
  }

  // Re-listed under the lock: a writer lays out a variant's directory before the save that records
  // it, so a directory stray at the survey may be a registration that has landed since.
  if (plan.strayDirs.length > 0) {
    const stillStray = await StateManager.withLock(
      videoRoot,
      async (mgr) => new Set(await listStrayVariantDirs(videoRoot, mgr.getRecordedState())),
    );
    const parents = new Set<string>();
    for (const dir of plan.strayDirs) {
      if (!stillStray.has(dir)) continue;
      if (await removePathSafely(path.join(videoRoot, dir))) counts.strayDirs += 1;
      for (let parent = path.dirname(dir); parent !== "assets"; parent = path.dirname(parent)) {
        parents.add(parent);
      }
    }
    for (const dir of [...parents].sort((a, b) => b.length - a.length)) {
      await removeIfEmpty(path.join(videoRoot, dir));
    }
  }

  return { counts, removedAddresses };
}
