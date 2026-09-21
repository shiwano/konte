import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  formatPatchAssetPath,
  getAssetStage,
  parseAddress,
  patchSourceVariantIdOf,
  assetNameOf,
} from "./address.js";
import { computeDefinitionHash } from "./definition-hash.js";
import { collectShots } from "./direction.js";
import { resolveDirectionFormat } from "./dsl/direction.js";
import type { PatchBuild } from "./dsl/patch.js";
import type { BuildFormat } from "./dsl/shot-context.js";
import { KonteError, type KonteErrorCode, errorMessage } from "./errors.js";
import { extractRefs } from "./graph.js";
import { loadDirectionDefinition, loadIfPresent, reloadPatchDefinition } from "./loader.js";
import { computeVariantStaleness, type StalenessCache } from "./staleness.js";
import type {
  AssetDefinition,
  GenerationJob,
  JobRecord,
  KonteState,
  VariantState,
} from "./types/index.js";
import { mediaVisualSize } from "./variant-media.js";
import { stageEntryPath } from "./roots.js";

/**
 * Patches live at the video root, one file per patched variant, so the filename IS the source
 * variant id — which is what enforces "at most one patch script per take" without any bookkeeping.
 */
export function patchesDir(videoRoot: string): string {
  return path.resolve(videoRoot, "patches");
}

// A variant id is one path-safe segment. The id reaches `patchFilePath` straight from a CLI
// argument, and the result is passed to deletion — so anything that could escape `patches/`
// (a separator, `..`) is rejected here rather than trusted to the caller.
const VARIANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function patchFilePath(videoRoot: string, variantId: string): string {
  if (!VARIANT_ID_PATTERN.test(variantId)) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Invalid variant id "${variantId}": expected a single path-safe segment`,
    );
  }
  return path.join(patchesDir(videoRoot), `${variantId}.ts`);
}

/**
 * The hash of a patch's built chain — the second staleness axis for the variants it produced.
 * Hashing the parsed AssetDefinitions rather than the file's bytes means reformatting or editing a
 * comment does not age out a take and trigger a paid re-apply. Every step is hashed, not just the
 * output's: an edit anywhere in the chain changes what the correction produces.
 */
function computePatchHash(build: PatchBuild): string {
  const parts = Object.entries(build.assets)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, def]) => `${name}:${computeDefinitionHash(def)}`);
  parts.push(`=${build.outputName}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

export interface LoadedPatch extends PatchBuild {
  sourceVariantId: string;
  sourceAddress: string;
  filePath: string;
  patchHash: string;
}

/** The step whose take becomes the patched one — what the variant at the source's address points at. */
export function patchOutputDef(patch: PatchBuild): AssetDefinition {
  const def = patch.assets[patch.outputName];
  if (!def) {
    throw new KonteError(
      "PATCH_INVALID",
      `Patch output "${patch.outputName}" is not one of its declared steps`,
    );
  }
  return def;
}

/**
 * Every step in the order it must run: declaration order, with the returned step last. Declaration
 * order is dependency order, and nothing may consume the returned step, so the two agree — this
 * only makes the second part explicit rather than trusting the object's key order for it.
 */
export function patchStepEntries(patch: PatchBuild): Array<[string, AssetDefinition]> {
  const entries = Object.entries(patch.assets).filter(([name]) => name !== patch.outputName);
  entries.push([patch.outputName, patchOutputDef(patch)]);
  return entries;
}

/** The address of one step of a patch's chain. */
export function patchAssetAddress(patch: LoadedPatch, name: string): string {
  return formatPatchAssetPath(getAssetStage(patch.sourceAddress), patch.sourceVariantId, name);
}

/**
 * The addresses of the steps that consume this one. A chain step has no node in the stage
 * dependency graph, so this is where its downstream edges come from.
 */
export function patchStepDependents(patch: LoadedPatch, address: string): string[] {
  const out: string[] = [];
  for (const [name, def] of Object.entries(patch.assets)) {
    if (!extractRefs(def).includes(address)) continue;
    out.push(patchAssetAddress(patch, name));
  }
  return out;
}

/**
 * Every address a patch's chain declares — the live targets `prune` and `doctor` must not read as
 * orphans. The returned step is one of them: its take lands at its own address like any other, and
 * the patched variant at the source's address points at that file.
 */
function patchPoolAddresses(patch: LoadedPatch): string[] {
  return Object.keys(patch.assets).map((name) => patchAssetAddress(patch, name));
}

/**
 * Every variant the chain of `patches/<sourceVariantId>.ts` generated, from state alone — its steps
 * live at `<stage>:patch.<sourceVariantId>.<name>`, so this needs no script to load, which a broken
 * or deleted patch must not require. Used by the lifetime paths: what dies with the script, and
 * what holds a deletion back while it is still generating.
 */
export function patchChainTargets(
  state: KonteState,
  sourceVariantId: string,
): Array<{ address: string; variantId: string }> {
  const out: Array<{ address: string; variantId: string }> = [];
  for (const [address, target] of Object.entries(state.assets)) {
    if (patchSourceVariantIdOf(address) !== sourceVariantId) continue;
    for (const variantId of Object.keys(target.variants ?? {})) out.push({ address, variantId });
  }
  return out;
}

interface PatchLoadError {
  sourceVariantId: string;
  filePath: string;
  message: string;
  /** The typed code, when the failure had one — so naming the file gets the same code as any
   * other command reporting it, rather than the catalog's generic "this file did not load". */
  code?: KonteErrorCode;
}

export interface PatchCatalog {
  patches: Map<string, LoadedPatch>;
  /** Patch scripts whose source variant is no longer in state — orphans for `prune` to offer. */
  orphans: Array<{ sourceVariantId: string; filePath: string }>;
  /** Patch scripts whose source is an absent variant (see `StateManager.absentVariantIds`). */
  absent: Array<{ sourceVariantId: string; filePath: string }>;
  /** One entry per unreadable file; a broken patch never fails the whole catalog. */
  errors: PatchLoadError[];
}

/**
 * Every variant id with a patch script, in filename order. No `patches/` directory => none.
 * A basename that is not a well-formed variant id is not a patch at all, so it is skipped rather
 * than carried forward — `patchFilePath` would reject it and take every caller (status, preview,
 * inspect, generate) down with it over one stray file.
 */
export async function listPatchVariantIds(videoRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(patchesDir(videoRoot));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => name.slice(0, -3))
    .filter((id) => VARIANT_ID_PATTERN.test(id))
    .sort();
}

