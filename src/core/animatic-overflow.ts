import { listShotStems } from "./address.js";
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
}

function cueEnd(
  cue: StemAudioEntry,
  kind: CueKind | undefined,
  state: KonteState,
  cache: StalenessCache,
): number | "unmeasured" | "silent" {
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
  return start + (cue.duration != null ? Math.min(cue.duration, available) : available);
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
      for (const cue of cues) {
        if (!stem.refs.includes(cue.src)) continue;
        const end = cueEnd(cue, shot.cueKinds?.[cue.src], state, cache);
        if (end === "unmeasured") unmeasuredCues++;
        else if (end !== "silent") neededSec = Math.max(neededSec, end);
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
