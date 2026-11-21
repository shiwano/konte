import { formatReferenceAddress } from "../address.js";
import { KonteError } from "../errors.js";
import { placeLyricLines } from "../song-lyrics.js";
import { songBeatAt, songBeatSec, type SongVariant } from "../song-variant.js";
import type { ShotClockContext, ShotLyricsContext } from "./animatic-builders.js";
import type {
  Direction,
  DirectionIndex,
  DirectionNode,
  LyricLine,
  LyricSection,
  Shot,
  Singer,
} from "./direction.js";

export function lyricText(line: LyricLine): string {
  return typeof line === "string" ? line : line.text;
}

export function singersOf(singer: Singer): readonly string[] {
  return typeof singer === "string" ? [singer] : singer;
}

export function lineSingers(section: LyricSection, line: LyricLine): readonly string[] {
  return singersOf(typeof line === "string" ? section.singer : line.singer);
}

export function songUnread(song: string): KonteError {
  const address = formatReferenceAddress(song);
  return new KonteError(
    "SONG_UNREAD",
    `${address} has no read take, so no shot's beats fall anywhere yet — generate it ` +
      "(`konte generate reference`, then `konte job run`), or read a take that has none " +
      "(`konte song analyze`)",
  );
}

// Where one shot sits on the timeline, in seconds on the canvas' frame grid. `startBeat` / `beats`
// are the song's count, present only on a direction with `policy.song`; there a shot has no seconds
// until a take of the song is read.
export type TimedShotTiming = {
  start: number;
  duration: number;
  startBeat?: number;
  beats?: number;
};
type BeatShotTiming = { start: null; duration: null; startBeat: number; beats: number };
export type ShotTiming = TimedShotTiming | BeatShotTiming;

// The one reading of the direction's clock every stage shares. Each cut lands on the frame nearest
// its place — on the song, the beat the spans before it sum to, `round(seconds × fps)` without one.
// A take-second falls `leadFrames` and then its own offset from beat 0 in: two takes that play a
// moment at one place after beat 0 put it on one frame.
export type DirectionTimeline = {
  fps: number;
  // The id of the song the piece is cut to (`policy.song`), null without one.
  song: string | null;
  // Beats to take-seconds and back on the read take of the song, and the meter it is read to play
  // in; null without a song or a read take.
  songGrid: {
    beatSec: (beat: number) => number;
    beatAt: (sec: number) => number;
    beatsPerBar: number;
  } | null;
  // Frames of the song take before beat 0, which the first shot holds; 0 without a read take.
  leadFrames: number;
  // Every shot, asides included, in direction order.
  timings: Map<string, ShotTiming>;
};

// What a shot's own span counts in: beats on the song, seconds without it. A span the author did not
// write (a computed direction, `shot-span-mismatch`) counts as nothing.
export function shotSpan(shot: Shot, song: string | null | undefined): number {
  return (song ? shot.beats : shot.duration) ?? 0;
}

function shotsInClockOrder(node: DirectionNode): Shot[] {
  if (Array.isArray(node.shots)) return node.shots;
  return (node.sequences ?? []).flatMap(shotsInClockOrder);
}

// A time a build reads, on the frame grid and exact: two readings of one place are one number
// whatever arithmetic reached them, so a prompt or a composition written from it hashes the same.
export function onFrames(sec: number, fps: number): number {
  return Math.round(sec * fps) / fps;
}

// The timeline second of beat `beat`, counted from the song's beat 0, on the frame grid; 0 with no
// read take.
export function beatTime(
  timeline: Pick<DirectionTimeline, "songGrid" | "fps" | "leadFrames">,
  beat: number,
): number {
  const { songGrid, fps } = timeline;
  return songGrid ? takeFrame(timeline, songGrid.beatSec(beat)) / fps : 0;
}

// The timeline frame a take-second falls on (see `DirectionTimeline`).
function takeFrame(
  timeline: Pick<DirectionTimeline, "songGrid" | "fps" | "leadFrames">,
  sec: number,
): number {
  const beat0 = timeline.songGrid?.beatSec(0) ?? 0;
  return timeline.leadFrames + Math.round((sec - beat0) * timeline.fps);
}