/**
 * Rejects a take that a patch itself produced — its output at the source's address, or a step of its
 * chain. Both are corrected by appending a step to the script that produced them; a second script
 * keyed to one would name a take its own source script can replace on the next apply.
 *
 * Called from `patch new` and from both load paths, so the rule holds however the file got there.
 */
export function assertPatchableTarget(state: KonteState, address: string, variantId: string): void {
  const stepOwner = patchSourceVariantIdOf(address);
  if (stepOwner) {
    throw new KonteError(
      "PATCH_TARGET_INVALID",
      `"${address}" is a step of the patch declared in patches/${stepOwner}.ts — correct it by editing that chain, not by patching its intermediate output`,
    );
  }
  const derivedFrom = state.assets[address]?.variants?.[variantId]?.derivedFrom;
  if (derivedFrom) {
    throw new KonteError(
      "PATCH_TARGET_INVALID",
      `Variant "${variantId}" is the output of patches/${derivedFrom}.ts — stack the next fix by appending a step to that chain, not by patching its result`,
    );
  }
}

function findVariantAddress(state: KonteState, variantId: string): string | null {
  for (const [address, target] of Object.entries(state.assets)) {
    if (target.variants?.[variantId]) return address;
  }
  return null;
}

/**
 * Loads one patch script. Used where a single job or address is being resolved and importing every
 * other patch in the video would be waste — the catalog path is for the surfaces that report on all
 * of them at once.
 */
export async function loadPatch(
  videoRoot: string,
  state: KonteState,
  sourceVariantId: string,
): Promise<LoadedPatch | null> {
  const sourceAddress = findVariantAddress(state, sourceVariantId);
  if (!sourceAddress) return null;
  assertPatchableTarget(state, sourceAddress, sourceVariantId);
  const filePath = patchFilePath(videoRoot, sourceVariantId);
  const buildFormat = await loadPatchBuildFormat(videoRoot, state);
  const build = await reloadPatchDefinition(filePath, {
    stage: getAssetStage(sourceAddress),
    sourceAddress,
    sourceVariantId,
    format: await buildFormat(sourceAddress, sourceVariantId),
  });
  return {
    ...build,
    sourceVariantId,
    sourceAddress,
    filePath,
    patchHash: computePatchHash(build),
  };
}

