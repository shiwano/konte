import { getAssetEntry, getStage, isDeliveryAddress, isStemAddress } from "./address.js";
import { definitionHashForAddress } from "./composition-resource.js";
import { diffDefinitions, readDefinitionSnapshot } from "./definition-snapshot.js";
import { stableStringify } from "./stable-stringify.js";
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
import { loadStageDefinitions } from "./stage-definitions.js";
import { generatedOrigin } from "./variant-lineage.js";

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

function definitionDrift(
  videoRoot: string,
  state: KonteState,
  definitions: StageDefinitions,
  address: string,
  variantId: string,
): {
  snapshot: Record<string, unknown>;
  current: Record<string, unknown>;
  paths: string[];
} | null {
  const snapshot = readDefinitionSnapshot(
    videoRoot,
    address,
    generatedOrigin(state, address, variantId),
  );
  const definition = definitionForAddress(definitions, address);
  let current: Record<string, unknown> | null = null;
  try {
    current = definition ? (getAssetEntry(definition, address) as Record<string, unknown>) : null;
  } catch {
    current = null;
  }
  if (!snapshot || !current) return null;
  const paths = diffDefinitions(snapshot, current).map((c) => c.path);
  return { snapshot: snapshot as Record<string, unknown>, current, paths };
}

/**
 * The definition fields the address's live entry has moved away from since `variantId`'s original
 * was made. Empty when either side cannot be read.
 */
export function definitionDriftFields(
  videoRoot: string,
  state: KonteState,
  definitions: StageDefinitions,
  address: string,
  variantId: string,
): string[] {
  return definitionDrift(videoRoot, state, definitions, address, variantId)?.paths ?? [];
}

/**
 * Whether `variantId`'s definition moved only under its model adapter — every input the call site
 * sets holds the value it held, so what moved is the workflow graph, the models, an input's target,
 * or an input the call site leaves to the adapter, and the stage file holds nothing to write back.
 * False when the drift cannot be read, or the call site names another adapter.
 */
function isAdapterDrift(
  videoRoot: string,
  state: KonteState,
  definitions: StageDefinitions,
  address: string,
  variantId: string,
): boolean {
  const drift = definitionDrift(videoRoot, state, definitions, address, variantId);
  if (!drift || drift.paths.length === 0) return false;
  const { snapshot, current } = drift;
  if (current.kind !== "comfy" && current.kind !== "fal") return false;
  // Another adapter at the call site, not the same adapter moving under it.
  if (snapshot.kind !== current.kind) return false;
  if (snapshot.workflow !== current.workflow || snapshot.endpointId !== current.endpointId) {
    return false;
  }
  const then = namedInputs(snapshot);
  const now = namedInputs(current);
  for (const [name, n] of now) {
    const t = then.get(name);
    // A snapshot predating the record is read by the current one.
    const byCallSiteThen = t !== undefined && (t.byCallSite ?? n.byCallSite);
    if (!n.byCallSite && !byCallSiteThen) continue;
    // Set on one side and left to the adapter on the other: the call site added or dropped it.
    if (!n.byCallSite || !byCallSiteThen) return false;
    if (stableStringify(t!.value) !== stableStringify(n.value)) return false;
  }
  for (const [name, t] of then) {
    if (!now.has(name) && t.byCallSite !== false) return false;
  }
  return true;
}

/**
 * Each input a definition holds, by the name its adapter declares — so an input re-pointed at
 * another node or field is still the same input. `byCallSite` is undefined for a definition that
 * predates `adapterSuppliedInputs`.
 */
function namedInputs(
  def: Record<string, unknown>,
): Map<string, { value: unknown; byCallSite: boolean | undefined }> {
  const labels = (def.inputLabels as Record<string, string> | undefined) ?? {};
  const supplied = def.adapterSuppliedInputs as string[] | undefined;
  const out = new Map<string, { value: unknown; byCallSite: boolean | undefined }>();
  for (const [key, name] of Object.entries(labels)) {
    if (out.has(name)) continue;
    out.set(name, {
      value: inputAt(def.inputs, key),
      byCallSite: supplied === undefined ? undefined : !supplied.includes(key),
    });
  }
  return out;
}

// An `inputs` key is a comfy `<nodeId>.<field>` or a fal field path, which nests.
function inputAt(inputs: unknown, key: string): unknown {
  if (typeof inputs !== "object" || inputs === null) return undefined;
  const record = inputs as Record<string, unknown>;
  if (key in record) return record[key];
  const dot = key.indexOf(".");
  return dot > 0 ? inputAt(record[key.slice(0, dot)], key.slice(dot + 1)) : undefined;
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
  videoRoot: string,
  definitions: StageDefinitions,
  patchHashes?: PatchHashes,
): ResolutionDefinitions {
  return {
    isDeterministic: (address) => isDeterministicAddress(definitions, address),
    adapterDrift: (state, address, variantId) =>
      isAdapterDrift(videoRoot, state, definitions, address, variantId),
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
  // Tolerant: losing the definition axis costs accuracy where a throw would cost the command,
  // including in the commands whose job is to report that a file is broken.
  const stages = opts.definitions ?? (await loadStageDefinitions(videoRoot, { tolerant: true }));
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
  registerResolutionDefinitions(
    videoRoot,
    createResolutionDefinitions(videoRoot, stages, patchHashes),
  );
  // Returned for the caller that needs a stage entry it did not load itself (`path` reads the board).
  return stages;
}
