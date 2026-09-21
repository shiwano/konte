import { getAssetEntry, getStage, isDeliveryAddress, isStemAddress } from "./address.js";
import { definitionHashForAddress } from "./composition-resource.js";
import {
  loadIfPresent,
  loadReferenceDefinition,
  loadAnimaticDefinition,
  loadVideoDefinition,
} from "./loader.js";
import { loadPatchCatalog, patchHashesOf } from "./patch.js";
import { StateManager } from "./state/index.js";
import { registerResolutionDefinitions } from "./state/resolution-definitions.js";
import type { PatchHashes, ResolutionDefinitions } from "./staleness.js";
import type {
  KonteState,
  ReferenceDefinition,
  AnimaticDefinition,
  VideoDefinition,
} from "./types/index.js";
import { stageEntryPath } from "./roots.js";

/**
 * The stage entries a video is made of, as far as an address's definition is concerned. Each is
 * optional: a stage that has no file yet — or one whose file failed to load — contributes no hash,
 * leaving addresses under it resolving on the input axis alone rather than failing the caller.
 */
export interface StageDefinitions {
  reference?: ReferenceDefinition | null;
  animatic?: AnimaticDefinition | null;
  video?: VideoDefinition | null;
}

/** The stage entry an address belongs to, or null when no loaded stage owns it. */
export function definitionForAddress(definitions: StageDefinitions, address: string) {
  let stage: string;
  try {
    stage = getStage(address);
  } catch {
    return null;
  }
  return stage === "reference"
    ? (definitions.reference ?? null)
    : stage === "animatic"
      ? (definitions.animatic ?? null)
      : stage === "video"
        ? (definitions.video ?? null)
        : null;
}

function assetFlag(definitions: StageDefinitions, address: string, flag: "deterministic"): boolean {
  const definition = definitionForAddress(definitions, address);
  if (!definition) return false;
  try {
    return getAssetEntry(definition, address)[flag] === true;
  } catch {
    return false;
  }
}

/**
 * Whether the asset at `address` produces the same output for the same inputs — so there is nothing
 * to pick among (`reroll` and `dismiss` refuse) and a stale take re-bakes over its accept. False for
 * an address no loaded stage declares, a materialized leaf among them.
 */
export function isDeterministicAddress(definitions: StageDefinitions, address: string): boolean {
  // A stem is one mix of its cues: nothing to pick among, and re-materialized rather than rerolled.
  // Read here so strict resolution refuses a stale accepted one (`resolveCore`) — a spend consuming
  // the board's mix must not build on a line since re-picked.
  if (isStemAddress(address)) return true;
  // A delivery upscale is synthesized, never declared; konte accepts it on completion, so a stale
  // one re-bakes on the next export.
  if (isDeliveryAddress(address)) return true;
  return assetFlag(definitions, address, "deterministic");
}

/**
 * Address → current definition hash, routed by the address's own stage, for the resolution walk to
 * compare a take's recorded `definitionHash` against — `definitionHashForAddress`, which is what
 * `inspect` and `status` already compute per variant.
 */
function createResolutionDefinitions(
  definitions: StageDefinitions,
  patchHashes?: PatchHashes,
): ResolutionDefinitions {
  return {
    isDeterministic: (address) => isDeterministicAddress(definitions, address),
    definitionHash(address: string): string | null {
      // A `#delivery` asset is synthesized from the resolved source's real dimensions, ffprobed at
      // export — `definitionHashForAddress` would hash its SOURCE and read every delivery take as
      // definition-stale. `status` and `inspect` leave the axis null here for the same reason;
      // delivery's own definition check belongs to export.
      if (isDeliveryAddress(address)) return null;
      const definition = definitionForAddress(definitions, address);
      return definition ? definitionHashForAddress(definition, address) : null;
    },
    patchHashes,
  };
}

/**
 * One stage entry: the definition, `null` when the file is absent, `undefined` when it is there but
 * will not load. Tolerant on purpose — losing the definition axis costs accuracy where a throw would
 * cost the command, including in the commands whose job is to REPORT that the file is broken.
 *
 * Absent and unreadable are kept apart for the reference stage: "this project has no reference
 * pool" answers questions about it, "it could not be read" answers none.
 */
function loadIfLoadable<T>(
  file: string,
  read: (p: string) => Promise<T>,
): Promise<T | null | undefined> {
  return loadIfPresent(file, (p) => read(p).catch(() => undefined));
}

/**
 * Load every stage entry of a video and register the resulting definition hashes for its root, so
 * resolution reads a take's own definition and not only its inputs (see `ResolutionDefinitions`).
 * Registered per root rather than per manager: `StateManager.withLock` makes its own manager, and
 * the two must not resolve an address differently.
 *
 * `definitions`, `state` and `patchHashes` each skip a load for a caller already holding them;
 * `state` is what the patch catalog resolves each script's source address from.
 */
export async function applyResolutionDefinitions(opts: {
  videoRoot: string;
  state?: KonteState;
  definitions?: StageDefinitions;
  patchHashes?: PatchHashes;
}): Promise<StageDefinitions> {
  const { videoRoot } = opts;
  const stages = opts.definitions ??
    // Animatic before video, for the reason `loadVideoAndAnimatic` sequences them.
    {
      reference: await loadIfLoadable(
        stageEntryPath(videoRoot, "reference"),
        loadReferenceDefinition,
      ),
      animatic: await loadIfLoadable(stageEntryPath(videoRoot, "animatic"), loadAnimaticDefinition),
      video: await loadIfLoadable(stageEntryPath(videoRoot, "video"), loadVideoDefinition),
    };
  const state =
    opts.patchHashes !== undefined
      ? null
      : (opts.state ??
        (await StateManager.load(videoRoot)
          .then((m) => m.getState())
          .catch(() => null)));
  const patchHashes =
    opts.patchHashes ??
    (state
      ? await loadPatchCatalog(videoRoot, state)
          .then(patchHashesOf)
          .catch(() => undefined)
      : undefined);
  registerResolutionDefinitions(videoRoot, createResolutionDefinitions(stages, patchHashes));
  // Returned for the caller that needs a stage entry it did not load itself (`ref` reads the board).
  return stages;
}