/**
 * The definition of the chain step at a patch address, or null when the address belongs to a stage
 * definition. A step is declared by `patches/<sourceVariantId>.ts`, never by a stage, so the
 * pending-submit path cannot look it up the way it looks up every other asset — and every patch job
 * sits at a patch address, the returned step included, so the address alone identifies one.
 */
export async function loadPatchStepDefinition(
  videoRoot: string,
  state: KonteState,
  address: string,
): Promise<AssetDefinition | null> {
  const sourceVariantId = patchSourceVariantIdOf(address);
  if (!sourceVariantId) return null;

  const patch = await loadPatch(videoRoot, state, sourceVariantId);
  if (!patch) {
    throw new KonteError(
      "PATCH_SOURCE_MISSING",
      `Patch source variant "${sourceVariantId}" is no longer in state, so "${address}" cannot be built`,
    );
  }
  const stepName = assetNameOf(parseAddress(address));
  const def = patch.assets[stepName];
  if (!def) {
    throw new KonteError(
      "PATCH_INVALID",
      `${patch.filePath} no longer declares the step "${stepName}" this job was queued for — re-apply the patch to queue it against the current script`,
    );
  }
  return def;
}

/**
 * Loads every patch script in the video, resolving each one's source address from state. Modeled
 * on `loadAdapterCatalog`: one broken file is reported, not fatal, so a typo in one patch does not
 * blind `status` to the rest.
 */
export async function loadPatchCatalog(
  videoRoot: string,
  state: KonteState,
  // `StateManager.absentVariantIds`. Without it, a script on an absent variant reads as an orphan.
  absentVariantIds: ReadonlySet<string> = new Set(),
): Promise<PatchCatalog> {
  const patches = new Map<string, LoadedPatch>();
  const orphans: PatchCatalog["orphans"] = [];
  const absent: PatchCatalog["absent"] = [];
  const errors: PatchLoadError[] = [];
  const variantIds = await listPatchVariantIds(videoRoot);
  const buildFormat = variantIds.length > 0 ? await loadPatchBuildFormat(videoRoot, state) : null;

  for (const sourceVariantId of variantIds) {
    const filePath = patchFilePath(videoRoot, sourceVariantId);
    const sourceAddress = findVariantAddress(state, sourceVariantId);
    if (!sourceAddress) {
      (absentVariantIds.has(sourceVariantId) ? absent : orphans).push({
        sourceVariantId,
        filePath,
      });
      continue;
    }
    try {
      // Inside the try: a hand-written patch on a patch — or on a target no patch may correct — is a
      // fault of that one file, reported like any other unloadable script rather than blinding the
      // catalog to the rest.
      assertPatchableTarget(state, sourceAddress, sourceVariantId);
      const stage = getAssetStage(sourceAddress);
      // Cache-busting on purpose: editing a patch and re-applying is the normal loop, and the
      // watcher/preview are long-lived, so a cached module would report the previous hash and the
      // edit would read as already realized.
      const build = await reloadPatchDefinition(filePath, {
        stage,
        sourceAddress,
        sourceVariantId,
        format: await buildFormat?.(sourceAddress, sourceVariantId),
      });
      patches.set(sourceVariantId, {
        ...build,
        sourceVariantId,
        sourceAddress,
        filePath,
        patchHash: computePatchHash(build),
      });
    } catch (err) {
      errors.push({
        sourceVariantId,
        filePath,
        message: errorMessage(err),
        ...(err instanceof KonteError ? { code: err.code } : {}),
      });
    }
  }

  return { patches, orphans, absent, errors };
}

