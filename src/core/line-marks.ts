// Where a reel shot's lines are heard on the reel: each line's marks (what a take gets wrong of it,
// or what its clip cuts) and the reel second each of its characters is heard at.

import { isNarrationStemAddress } from "./address.js";
import { type CompositionClip, harvestShotAudioStructure } from "./composition-builder.js";
import type { StageDefinitions } from "./definition-hashes.js";
import type { Direction } from "./dsl/direction.js";
import { alignHeard, type HeardLine, markedGaps, type SaidLine } from "./line-hearing.js";
import { recognizesSpeechIn } from "./sherpa-binary.js";
import { type HearingProfile, loadHearing } from "./hearing/index.js";
import { linesSaidAt, readHeardSpeech } from "./speech-hearing.js";
import type { StateManager } from "./state/index.js";
import type { AnimaticDefinition } from "./types/index.js";
import { variantOwningFile } from "./variant-dir.js";

export interface LineMarks {
  // The line's number in the shot's script, 1-based.
  line: number;
  // Each a range of the line (an insert zero-width) and the reel seconds it is heard over.
  marks: { range: [number, number]; time: [number, number] }[];
  // The reel second each character of the line is heard at.
  timeAt: (number | null)[];
}

// The lines one take at a clip's address says, on the reel. `resolved` where it is the take the
// address resolves to; the page shows another in its place where it swaps one in.
export interface HeardTake {
  address: string;
  variantId: string;
  resolved: boolean;
  lines: LineMarks[];
}

// The takes at an address that say lines in a clip, and the clip-local second each of their
// seconds plays at.
type SpokenSource = {
  address: string;
  // The take the address resolves to, then every other the page can show in its place.
  variantIds: string[];
  // Whether the clip plays the take itself, not a stem mixed from it.
  direct: boolean;
  // Take-second → the clip's media second.
  toMedia: (t: number) => number;
  // The media seconds the take plays over in the clip's media, where a stem mixed from it trims it.
  mediaWindow?: [number, number];
};

function sourcesOf(
  clip: CompositionClip,
  shotId: string,
  manager: StateManager,
  animatic: AnimaticDefinition | null,
): SpokenSource[] {
  const address = clip.address;
  if (!address) return [];
  if (!isNarrationStemAddress(address)) {
    const resolved =
      clip.variantId ?? manager.resolveReference(address, { includeStale: true })?.variantId;
    const others = Object.entries(manager.getState().assets[address]?.variants ?? {})
      .filter(([id, v]) => id !== resolved && v.file && v.status !== "dismissed")
      .map(([id]) => id);
    return resolved
      ? [{ address, variantIds: [resolved, ...others], direct: true, toMedia: (t) => t }]
      : [];
  }
  // A board's narration stem mixes the board shot's narration cues on the board shot's clock.
  const shot = animatic?.shots.find((s) => s.id === shotId);
  const cues = animatic ? (harvestShotAudioStructure(animatic, shotId) ?? []) : [];
  return cues.flatMap((cue) => {
    if (shot?.cueKinds?.[cue.src] !== "narration") return [];
    const variantId = manager.resolveReference(cue.src, { includeStale: true })?.variantId;
    if (!variantId) return [];
    const start = cue.start ?? 0;
    const mediaStart = cue.mediaStart ?? 0;
    const end = cue.duration === null ? Number.POSITIVE_INFINITY : start + cue.duration;
    return [
      {
        address: cue.src,
        variantIds: [variantId],
        direct: false,
        toMedia: (t: number) => start + (t - mediaStart) / cue.rate,
        mediaWindow: [start, end],
      },
    ];
  });
}

/**
 * The reel seconds a clip plays over, in a shot opening at `shotStart`. An `<Audio>` declaring no
 * `duration` plays its take out, past the shot's end, where the take's length (`takeSec`) is known.
 */
export function clipWindow(
  clip: CompositionClip,
  shotStart: number,
  takeSec: number | undefined,
): [number, number] {
  const start = shotStart + clip.start;
  if (clip.mediaType !== "audio" || clip.bounded || takeSec === undefined) {
    return [start, shotStart + clip.end];
  }
  return [start, start + (takeSec - (clip.mediaStart ?? 0)) / (clip.playbackRate ?? 1)];
}

