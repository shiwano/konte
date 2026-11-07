// Where a reel shot's lines are heard on the reel: each line's marks (what a take gets wrong of it,
// or what its clip cuts) and the reel second each of its characters is heard at.

import { isHeardStemAddress, listShotStems, STEM_ASSET_NAME, tryParseAddress } from "./address.js";
import { type CompositionClip, harvestShotAudioStructure } from "./composition-builder.js";
import { definitionForAddress, type StageDefinitions } from "./definition-hashes.js";
import type { Direction } from "./dsl/direction.js";
import { alignHeard, type HeardLine, markedGaps, type SaidLine } from "./line-hearing.js";
import { definitionHashForAddress } from "./composition-resource.js";
import { recognizesSpeechIn } from "./sherpa-binary.js";
import { type HearingProfile, loadHearing } from "./hearing/index.js";
import { linesSaidAt, readHeardSpeech } from "./speech-hearing.js";
import type { StateManager } from "./state/index.js";
import type { AnimaticDefinition, HeardSpeech, KonteState, VariantMedia } from "./types/index.js";
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
export type SpokenSource = {
  address: string;
  // The take the address resolves to, then every other the page can show in its place.
  variantIds: string[];
  // Whether the clip plays the take itself, not a stem mixed from it.
  direct: boolean;
  // Take-second → the clip's media second.
  toMedia: (t: number) => number;
  // The media seconds the take plays over in the clip's media, where a stem mixed from it trims it.
  mediaWindow?: [number, number];
  // The lines it says where no definition owes them: a take made from a stem whose cues moved since.
  lines?: SaidLine[];
};