/**
 * The canvas a patch step resolves its format-derived inputs against. `size` is the corrected take's
 * OWN pixel size, read off its recorded measurements: a patch registers its output as a variant at
 * the source's address, so a correction that comes back at different dimensions is a replacement,
 * not a fix. The direction's canvas is the fallback for a take with no record (an audio take, a
 * missing file, a probe that failed when the take landed) — it is right for the stage assets it
 * happens to match, but the reference stage builds with no format at all, so sizing every correction
 * from it landscaped a square reference take.
 *
 * State, never a live probe: this size feeds a definition hash, so it has to be the same number on
 * every machine and in every command that loads the catalog — `konte status` among them, which must
 * not spawn ffprobe (nor provision it).
 *
 * `fps` is video-only (the animatic stage has none) and `duration` is a shot's, so a step
 * correcting a shot asset can size a frame count the way that shot's own assets do. Both stay the
 * direction's: unlike pixel size they are the timeline's normative values, not the take's.
 */
async function loadPatchBuildFormat(
  videoRoot: string,
  state: KonteState,
): Promise<(sourceAddress: string, sourceVariantId: string) => Promise<BuildFormat | undefined>> {
  const canvas = await loadDirectionCanvas(videoRoot);

  const sourceSize = (sourceAddress: string, sourceVariantId: string) =>
    mediaVisualSize(state.assets[sourceAddress]?.variants?.[sourceVariantId]?.media ?? null);

  return async (sourceAddress, sourceVariantId) => {
    const fromDirection = canvas?.(sourceAddress);
    const size = sourceSize(sourceAddress, sourceVariantId);
    if (!size) return fromDirection;
    return { ...fromDirection, size };
  };
}

/**
 * The direction's canvas, as a stage asset would resolve it — the fallback for a take whose own size
 * cannot be read.
 */
async function loadDirectionCanvas(
  videoRoot: string,
): Promise<((sourceAddress: string) => BuildFormat | undefined) | null> {
  // A broken direction is reported by every spend command already; a patch build falling back to
  // adapter defaults is a better outcome here than taking `status` and `inspect` down with it.
  const direction = await loadIfPresent(
    stageEntryPath(videoRoot, "direction"),
    loadDirectionDefinition,
  ).catch(() => null);
  if (!direction?.policy?.format) return null;
  const format = resolveDirectionFormat(direction);

  const typography = direction?.policy?.lang
    ? {
        lang: direction.policy.lang,
        ...(direction.policy.fonts?.length ? { fonts: [...direction.policy.fonts] } : {}),
      }
    : undefined;
  // Every shot, aside included: a patch corrects a take at an address, and an aside has assets to
  // correct like any other video shot.
  const durations = new Map(collectShots(direction).map((s) => [s.id, s.duration]));
  return (sourceAddress) => {
    const parsed = parseAddress(sourceAddress);
    const shotId = parsed.kind === "shot" ? parsed.shotId : null;
    return {
      size: format.size.base,
      ...(typography ? { typography } : {}),
      ...(parsed.stage === "video" ? { fps: format.fps } : {}),
      ...(parsed.stage === "video" && shotId && durations.has(shotId)
        ? { duration: durations.get(shotId) }
        : {}),
    };
  };
}

/**
 * Current patch hash per source variant id, the table `computeVariantStaleness` consults to decide
 * whether a patch variant still reflects the script that produced it.
 */
export function patchHashesOf(catalog: PatchCatalog): Map<string, string> {
  return new Map([...catalog.patches].map(([id, p]) => [id, p.patchHash]));
}

interface PendingPatch extends LoadedPatch {
  /**
   * Why the correction is not realized: never applied, its script edited since, or an input it
   * consumed moved. One thing to `generate`, three situations in `status`.
   */
  reason: "never-applied" | "script-changed" | "inputs-changed";
}

/**
 * Patches with no non-stale output. Collapses "never applied" and "applied, then the script was
 * edited" into one predicate — both mean the same thing to `generate`: this correction is not
 * realized yet. A patch whose source variant has no file is skipped (there is nothing to feed it).
 */