/**
 * Each line's marks on the reel, its take's seconds placed by `reelAt` (null where the take is not
 * placed) and played over `window`: a line's heard characters outside it are cut, and marked.
 */
export function reelLineMarks(
  lines: readonly SaidLine[],
  aligned: readonly HeardLine[],
  hearing: HearingProfile,
  reelAt: (t: number) => number | null,
  [from, to]: readonly [number, number],
): LineMarks[] {
  const plays = (t: number | null): t is number => t !== null && t >= from && t < to;
  return lines.map((line, i) => {
    const { secAt, gaps } = aligned[i]!;
    const heardAt = secAt.map((s) => (s === null ? null : reelAt(s)));
    const marks: LineMarks["marks"] = markedGaps(gaps, hearing).flatMap((gap) => {
      const start = reelAt(gap.sec[0]);
      const end = reelAt(gap.sec[1]);
      return start === null || end === null ? [] : [{ range: gap.range, time: [start, end] }];
    });
    for (let c = 0; c < heardAt.length; ) {
      if (heardAt[c] === null || plays(heardAt[c]!)) {
        c++;
        continue;
      }
      let e = c;
      while (e < heardAt.length && !plays(heardAt[e]!)) e++;
      const cut = heardAt.slice(c, e).filter((t): t is number => t !== null);
      marks.push({ range: [c, e], time: [Math.min(...cut), Math.max(...cut)] });
      c = e;
    }
    return {
      line: line.number,
      marks: marks.sort((x, y) => x.range[0] - y.range[0]),
      timeAt: heardAt.map((t) => (plays(t) ? t : null)),
    };
  });
}

/**
 * The marks of every line of shot `shotId` its `clips` sound, on the reel the shot opens at
 * `shotStart`, for every take the page can show at each address. A take never heard says none;
 * nor does any in a language not heard.
 */
export async function shotLineMarks(opts: {
  videoRoot: string;
  manager: StateManager;
  definitions: StageDefinitions;
  direction: Direction | null;
  animatic: AnimaticDefinition | null;
  lang: string;
  shotId: string;
  shotStart: number;
  clips: readonly CompositionClip[];
}): Promise<HeardTake[]> {
  const { manager, lang } = opts;
  if (!recognizesSpeechIn(lang)) return [];
  const state = manager.getState();
  const out: HeardTake[] = [];
  for (const clip of opts.clips) {
    if (!clip.hasAudio) continue;
    const clipStart = opts.shotStart + clip.start;
    const toReel = (media: number) =>
      clipStart + (media - (clip.mediaStart ?? 0)) / (clip.playbackRate ?? 1);
    for (const source of sourcesOf(clip, opts.shotId, manager, opts.animatic)) {
      const said = linesSaidAt(opts.definitions, opts.direction, source.address);
      if (!said.scripted) continue;
      const reelAt = (t: number) => toReel(source.toMedia(t));
      for (const [i, variantId] of source.variantIds.entries()) {
        const variant = state.assets[source.address]?.variants?.[variantId];
        if (!variant) continue;
        const owner = (variant.file && variantOwningFile(state, variant.file)) || {
          address: source.address,
          variantId,
        };
        const heard = readHeardSpeech(
          opts.videoRoot,
          owner.address,
          owner.variantId,
          variant.outputHash,
        );
        if (!heard) continue;
        const hearing = await loadHearing(lang);
        const media = variant.media;
        const durationSec = media && "durationSec" in media ? media.durationSec : undefined;
        const aligned = alignHeard(
          said.lines.map((l) => l.text),
          heard,
          hearing,
          durationSec ?? undefined,
        );
        const played = clipWindow(clip, opts.shotStart, source.direct ? durationSec : undefined);
        // What the stem trims of the take is cut as much as what the clip trims of the stem.
        const window: [number, number] = source.mediaWindow
          ? [
              Math.max(played[0], toReel(source.mediaWindow[0])),
              Math.min(played[1], toReel(source.mediaWindow[1])),
            ]
          : played;
        out.push({
          address: source.address,
          variantId,
          resolved: i === 0,
          lines: reelLineMarks(said.lines, aligned, hearing, reelAt, window),
        });
      }
    }
  }
  return out;
}