// Where every shot starts on the timeline. A piece cut to its song has no starts until a take of it
// is read.
export function shotStartsOf(timeline: DirectionTimeline): Map<string, number> {
  const starts = new Map<string, number>();
  for (const [id, t] of timeline.timings) {
    if (t.start === null) throw songUnread(timeline.song!);
    starts.set(id, t.start);
  }
  return starts;
}

// The timing of a shot with seconds, or the stop a piece cut to its unread song makes.
export function timedShot(timeline: DirectionTimeline, timing: ShotTiming): TimedShotTiming {
  if (timing.start === null) throw songUnread(timeline.song!);
  return timing;
}

function leadFramesOf(variant: SongVariant | null, fps: number): number {
  return variant ? Math.max(0, Math.round(songBeatSec(variant.analysis, 0) * fps)) : 0;
}

function songGridOf(variant: SongVariant | null): DirectionTimeline["songGrid"] {
  if (!variant) return null;
  const analysis = variant.analysis;
  return {
    beatSec: (beat) => songBeatSec(analysis, beat),
    beatAt: (sec) => songBeatAt(analysis, sec),
    beatsPerBar: analysis.beatsPerBar,
  };
}

export function readDirectionTimeline(
  direction: Direction,
  variant: SongVariant | null,
): DirectionTimeline {
  const fps = direction.policy.format.fps;
  const song = direction.policy.song ?? null;
  const songGrid = song ? songGridOf(variant) : null;
  const leadFrames = songGrid ? leadFramesOf(variant, fps) : 0;
  const timings = new Map<string, ShotTiming>();
  let sum = 0;
  let edge = 0;
  for (const shot of shotsInClockOrder(direction.sequence)) {
    const span = shotSpan(shot, song);
    const startBeat = sum;
    sum += span;
    if (song && !songGrid) {
      timings.set(shot.id, { start: null, duration: null, startBeat, beats: span });
      continue;
    }
    const at = songGrid
      ? takeFrame({ songGrid, fps, leadFrames }, songGrid.beatSec(sum))
      : Math.round(sum * fps);
    // At least one frame, so a shot that holds nothing still has a picture to cut to.
    const next = Math.max(edge + 1, at);
    timings.set(shot.id, {
      start: edge / fps,
      duration: (next - edge) / fps,
      ...(song ? { startBeat, beats: span } : {}),
    });
    edge = next;
  }
  return { fps, song, songGrid, leadFrames, timings };
}

// One declared lyric line and where it falls on the timeline, in seconds from the take's start —
// `start` and `end` null where neither the take nor a person places it. `set` marks a line a person
// placed on the take (`konte song set --line`).
export type LyricPlacementEntry = {
  // `<section>.<line>`, both counted from 1.
  key: string;
  section: string;
  text: string;
  singer: readonly string[];
} & ({ start: number; end: number; set: boolean } | { start: null; end: null; set: false });

// Where the direction's lyric lines fall, read off a take of the song (see `placeLyricLines`), a
// line a person placed on the take where they placed it. The timeline runs on the take's clock: a
// line sung at take-second t falls at t, counted in frames from the lead, so a line sung at the same
// place after beat 0 reads the same whatever lead the take has.
export function placeDirectionLyrics(
  direction: Direction,
  variant: SongVariant | null,
): LyricPlacementEntry[] {
  const lyrics = direction.lyrics;
  if (!direction.policy.song || !lyrics) return [];
  const fps = direction.policy.format.fps;
  const setLines = variant?.analysis.lines ?? {};
  const lines = lyrics.flatMap((section, s) =>
    section.lines.map((line, l) => {
      const key = `${s + 1}.${l + 1}`;
      const text = lyricText(line);
      const set = setLines[key];
      return {
        key,
        section: section.label,
        text,
        singer: lineSingers(section, line),
        ...(set && set.text === text
          ? { set: { startSec: set.startSec, endSec: set.endSec } }
          : {}),
      };
    }),
  );
  const timeline = { songGrid: songGridOf(variant), fps, leadFrames: leadFramesOf(variant, fps) };
  const onTimeline = (sec: number) => takeFrame(timeline, sec) / fps;
  const placements = placeLyricLines({
    lines: lines.map((line) => ({ text: line.text, ...(line.set ? { set: line.set } : {}) })),
    heard: variant?.analysis.heard ?? null,
    phrases: variant?.analysis.phrases ?? null,
  });
  return lines.map((line, i): LyricPlacementEntry => {
    const placed = placements[i] ?? null;
    const at = { key: line.key, section: line.section, text: line.text, singer: line.singer };
    return placed
      ? {
          ...at,
          start: onTimeline(placed.startSec),
          end: onTimeline(placed.endSec),
          set: placed.set,
        }
      : { ...at, start: null, end: null, set: false };
  });
}

