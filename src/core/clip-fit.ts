import { shotCueRefs, tryParseAddress } from "./address.js";
import { harvestShotAudioStructure, type StemAudioEntry } from "./composition-builder.js";
import { OVERFLOW_FLOOR, type ClipLength } from "./dsl/clip-length-collect.js";
import { floorToGrid } from "./dsl/comfy-asset.js";
import { KonteError } from "./errors.js";
import { BASE_SEC } from "./speech-duration.js";
import type { AnimaticDefinition, AssetDefinition } from "./types/index.js";

/**
 * An animatic shot's stem is clamped to the shot (`materializeShotStem`), so a cue that ends past
 * it loses its tail — a line cut mid-word, with nothing to show for it until the mix is heard.
 *
 * Both halves here settle that before a job is submitted, from the definition alone: no state, no
 * probe, and no estimate. What a clip will be is already written — an input gives its length — so
 * where the cue ends is arithmetic.
 */

// A script's rate runs up to twice a real read for the fastest language it covers, and further where
// it is still a guess, so only a clip under half of the words — the lead-in and settle aside, which a
// tight window may drop — is sure to rush them.
const RUSHED_RATIO = 0.5;

function assetAt(definition: AnimaticDefinition, address: string): AssetDefinition | undefined {
  const parsed = tryParseAddress(address);
  if (!parsed || parsed.stage !== definition.stage) return undefined;
  if (parsed.kind === "timeline") return definition.topLevelAssets?.[parsed.assetName];
  if (parsed.kind === "plate") return definition.plates?.[parsed.assetName];
  if (parsed.kind === "shot") {
    return definition.shots.find((s) => s.id === parsed.shotId)?.assets[parsed.assetName];
  }
  return undefined;
}

// Every cue of every developed shot, paired with what its source asks the model for. A cue whose
// source declares no length (a `file`, a trim, a fal take) is left to the measured check downstream.
function* clipCues(
  definition: AnimaticDefinition,
  clipLengths: readonly ClipLength[],
): Generator<{ shotId: string; duration: number; cue: StemAudioEntry; clip: ClipLength }> {
  const byInputs = new Map<Record<string, unknown>, ClipLength>();
  for (const c of clipLengths) byInputs.set(c.inputs, c);

  for (const shot of definition.shots) {
    if (shotCueRefs(shot).length === 0) continue;
    const cues = harvestShotAudioStructure(definition, shot.id);
    if (cues === null) continue;
    for (const cue of cues) {
      // A cue mixed at zero is in the stem and in nobody's ears.
      if (cue.volume === 0) continue;
      const asset = assetAt(definition, cue.src);
      const clip = asset && "inputs" in asset ? byInputs.get(asset.inputs) : undefined;
      if (!clip) continue;
      yield { shotId: shot.id, duration: shot.duration, cue, clip };
    }
  }
}

// Where the cue ends on the shot's clock. `mediaStart` skips into the source and `duration` trims
// it, but neither pads: the source bounds the cue either way.
function cueEnd(cue: StemAudioEntry, clipSec: number): number {
  const start = cue.start ?? 0;
  const available = Math.max(0, clipSec - (cue.mediaStart ?? 0));
  return start + (cue.duration != null ? Math.min(cue.duration, available) : available);
}

// What the cue's window leaves of the shot, in the clip's units, landed on the clip's grid or whole
// frames.
function heldInWindow(clip: ClipLength, duration: number, cue: StemAudioEntry): number {
  const allowed = (duration - (cue.start ?? 0) + (cue.mediaStart ?? 0)) * clip.perSecond;
  return clip.grid
    ? floorToGrid(allowed, clip.grid)
    : clip.unit === "frames"
      ? Math.floor(allowed)
      : allowed;
}

/**
 * Narrows a count konte derived from the words to the window the cue actually plays in.
 *
 * `asset()` runs before the composition places the cue, so the widest window it can hold a derived
 * count inside is the whole shot. A `<Audio start>` takes some of that away, and a count sized for
 * the shot would then end past it — konte's own default tripping konte's own check. Running this
 * before `assertCuesFitShot` closes that, except where the window is narrower than the smallest
 * count the grid can name and nothing legal fits at all.
 *
 * A cue the author gave an explicit `duration` is left alone: the trim already decides its length,
 * and shrinking the clip under it would cut what was asked for.
 */
