import { listShotStems } from "./address.js";
import { MAX_RETIME_RATE } from "./audio-retime.js";
import { cueLeadIn, type CueKind } from "./audio-level.js";
import { harvestShotAudioStructure, type StemAudioEntry } from "./composition-builder.js";
import { OVERFLOW_FLOOR } from "./dsl/clip-length-collect.js";
import { selectResolvedVariant, type StalenessCache } from "./staleness.js";
import type { StateManager } from "./state/index.js";
import type { AnimaticDefinition, KonteState } from "./types/index.js";
import { mediaDurationSec } from "./variant-media.js";

// An animatic shot's stem is clamped to the shot's `duration` (`materializeShotStem`), so a shot
// whose spoken lines run longer loses its tail: the truncated stem is exactly as long as the shot, which
// is what a stem that fits looks like too.
//
// The difference, from the cues' recorded lengths (`VariantMediaSchema`) against the clamp. No
// probing: a cue whose take is unmeasured contributes nothing rather than a guess, so this is a floor.

export interface AnimaticOverflow {
  shotId: string;
  /** The stem the clamp cuts — `animatic:shot.<id>#stem` or `#narrationStem`. */
  address: string;
  /** The shot's `duration`: what the stem is clamped to. */
  durationSec: number;
  /** Where the last cue would end unclamped. */
  neededSec: number;
  /** How much is cut: `neededSec - durationSec`, always above OVERFLOW_FLOOR. */
  overflowSec: number;
  /** Cues whose length is not known, so the real overflow may be larger than reported. */
  unmeasuredCues: number;
  /** The `audioRetime` that fits the one cue the clamp cuts, when it stays inside the rate gate. */
  retime: AnimaticRetime | null;
}

export interface AnimaticRetime {
  /** The cue's address — the `source` of the retime. */
  src: string;
  /** The room the cue has from its `start` to the shot's end: the retime's `duration`. */
  roomSec: number;
  /** The tempo that lands the take on `roomSec`. */
  rate: number;
}

interface CueSpan {
  src: string;
  start: number;
  end: number;
  sourceSec: number;
  untrimmed: boolean;
}

function cueSpan(
  cue: StemAudioEntry,
  kind: CueKind | undefined,
  state: KonteState,
  cache: StalenessCache,
): CueSpan | "unmeasured" | "silent" {
  const start = cue.start ?? 0;
  // A cue mixed at zero is in the stem and in nobody's ears (`volume`, `trackFilter`).
  if (cue.volume === 0) return "silent";

  // The source bounds the cue even when the cue declares a `duration`: that becomes an `atrim`, which
  // shortens a take but never pads one (only the final clamp pads, `buildAudioMixArgs`). Unknown
  // source, no claim.
  const resolved = selectResolvedVariant(state, cue.src, undefined, cache);
  if (!resolved) return "unmeasured";
  const variant = state.assets[cue.src]?.variants?.[resolved.variantId];
  const sourceDuration = mediaDurationSec(variant?.media ?? null);
  if (sourceDuration === null) return "unmeasured";

  const mediaStart = cue.mediaStart ?? cueLeadIn(kind, variant?.media);
  const available = Math.max(0, sourceDuration - mediaStart);
  return {
    src: cue.src,
    start,
    end: start + (cue.duration != null ? Math.min(cue.duration, available) : available),
    sourceSec: sourceDuration,
    untrimmed: cue.duration == null && mediaStart === 0,
  };
}

// A retime replaces the whole take, so it fixes a stem only when one untrimmed cue is all the clamp
// cuts. The room is floored to the centisecond so the retimed take fits.
function retimeFor(spans: readonly CueSpan[], durationSec: number): AnimaticRetime | null {
  const cut = spans.filter((span) => span.end - durationSec > OVERFLOW_FLOOR);
  if (cut.length !== 1) return null;
  const [span] = cut as [CueSpan];
  if (!span.untrimmed) return null;
  const roomSec = Math.floor((durationSec - span.start) * 100) / 100;
  if (roomSec <= 0) return null;
  const rate = span.sourceSec / roomSec;
  if (rate > MAX_RETIME_RATE) return null;
  return { src: span.src, roomSec, rate };
}

/**
 * Every shot whose lines are cut by the clamp, in shot order. Reads state and the loaded animatic
 * only — no ffprobe — so `status` can carry it on a project of any size.
 */
export function findAnimaticOverflows(
  animatic: AnimaticDefinition,
  manager: StateManager,
  // One memo for the whole pass: resolution recurses through a candidate's inputs, so a per-cue
  // context re-explores the same upstream cone once per cue. A caller with its own hands it over;
  // the manager's carries whatever definitions were registered for the video.
  cache: StalenessCache = manager.stalenessCache(),
): AnimaticOverflow[] {
  const state = manager.getState();
  const overflows: AnimaticOverflow[] = [];
  for (const shot of animatic.shots) {
    const stems = listShotStems("animatic", shot);
    if (stems.length === 0) continue;
    const cues = harvestShotAudioStructure(animatic, shot.id);
    if (cues === null || cues.length === 0) continue;
    const durationSec = shot.duration;

    for (const stem of stems) {
      let neededSec = 0;
      let unmeasuredCues = 0;
      const spans: CueSpan[] = [];
      for (const cue of cues) {
        if (!stem.refs.includes(cue.src)) continue;
        const span = cueSpan(cue, shot.cueKinds?.[cue.src], state, cache);
        if (span === "unmeasured") unmeasuredCues++;
        else if (span !== "silent") {
          spans.push(span);
          neededSec = Math.max(neededSec, span.end);
        }
      }

      const overflowSec = neededSec - durationSec;
      if (overflowSec <= OVERFLOW_FLOOR) continue;
      overflows.push({
        shotId: shot.id,
        address: stem.address,
        durationSec,
        neededSec,
        overflowSec,
        unmeasuredCues,
        retime: unmeasuredCues === 0 ? retimeFor(spans, durationSec) : null,
      });
    }
  }
  return overflows;
}

/** One line of prose for a surface that reports these, without the address it is keyed by. */
export function formatAnimaticOverflow(o: AnimaticOverflow): string {
  const partial = o.unmeasuredCues > 0 ? ` (${o.unmeasuredCues} cue(s) not measured yet)` : "";
  return (
    `narration truncated by ${o.overflowSec.toFixed(1)}s — ` +
    `${o.neededSec.toFixed(1)}s of audio in a ${o.durationSec.toFixed(1)}s shot${partial}`
  );
}
