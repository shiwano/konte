import { KonteError } from "../errors.js";

// A take holding the song: where on the song it starts (null once it keeps no place on it, as a
// retimed one), and where each shot starts on the song — both seconds on the timeline. A board stem
// carries it, an asset built on one inherits it, and a `<Video>` of that asset reads its window off
// it.
export type SongSpan = { start: number | null; shotStarts: ReadonlyMap<string, number> };

const SONG_SPAN = Symbol("konte.songSpan");

// Kept off the enumerable fields, so no input hash or serialized definition sees it.
export function withSongSpan<T extends object>(asset: T, span: SongSpan | undefined): T {
  if (span) Object.defineProperty(asset, SONG_SPAN, { value: span, enumerable: false });
  return asset;
}

export function songSpanOf(value: unknown): SongSpan | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as { [SONG_SPAN]?: SongSpan })[SONG_SPAN];
}

// The span an asset's inputs carry: the first input, or element of an array input, cut to the song.
export function songSpanOfInputs(inputs: unknown): SongSpan | undefined {
  if (typeof inputs !== "object" || inputs === null) return undefined;
  for (const value of Object.values(inputs)) {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const span = songSpanOf(v);
      if (span) return span;
    }
  }
  return undefined;
}

// The span of a take whose first sample is `offset` seconds into the take it was made from, or
// which keeps no place on that take's clock (`offset` null).
export function shiftSongSpan(
  span: SongSpan | undefined,
  offset: number | null,
): SongSpan | undefined {
  if (!span || offset === 0) return span;
  return { ...span, start: offset === null || span.start === null ? null : span.start + offset };
}

// The `mediaStart` of a clip of a take cut to the song, placed `start` seconds into shot `shotId`:
// the seconds of the take already played by the time the song reaches that place. Undefined when the
// shot is not on the song's timeline, or the take keeps no place on the song.
export function songWindowStart(
  span: SongSpan,
  shotId: string,
  start: number,
  label: string,
): number | undefined {
  const shotStart = span.shotStarts.get(shotId);
  if (shotStart === undefined || span.start === null) return undefined;
  const mediaStart = shotStart + start - span.start;
  if (mediaStart < -1e-9) {
    throw new KonteError(
      "SONG_WINDOW_INVALID",
      `${label} places a take cut to the song at ${(shotStart + start).toFixed(3)}s on the song, ` +
        `before the take starts (${span.start.toFixed(3)}s). Place a take made from this shot's ` +
        `stem, or from an earlier shot's.`,
    );
  }
  return Math.max(0, mediaStart);
}