// The lines a span of the timeline hears, from its head: every placed line sounding inside
// [from, from + duration), cut to it at its head.
type SpanLyric = { text: string; singer: readonly string[]; start: number; end: number };

export function lyricsInSpan(
  placed: readonly LyricPlacementEntry[],
  from: number,
  duration: number,
  fps: number,
): SpanLyric[] {
  return placed.flatMap((line) => {
    if (line.start === null) return [];
    const end = line.end;
    if (line.start >= from + duration || end <= from) return [];
    // A line sung from before the span opens at its head: a timed layer the runtime starts at 0
    // would otherwise keep its whole length and run into the next line.
    return [
      {
        text: line.text,
        singer: line.singer,
        start: onFrames(Math.max(0, line.start - from), fps),
        end: onFrames(end - from, fps),
      },
    ];
  });
}

// What a span of the timeline hears and counts, from its head — the context an overlay's build
// receives: on the song, the second of the span's `n`th beat on the take's beats; with lyrics, the
// lines sung inside it.
export function spanSongContext(
  index: DirectionIndex,
  start: number,
  duration: number,
): Partial<ShotClockContext & ShotLyricsContext> {
  const { fps, timings, songGrid, leadFrames } = index.timeline;
  if (!songGrid) return {};
  // A span opening on a cut starts on that cut's beat: the frame a beat lands on is rounded, so
  // reading the beat back from the frame would miss it.
  const cut = [...timings.values()].find(
    (t) => t.start !== null && Math.abs(t.start - start) < 1e-9,
  );
  const startBeat =
    cut?.startBeat ?? songGrid.beatAt(songGrid.beatSec(0) + start - leadFrames / fps);
  return {
    beat: (n: number) => onFrames(beatTime(index.timeline, startBeat + n) - start, fps),
    ...(index.lyrics ? { lyrics: lyricsInSpan(index.lyrics, start, duration, fps) } : {}),
  };
}

// Every character a shot's frame or cutin holds: its `lineup`, `lineupTo` and `passing`.
export function framedCharacterIds(index: DirectionIndex, shotId: string): Set<string> {
  const cutin = index.cutinById.get(shotId);
  return new Set([
    ...(index.lineupById.get(shotId) ?? []),
    ...(index.lineupToById.get(shotId) ?? []),
    ...(index.passingById.get(shotId) ?? []),
    ...(cutin?.lineup ?? []),
    ...(cutin?.lineupTo ?? []),
    ...(cutin?.passing ?? []),
  ]);
}

// What of a board shot's span of the song a motion model hears (`ShotDefinition.songStem`): the
// vocals over the lines a character in the shot's frame or cutin sings, else the instrumental.
export function shotSongStem(
  index: DirectionIndex,
  shotId: string,
  start: number,
  duration: number,
): { part: "vocals"; windows: { start: number; duration: number }[] } | { part: "instrumental" } {
  const inFrame = framedCharacterIds(index, shotId);
  const sung = index.lyrics
    ? lyricsInSpan(index.lyrics, start, duration, index.timeline.fps)
        .filter((line) => line.singer.some((id) => inFrame.has(id)))
        .map((line) => ({ start: line.start, end: Math.min(line.end, duration) }))
        .filter((line) => line.end > line.start)
        .sort((a, b) => a.start - b.start)
    : [];
  const merged: { start: number; end: number }[] = [];
  for (const line of sung) {
    const last = merged.at(-1);
    if (last && line.start <= last.end) last.end = Math.max(last.end, line.end);
    else merged.push({ ...line });
  }
  if (merged.length === 0) return { part: "instrumental" };
  return {
    part: "vocals",
    windows: merged.map((w) => ({ start: w.start, duration: w.end - w.start })),
  };
}
