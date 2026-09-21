import {
  assertValidAddressScope,
  isPatchAddress,
  isPatchScope,
  parseAddress,
} from "../../../core/address.js";
import { KonteError } from "../../../core/errors.js";
import { inferMediaType } from "../../../core/media-type.js";
import { StateManager } from "../../../core/state/index.js";
import { matchesAddressScope } from "../../../core/address.js";
import {
  applyResolutionDefinitions,
  type StageDefinitions,
} from "../../../core/definition-hashes.js";
import { requireVideoRoot } from "../../context.js";

type ProbeMediaKind = "video" | "image" | "audio";

export interface ProbeTargets {
  variantIds: string[];
  // A container scope resolves to a *set* of variants, and so does any multi-argument
  // call; a single argument naming a variant id or full address names exactly one. Callers vary
  // their output shape on this (a sweep prints per-target headers and emits a JSON array; a single
  // target keeps the one-object form).
  multi: boolean;
}

/**
 * Resolve a probe argument into the ordered set of variant ids to probe. The argument is one of:
 *
 * - a variant id (`v-…`) — that one variant, probed as-is (no media filtering; the caller named it).
 * - a full address (`<stage>:shot.<id>.<name>`, `<stage>:timeline.<name>`, `reference:<name>`) — its
 *   canonical variant, like `konte ref`. Kept distinct from a broadening scope so the single-probe
 *   output (informative "not a video"/"no audio") and the targeted not-found error survive.
 * - a container address-scope (`video`, `video:shot.01`, `animatic:timeline`, `reference`) — every
 *   asset under it, each resolved to its canonical variant and kept only if this probe can read its
 *   media (`mediaKinds`), so `probe motion video` sweeps the video stage's motion clips without
 *   dragging in stills or audio. A patch step is swept only by a scope that names the patch axis.
 *
 * `:` no longer discriminates (a bare stage like `video` carries none) — `v-` marks a variant id, a
 * successful `parseAddress` marks a full address, everything else is a scope.
 */
function resolveOne(
  manager: StateManager,
  arg: string,
  opts: { mediaKinds: readonly ProbeMediaKind[] },
): ProbeTargets {
  if (arg.startsWith("v-")) return { variantIds: [arg], multi: false };

  let isFullAddress = true;
  try {
    parseAddress(arg);
  } catch {
    isFullAddress = false;
  }

  if (isFullAddress) {
    // An address is the take on screen, stale included — what `konte ref` prints.
    const resolved = manager.resolveReference(arg, { includeStale: true });
    if (!resolved) {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `No ready variant for "${arg}" — pass a specific variant id (see \`konte inspect ${arg}\`)`,
      );
    }
    return { variantIds: [resolved.variantId], multi: false };
  }

  assertValidAddressScope(arg);
  const state = manager.getState();
  // A patch step is machinery, not a take: the chain's returned step is already registered at the
  // corrected take's own address, so keeping the steps would probe the same file twice.
  const patchAxis = isPatchScope(arg);
  const variantIds: string[] = [];
  for (const address of Object.keys(state.assets).sort()) {
    if (!matchesAddressScope(address, arg)) continue;
    if (!patchAxis && isPatchAddress(address)) continue;
    const resolved = manager.resolveReference(address, { includeStale: true });
    if (!resolved) continue;
    // A sweep keeps only media this probe can read; an unrecognized extension (mediaType null) is
    // dropped too, so it never surfaces as a "not a video"/"0 frames" line in a bulk run. An
    // explicitly named variant id or address skips this path, so the caller can still force one.
    const mediaType = inferMediaType(resolved.file);
    if (!mediaType || !opts.mediaKinds.includes(mediaType)) continue;
    variantIds.push(resolved.variantId);
  }
  if (variantIds.length === 0) {
    throw new KonteError(
      "VARIANT_NOT_FOUND",
      `No ${opts.mediaKinds.join("/")} variant to probe under scope "${arg}"`,
    );
  }
  return { variantIds, multi: true };
}

/**
 * Resolve the probe arguments into one ordered, de-duplicated set of variant ids. Each argument is
 * resolved independently (see {@link resolveOne}) and the results are concatenated in argument
 * order, so a caller can pick out an arbitrary handful — `probe audio reference:bgm reference:rain`
 * — that no single scope expresses. Overlapping arguments (`reference reference:bgm`) probe each
 * variant once.
 *
 * An argument that resolves to nothing fails the whole call rather than being silently dropped: a
 * probe reporting on fewer sources than were asked for reads as a clean result.
 */
export function resolveProbeTargets(
  manager: StateManager,
  args: readonly string[],
  opts: { mediaKinds: readonly ProbeMediaKind[] },
): ProbeTargets {
  // More than one argument is a sweep by construction, whatever each one resolves to — the output
  // shape then follows from the command line alone, not from how many variants happened to match.
  let multi = args.length > 1;
  const variantIds: string[] = [];
  const seen = new Set<string>();
  for (const arg of args) {
    const resolved = resolveOne(manager, arg, opts);
    if (resolved.multi) multi = true;
    for (const variantId of resolved.variantIds) {
      if (seen.has(variantId)) continue;
      seen.add(variantId);
      variantIds.push(variantId);
    }
  }
  return { variantIds, multi };
}

interface OpenedProbeTargets extends ProbeTargets {
  videoRoot: string;
  manager: StateManager;
  // The loaded stages, when the caller asked for them (`definitions: true`). Null when every
  // argument named a variant id and nothing forced the load.
  definitions: StageDefinitions | null;
}

// The preamble every variant-probe shares: the current video's state, resolution definitions when
// any argument is a scope or address (`v-` and not `:` — a bare stage like `video` is a scope to
// resolve, not a variant id), then the arguments resolved to variant ids.
//
// `definitions` forces that load even for a bare variant id and hands the stages back, for a probe
// that reports on what the definition says as well as on the file — `probe audio` prints the line a
// voice take owes. Off by default: loading a stage transpiles and runs it.
export async function openProbeTargets(
  args: readonly string[],
  opts: { mediaKinds: readonly ProbeMediaKind[]; definitions?: boolean },
): Promise<OpenedProbeTargets> {
  const videoRoot = requireVideoRoot();
  const manager = await StateManager.load(videoRoot);
  let definitions: StageDefinitions | null = null;
  if (opts.definitions || args.some((arg) => !arg.startsWith("v-"))) {
    definitions = await applyResolutionDefinitions({ videoRoot, state: manager.getState() });
  }
  return { videoRoot, manager, definitions, ...resolveProbeTargets(manager, args, opts) };
}