// The cues a board shot's stem at `stemAddress` mixes, each on the stem's clock: the narration and
// off-frame stems' lines, the shot stem's every other cue but the song. Each cue is the take the stem
// variant `stemVariantId` was mixed from, where that variant mixed the cues the board places now;
// where it mixed others, the stem is heard as the sound of the take at `own`.
function stemCueSources(
  stemAddress: string,
  stemVariantId: string | null,
  own: { address: string; variantId: string },
  opts: SourceOpts,
): SpokenSource[] {
  const { manager, animatic } = opts;
  const parsed = tryParseAddress(stemAddress);
  if (!animatic || parsed?.kind !== "shot") return [];
  const shot = animatic.shots.find((s) => s.id === parsed.shotId);
  const state = manager.getState();
  const mixed = stemVariantId ? state.assets[stemAddress]?.variants?.[stemVariantId] : undefined;
  // A variant mixed before a cue left the stem (an off-frame line split out) still plays it.
  const mixes = new Set([
    ...((shot && listShotStems("animatic", shot).find((s) => s.address === stemAddress)?.refs) ??
      []),
    ...Object.keys(mixed?.inputFingerprints ?? {}),
  ]);
  const cues = (harvestShotAudioStructure(animatic, parsed.shotId) ?? []).filter(
    (cue) => cue.track === "sound" && mixes.has(cue.src),
  );
  if (mixed && mixed.definitionHash !== definitionHashForAddress(animatic, stemAddress)) {
    const lines = cues.flatMap(
      (cue) => linesSaidAt(opts.definitions, opts.direction, cue.src).lines,
    );
    return lines.length > 0
      ? [
          {
            address: own.address,
            variantIds: [own.variantId],
            direct: true,
            toMedia: (t) => t,
            lines,
          },
        ]
      : [];
  }
  const takeOf = (src: string) => {
    const hash = mixed?.inputFingerprints?.[src];
    const kept = hash
      ? Object.entries(state.assets[src]?.variants ?? {}).find(([, v]) => v.outputHash === hash)
      : undefined;
    return kept?.[0] ?? manager.resolveReference(src, { includeStale: true })?.variantId;
  };
  return cues.flatMap((cue) => {
    const variantId = takeOf(cue.src);
    if (!variantId) return [];
    const start = cue.start ?? 0;
    const mediaStart = cue.mediaStart ?? 0;
    const played = cue.duration === null ? Number.POSITIVE_INFINITY : start + cue.duration;
    // The stem is cut at the board shot's end.
    const end = Math.min(played, shot?.duration ?? Number.POSITIVE_INFINITY);
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

function isBoardStemAddress(address: string): boolean {
  const parsed = tryParseAddress(address);
  return (
    isHeardStemAddress(address) ||
    (parsed?.stage === "animatic" &&
      parsed.kind === "shot" &&
      parsed.assetName === STEM_ASSET_NAME &&
      !parsed.delivery)
  );
}

type SourceOpts = {
  manager: StateManager;
  definitions: StageDefinitions;
  direction: Direction | null;
  animatic: AnimaticDefinition | null;
};

/**
 * The takes that say lines in a clip. A board stem the clip plays is its cues; a take that owes
 * no line of its own but was made from a board stem (a model's `stem` input) is heard as the cues
 * of the stem it consumed, on the take's clock.
 */
export function spokenSourcesOf(clip: CompositionClip, opts: SourceOpts): SpokenSource[] {
  const { manager } = opts;
  const address = clip.address;
  if (!address) return [];
  const resolved =
    clip.variantId ?? manager.resolveReference(address, { includeStale: true })?.variantId;
  if (isBoardStemAddress(address)) {
    // A stem not yet mixed plays live, off the cues the board places now.
    return stemCueSources(address, resolved ?? null, { address, variantId: resolved ?? "" }, opts);
  }
  if (resolved && !linesSaidAt(opts.definitions, opts.direction, address).scripted) {
    const def = definitionForAddress(opts.definitions, address);
    const stem =
      def && "stemInputs" in def
        ? def.stemInputs?.find((s) => s.address === address)?.source
        : undefined;
    if (stem && isBoardStemAddress(stem)) {
      const state = manager.getState();
      const consumed = state.assets[address]?.variants?.[resolved]?.inputFingerprints?.[stem];
      const stemVariant = consumed
        ? Object.entries(state.assets[stem]?.variants ?? {}).find(
            ([, v]) => v.outputHash === consumed,
          )?.[0]
        : manager.resolveReference(stem, { includeStale: true })?.variantId;
      return stemCueSources(stem, stemVariant ?? null, { address, variantId: resolved }, opts);
    }
  }
  const others = Object.entries(manager.getState().assets[address]?.variants ?? {})
    .filter(([id, v]) => id !== resolved && v.file && v.status !== "dismissed")
    .map(([id]) => id);
  return resolved
    ? [{ address, variantIds: [resolved, ...others], direct: true, toMedia: (t) => t }]
    : [];
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
    const toReel = clipReelClock(clip, opts.shotStart);
    for (const source of spokenSourcesOf(clip, opts)) {
      const said = saidBy(source, opts);
      if (!said.scripted) continue;
      const reelAt = (t: number) => toReel(source.toMedia(t));
      for (const [i, variantId] of source.variantIds.entries()) {
        const variant = state.assets[source.address]?.variants?.[variantId];
        if (!variant) continue;
        const heard = readTakeHeard(opts.videoRoot, state, source.address, variantId);
        if (!heard) continue;
        const hearing = await loadHearing(lang);
        const durationSec = takeDurationSec(variant.media);
        const aligned = alignHeard(
          said.lines.map((l) => l.text),
          heard,
          hearing,
          durationSec,
        );
        out.push({
          address: source.address,
          variantId,
          resolved: i === 0,
          lines: reelLineMarks(
            said.lines,
            aligned,
            hearing,
            reelAt,
            sourceWindow(clip, opts.shotStart, source, durationSec),
          ),
        });
      }
    }
  }
  return out;
}

/** Media second → reel second, for a clip in a shot opening at `shotStart`. */
export function clipReelClock(clip: CompositionClip, shotStart: number): (media: number) => number {
  const clipStart = shotStart + clip.start;
  return (media) => clipStart + (media - (clip.mediaStart ?? 0)) / (clip.playbackRate ?? 1);
}

/**
 * The reel seconds a source plays over in a clip: what the stem trims of the take is cut as much as
 * what the clip trims of the stem.
 */
export function sourceWindow(
  clip: CompositionClip,
  shotStart: number,
  source: SpokenSource,
  durationSec: number | undefined,
): [number, number] {
  const played = clipWindow(clip, shotStart, source.direct ? durationSec : undefined);
  if (!source.mediaWindow) return played;
  const toReel = clipReelClock(clip, shotStart);
  return [
    Math.max(played[0], toReel(source.mediaWindow[0])),
    Math.min(played[1], toReel(source.mediaWindow[1])),
  ];
}

export function takeDurationSec(media: VariantMedia | null | undefined): number | undefined {
  return media && "durationSec" in media ? (media.durationSec ?? undefined) : undefined;
}

/** What a take is heard to say, read off the take that owns its file; null where never heard. */
export function readTakeHeard(
  videoRoot: string,
  state: KonteState,
  address: string,
  variantId: string,
): HeardSpeech["heard"] | null {
  const variant = state.assets[address]?.variants?.[variantId];
  if (!variant) return null;
  const owner = (variant.file && variantOwningFile(state, variant.file)) || { address, variantId };
  return readHeardSpeech(videoRoot, owner.address, owner.variantId, variant.outputHash);
}

/** The lines a source says, numbered by its shot's script. */
export function saidBy(
  source: SpokenSource,
  opts: Pick<SourceOpts, "definitions" | "direction">,
): { lines: SaidLine[]; scripted: boolean } {
  return source.lines
    ? { lines: source.lines, scripted: true }
    : linesSaidAt(opts.definitions, opts.direction, source.address);
}
