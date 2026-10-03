import { formatReferenceAddress } from "./address.js";
import { KonteError } from "./errors.js";
import type { Direction } from "./dsl/direction.js";
import { stableStringify } from "./stable-stringify.js";
import { readSongReading, songAnalysisOf } from "./song-reading.js";
import type { KonteState, SongAnalysis, SongRecord } from "./types/index.js";

// The take of the song the piece is read against: the accepted one, else the newest analyzed take
// nobody dismissed. Staleness is not asked.
export type SongTake = { address: string; variantId: string; analysis: SongAnalysis };

export function songAddressOf(direction: Direction | null | undefined): string | null {
  const song = direction?.policy?.clock?.song;
  return song === undefined ? null : formatReferenceAddress(song);
}

// The take a song address resolves to by its state alone, read or not on disk.
function songTakeIdOf(state: KonteState, address: string): string | null {
  const variants = Object.entries(state.assets[address]?.variants ?? {});
  const accepted = variants.find(([, v]) => v.status === "accepted");
  if (accepted) return accepted[1].song ? accepted[0] : null;
  const [newest] = variants
    .filter(([, v]) => v.song && v.file && v.status !== "dismissed")
    .sort(([, a], [, b]) => (a.createdAt < b.createdAt ? 1 : -1));
  return newest?.[0] ?? null;
}

export function resolveSongTake(
  videoRoot: string,
  state: KonteState,
  address: string,
): SongTake | null {
  const variantId = songTakeIdOf(state, address);
  if (!variantId) return null;
  const record = state.assets[address]?.variants?.[variantId]?.song;
  const analysis = songAnalysisOf(videoRoot, address, variantId, record);
  return analysis ? { address, variantId, analysis } : null;
}

// The take-second the take's first bar head falls on: where a person set it, else where it was read.
export function songDownbeatSec(analysis: SongAnalysis): number {
  return analysis.downbeatSet ?? analysis.downbeatSec;
}

// The reading of the take each song address resolves to — the only song input a definition reads.
// Equal strings mean every definition built from them places its song the same.
export function songReadingsOf(videoRoot: string, state: KonteState): string {
  const readings: string[] = [];
  for (const [address, asset] of Object.entries(state.assets)) {
    const variantId = songTakeIdOf(state, address);
    const record = variantId ? asset.variants?.[variantId]?.song : undefined;
    if (record && readSongReading(videoRoot, address, variantId!, record)) {
      readings.push(`${address}|${variantId}|${stableStringify(record)}`);
    }
  }
  return readings.sort().join("\n");
}

// The take of the song a piece is cut against, read or not: the accepted one, else the newest with a
// file nobody dismissed.
export function currentSongTake(state: KonteState, address: string): string | null {
  const variants = Object.entries(state.assets[address]?.variants ?? {});
  const accepted = variants.find(([, v]) => v.status === "accepted");
  if (accepted) return accepted[0];
  const [newest] = variants
    .filter(([, v]) => v.file && v.status !== "dismissed")
    .sort(([, a], [, b]) => (a.createdAt < b.createdAt ? 1 : -1));
  return newest?.[0] ?? null;
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
