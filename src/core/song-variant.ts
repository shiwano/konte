import { acceptedVariant } from "./accepted-variant.js";
import { formatReferenceAddress } from "./address.js";
import { KonteError } from "./errors.js";
import type { Direction } from "./dsl/direction.js";
import { stableStringify } from "./stable-stringify.js";
import { readSongReading, songAnalysisOf } from "./song-reading.js";
import { nearestBeatIndex, type SongGridSource } from "./song-grid.js";
import type { KonteState, SongAnalysis, SongRecord } from "./types/index.js";
import type { SongVariantState } from "./direction.js";
import type { StateManager } from "./state/index.js";
import { mediaDurationSec } from "./variant-media.js";

// The take of the song the piece is read against: the accepted one, else the newest analyzed take
// nobody dismissed. Staleness is not asked.
export type SongVariant = { address: string; variantId: string; analysis: SongAnalysis };

export function songAddressOf(direction: Direction | null | undefined): string | null {
  const song = direction?.policy?.song;
  return song === undefined ? null : formatReferenceAddress(song);
}

// The take of the song a piece is cut against: the accepted one, else the newest with a file nobody
// dismissed. `analyzed` holds both to a take with a song record, read or not on disk.
export function currentSongVariant(
  state: KonteState,
  address: string,
  { analyzed = false }: { analyzed?: boolean } = {},
): string | null {
  const accepted = acceptedVariant(state, address);
  if (accepted) return !analyzed || accepted.variant.song ? accepted.variantId : null;
  const [newest] = Object.entries(state.assets[address]?.variants ?? {})
    .filter(([, v]) => (!analyzed || v.song) && v.file && v.status !== "dismissed")
    .sort(([, a], [, b]) => (a.createdAt < b.createdAt ? 1 : -1));
  return newest?.[0] ?? null;
}

export function resolveSongVariant(
  videoRoot: string,
  state: KonteState,
  address: string,
): SongVariant | null {
  const variantId = currentSongVariant(state, address, { analyzed: true });
  if (!variantId) return null;
  const record = state.assets[address]?.variants?.[variantId]?.song;
  const analysis = songAnalysisOf(videoRoot, address, variantId, record);
  return analysis ? { address, variantId, analysis } : null;
}

export {
  formatSongTempo,
  type SongGridSource,
  songBeatAt,
  songBeatSec,
  songTempo,
} from "./song-grid.js";

// A take's record with the read beat nearest `sec` made beat 0 by a person, or beat 0 left to the
// reading again (`sec` null).
export function setSongFirstBeat(
  record: SongRecord,
  reading: SongGridSource,
  sec: number | null,
): SongRecord {
  const { firstBeatSet: _, ...rest } = record;
  if (sec === null) return rest;
  if (reading.beats.length === 0) {
    throw new KonteError("VALIDATION_FAILED", "the take was read with no beats to make beat 0");
  }
  return { ...rest, firstBeatSet: reading.beats[nearestBeatIndex(reading.beats, sec)]! };
}

// The reading of the take each song address resolves to — the only song input a definition reads.
// Equal strings mean every definition built from them places its song the same.
export function songReadingsOf(videoRoot: string, state: KonteState): string {
  const readings: string[] = [];
  for (const [address, asset] of Object.entries(state.assets)) {
    const variantId = currentSongVariant(state, address, { analyzed: true });
    const record = variantId ? asset.variants?.[variantId]?.song : undefined;
    if (record && readSongReading(videoRoot, address, variantId!, record)) {
      readings.push(`${address}|${variantId}|${stableStringify(record)}`);
    }
  }
  return readings.sort().join("\n");
}

// A take's record with lyric line `key` placed on it by a person, or no longer placed by one
// (`span` null). `lines` are the direction's lines in singing order; a placed line opens after
// every earlier line a person placed and before every later one.
export function setSongLine(
  record: SongRecord,
  lines: readonly { key: string; text: string }[],
  key: string,
  span: { startSec: number; endSec: number } | null,
  durationSec: number,
): SongRecord {
  return setSongLines(record, lines, [{ key, span }], durationSec);
}

// Several lines placed at once, their order judged on the reading they leave together — a line may
// move past where another stood so long as that one moves too.
export function setSongLines(
  record: SongRecord,
  lines: readonly { key: string; text: string }[],
  edits: readonly { key: string; span: { startSec: number; endSec: number } | null }[],
  durationSec: number,
): SongRecord {
  const { lines: before, ...rest } = record;
  const set = { ...before };
  for (const { key, span } of edits) {
    const line = lines.find((l) => l.key === key);
    if (!line) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `line ${key}: direction.ts declares no such lyric line — lines are keyed ` +
          "<section>.<line>, from 1",
      );
    }
    if (!span) {
      delete set[key];
      continue;
    }
    if (!(span.startSec >= 0 && span.startSec < span.endSec && span.endSec <= durationSec)) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `line ${key}: placed ${span.startSec}s–${span.endSec}s — it must open at or after 0 and ` +
          `end after it opens, within the ${durationSec}s take`,
      );
    }
    set[key] = { text: line.text, ...span };
  }
  const placed = lines.flatMap((line) => {
    const at = set[line.key];
    return at && at.text === line.text ? [{ key: line.key, startSec: at.startSec }] : [];
  });
  placed.forEach((line, i) => {
    const next = placed[i + 1];
    if (!next || line.startSec < next.startSec) return;
    throw new KonteError(
      "VALIDATION_FAILED",
      `line ${line.key}: opens at ${line.startSec}s, after line ${next.key} at ` +
        `${next.startSec}s — lines open in the order they are sung`,
    );
  });
  return Object.keys(set).length > 0 ? { ...rest, lines: set } : rest;
}

// The take of the song the piece is read against, as the song class reads it.
export function songVariantState(manager: StateManager, direction: Direction): SongVariantState {
  const address = songAddressOf(direction);
  const variant = address
    ? resolveSongVariant(manager.videoRoot, manager.getState(), address)
    : null;
  const media = variant
    ? manager.getState().assets[variant.address]?.variants?.[variant.variantId]?.media
    : undefined;
  return { variant, durationSec: mediaDurationSec(media ?? null) };
}