export function tightenDerivedClipLengths(
  definition: AnimaticDefinition,
  clipLengths: readonly ClipLength[],
): void {
  for (const { duration, cue, clip } of clipCues(definition, clipLengths)) {
    if (clip.wantSec === undefined || cue.duration != null) continue;
    if (cueEnd(cue, clip.length / clip.perSecond) <= duration + OVERFLOW_FLOOR) continue;
    const held = heldInWindow(clip, duration, cue);
    if (held <= 0 || held === clip.length) continue;
    // A grid floors at its own offset, so the smallest length it can name may still end past the
    // shot. Nothing legal fits then, and the length is left where it is: `assertCuesFitShot` reports
    // the cue the author declared rather than one konte shrank, which is the one they can act on.
    if (cueEnd(cue, held / clip.perSecond) > duration + OVERFLOW_FLOOR) continue;
    clip.length = held;
    for (const target of clip.targets) clip.inputs[target] = held;
    clip.revalidate?.(held);
  }
}

/**
 * A cue that ends past the shot it sounds over, refused before the take is paid for. The clip
 * length is declared, so this is exact.
 *
 * Also a count konte derived from the words and then narrowed to under half of what they take to
 * say: the take would come back rushed or clipped, and nothing says why until it is heard.
 */
export function assertCuesFitShot(
  definition: AnimaticDefinition,
  clipLengths: readonly ClipLength[],
): void {
  for (const { shotId, duration, cue, clip } of clipCues(definition, clipLengths)) {
    const clipSec = clip.length / clip.perSecond;
    const end = cueEnd(cue, clipSec);
    const over = end - duration;
    const start = cue.start ?? 0;
    if (over <= OVERFLOW_FLOOR) {
      // A `duration` trims the take and cannot lengthen it, so it exempts nothing. A take placed
      // twice is reported at the placement whose window holds it this short.
      const wordsSec = clip.wantSec !== undefined ? clip.wantSec - BASE_SEC : undefined;
      if (
        wordsSec !== undefined &&
        clipSec < wordsSec * RUSHED_RATIO &&
        heldInWindow(clip, duration, cue) <= clip.length
      ) {
        throw new KonteError(
          "CUE_WINDOW_TOO_SHORT",
          `Animatic shot "${shotId}" plays ${cue.src} from ${start.toFixed(2)}s, leaving ` +
            `${(duration - start).toFixed(2)}s of its ${duration.toFixed(2)}s shot for words konte ` +
            `estimates at ${wordsSec.toFixed(1)}s to say. The clip was cut to the ` +
            `${clipSec.toFixed(2)}s that fits, so the line comes back rushed or clipped. Start the ` +
            `cue earlier or give the shot more room in direction.ts — or declare the clip length on ` +
            `the asset if a clipped read is intended.`,
        );
      }
      continue;
    }
    // Whose number this is decides what the author can do about it. A count they wrote can be cut;
    // one konte derived is already as short as the grid allows, and only the shot or the cue's
    // place on it is left to move.
    const fix =
      clip.wantSec === undefined
        ? `Shorten the clip (${clip.unit === "frames" ? `its frame count is ${clip.length} at ${clip.perSecond}fps` : `it asks for ${clip.length}s`}), start the cue earlier, or give the shot more room in direction.ts.`
        : `konte sized this clip from the words and the grid names nothing shorter that fits — start the cue earlier, or give the shot more room in direction.ts.`;
    throw new KonteError(
      "CUE_OVERRUNS_SHOT",
      `Animatic shot "${shotId}" plays ${cue.src} from ${start.toFixed(2)}s for ` +
        `${clipSec.toFixed(2)}s, ending ${over.toFixed(2)}s past its ${duration.toFixed(2)}s shot. ` +
        `The stem is clamped to the shot, so that tail is cut. ${fix}`,
    );
  }
}
