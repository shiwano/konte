import { formatReferenceAddress } from "./address.js";
import { KonteError } from "./errors.js";
import type { Direction } from "./dsl/direction.js";
import { stableStringify } from "./stable-stringify.js";
import type { KonteState, SongAnalysis } from "./types/index.js";

// The take of the song the piece is read against: the accepted one, else the newest analyzed take
// nobody dismissed. Staleness is not asked.
export type SongTake = { address: string; variantId: string; analysis: SongAnalysis };

export function songAddressOf(direction: Direction | null | undefined): string | null {
  const song = direction?.policy?.clock?.song;
  return song === undefined ? null : formatReferenceAddress(song);
}

export function resolveSongTake(state: KonteState, address: string): SongTake | null {
  const variants = Object.entries(state.assets[address]?.variants ?? {});
  const accepted = variants.find(([, v]) => v.status === "accepted");
  if (accepted) {
    const [variantId, v] = accepted;
    return v.song ? { address, variantId, analysis: v.song } : null;
  }
  const analyzed = variants
    .filter(([, v]) => v.song && v.file && v.status !== "dismissed")
    .sort(([, a], [, b]) => (a.createdAt < b.createdAt ? 1 : -1));
  const [newest] = analyzed;
  return newest ? { address, variantId: newest[0], analysis: newest[1].song! } : null;
}

// The reading of the take each song address resolves to — the only song input a definition reads.
// Equal strings mean every definition built from them places its song the same.
export function songReadingsOf(state: KonteState): string {
  const readings: string[] = [];
  for (const [address, asset] of Object.entries(state.assets)) {
    if (!Object.values(asset.variants ?? {}).some((v) => v.song)) continue;
    const take = resolveSongTake(state, address);
    if (take) readings.push(`${address}|${take.variantId}|${stableStringify(take.analysis)}`);
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

// A take's reading with lyric line `key` placed on it by a person, or no longer placed by one
// (`span` null). `lines` are the direction's lines in singing order; a placed line opens after
// every earlier line a person placed and before every later one.
export function setSongLine(
  analysis: SongAnalysis,
  lines: readonly { key: string; text: string }[],
  key: string,
  span: { startSec: number; endSec: number } | null,
  durationSec: number,
): SongAnalysis {
  return setSongLines(analysis, lines, [{ key, span }], durationSec);
}

// Several lines placed at once, their order judged on the reading they leave together — a line may
// move past where another stood so long as that one moves too.
export function setSongLines(
  analysis: SongAnalysis,
  lines: readonly { key: string; text: string }[],
  edits: readonly { key: string; span: { startSec: number; endSec: number } | null }[],
  durationSec: number,
): SongAnalysis {
  const { lines: before, ...reading } = analysis;
  const set = { ...before };
  const setAt = new Date().toISOString();
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
    set[key] = { text: line.text, ...span, setAt };
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
  return Object.keys(set).length > 0 ? { ...reading, lines: set } : reading;
}