export function findPendingPatches(
  state: KonteState,
  catalog: PatchCatalog,
  // Variant ids of generation jobs that are pending/queued/running. Supplied by callers that hold
  // a JobManager; it is the only reliable "still working" signal, since a variant left fileless by
  // a job that completed empty carries no terminal marker at all. Without it the fallback below
  // reads the markers, which is right for the common cases but cannot see that one.
  activeJobVariantIds?: ReadonlySet<string>,
  // The caller's resolution memo. Without it a reverted edit reads as a moved input, and this asks
  // for a re-apply nothing is waiting on — a spend.
  cache?: StalenessCache,
): PendingPatch[] {
  const patchHashes = patchHashesOf(catalog);
  const pending: PendingPatch[] = [];

  for (const patch of catalog.patches.values()) {
    const variants = state.assets[patch.sourceAddress]?.variants ?? {};
    const source = variants[patch.sourceVariantId];
    if (!source?.file) continue;

    const outputs = Object.entries(variants).filter(
      ([, v]) => v.derivedFrom === patch.sourceVariantId,
    );
    const stalenessOf = (v: VariantState) =>
      computeVariantStaleness(state, patch.sourceAddress, v, null, patchHashes, cache);
    // A correction is built from the source's file and inherits its input fingerprints, so it can
    // never be fresher than the take it corrects. Where the SOURCE is input-stale, applying again
    // would spend on a take stale from birth, every run.
    const sourceInputStale = stalenessOf(source).inputStale;
    const landed = outputs.filter(([, v]) => v.file);
    const fresh = landed.filter(([, v]) => {
      const staleness = stalenessOf(v);
      return !staleness.patchStale && (!staleness.inputStale || sourceInputStale);
    });
    // A chain still running counts as realized — re-applying would double-spend. Asked of the STEP
    // addresses: the patched variant is registered only once the returned step lands, so until then
    // an apply in flight leaves nothing at the source's address to see it by.
    const inFlight = patchPoolAddresses(patch).some((address) =>
      Object.entries(state.assets[address]?.variants ?? {}).some(([id, v]) => {
        if (v.file) return false;
        if (activeJobVariantIds) return activeJobVariantIds.has(id);
        // `error` and `cancelledAt` land on different metadata keys (see job cancel), so both must
        // be checked or a cancelled attempt would block its patch from ever being applied again.
        return !v.metadata?.error && !v.metadata?.cancelledAt;
      }),
    );
    if (fresh.length > 0 || inFlight) continue;

    // Asked of the takes the CURRENT script produced: an older attempt from a since-replaced
    // script would otherwise report "script changed" beside a take this one produced.
    const builtByCurrentScript = landed.some(([, v]) => !stalenessOf(v).patchStale);
    pending.push({
      ...patch,
      reason:
        landed.length === 0
          ? "never-applied"
          : builtByCurrentScript
            ? "inputs-changed"
            : "script-changed",
    });
  }

  return pending;
}

/** Generation jobs that have not reached a terminal state, by variant id. */
export function activeGenerationJobs(jobs: readonly JobRecord[]): Map<string, GenerationJob> {
  const active = new Map<string, GenerationJob>();
  for (const job of jobs) {
    if (job.kind !== "generation") continue;
    if (job.status !== "pending" && job.status !== "queued" && job.status !== "running") continue;
    active.set(job.id, job);
  }
  return active;
}

/** Variant ids of generation jobs that have not reached a terminal state. */
export function activeGenerationVariantIds(jobs: readonly JobRecord[]): Set<string> {
  return new Set(activeGenerationJobs(jobs).keys());
}

export function requirePatch(catalog: PatchCatalog, sourceVariantId: string): LoadedPatch {
  const patch = catalog.patches.get(sourceVariantId);
  if (patch) return patch;

  // A file that exists but failed to load must report why. Falling through to "not found" would
  // send the author looking for a missing file instead of at the error in the one they wrote.
  const failed = catalog.errors.find((e) => e.sourceVariantId === sourceVariantId);
  if (failed) throw new KonteError(failed.code ?? "PATCH_INVALID", failed.message);

  const absent = catalog.absent.find((o) => o.sourceVariantId === sourceVariantId);
  if (absent) {
    throw new KonteError(
      "PATCH_SOURCE_ABSENT",
      `The patch ${absent.filePath} names variant "${sourceVariantId}", whose media is not in this checkout — git tracks only accepted takes`,
    );
  }

  const orphaned = catalog.orphans.find((o) => o.sourceVariantId === sourceVariantId);
  if (orphaned) {
    throw new KonteError(
      "PATCH_SOURCE_MISSING",
      `The patch ${orphaned.filePath} names variant "${sourceVariantId}", which is no longer in state`,
    );
  }

  throw new KonteError(
    "PATCH_NOT_FOUND",
    `No patch script for variant "${sourceVariantId}" (expected patches/${sourceVariantId}.ts)`,
  );
}
