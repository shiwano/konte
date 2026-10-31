// The locator grammar of a video's source: how a chunk, a position inside one and a span of
// chunks are written, per kind. A chunk id alone fixes its kind.
//
//   kind   chunk                      position   range in a chunk    span
//   text   c3, s5.c2, c3.2            c3.p12     c3.p12-p18          c3-c5, s5
//   comic  v1.b3                      v1.p31     v1.p31-p34          v1.b3-b5, v1
//   clip   w3                         01:12.5    01:12.5-01:30.0     w2-w4
//
// Numbers are never zero-padded; a file name is (`chunkFileStems`).

import * as path from "node:path";

export type SourceKind = "text" | "comic" | "clip";

const N = "[1-9]\\d*";
const TEXT_PREFIX = `(?:s${N}\\.)?c${N}`;
const TEXT_CHUNK = new RegExp(`^(${TEXT_PREFIX})(?:\\.${N})?$`);
const COMIC_CHUNK = new RegExp(`^(v${N})\\.b${N}$`);
const CLIP_CHUNK = new RegExp(`^w${N}$`);
const CLOCK = "(?:\\d+:)?\\d{1,2}:\\d{2}(?:\\.\\d+)?";

const TEXT_EXTS = new Set([".txt", ".md", ".epub"]);
const COMIC_EXTS = new Set([".cbz", ".pdf", ".zip"]);
const CLIP_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);

/** The kind a source's original is read as, off its form; null where konte reads no such file. */
export function sourceKindOfFile(file: string, isDirectory: boolean): SourceKind | null {
  if (isDirectory) return "comic";
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTS.has(ext)) return "text";
  if (COMIC_EXTS.has(ext)) return "comic";
  if (CLIP_EXTS.has(ext)) return "clip";
  return null;
}

/** The kind a chunk id is written in, or null where it is no chunk id. */
export function chunkKind(chunk: string): SourceKind | null {
  if (TEXT_CHUNK.test(chunk)) return "text";
  if (COMIC_CHUNK.test(chunk)) return "comic";
  if (CLIP_CHUNK.test(chunk)) return "clip";
  return null;
}

/**
 * What a position in `chunk` is written after: its chapter for text (`c3.2` → `c3`, whose paragraphs
 * are numbered through the chapter), its volume for comic, nothing for clip.
 */
export function chunkPositionPrefix(chunk: string): string {
  const text = TEXT_CHUNK.exec(chunk);
  if (text) return text[1]!;
  const comic = COMIC_CHUNK.exec(chunk);
  if (comic) return comic[1]!;
  return "";
}

// `m:ss(.s)` or `h:mm:ss(.s)`, in seconds.
export function parseClock(text: string): number {
  const parts = text.split(":").map(Number);
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

/** `mm:ss.s`, the clock a clip locator is written on. */
export function formatClipClock(sec: number): string {
  const tenths = Math.round(sec * 10);
  const whole = Math.floor(tenths / 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths % 10}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

// A position or a range inside one chunk: paragraphs (text), pages (comic) or seconds (clip),
// inclusive, after the chunk's position prefix.
export type ParsedAt = { prefix: string; from: number; to: number };

/** `at` as written in `kind`, or null where it is not one. */
export function parseAt(kind: SourceKind, at: string): ParsedAt | null {
  if (kind === "clip") {
    const m = new RegExp(`^(${CLOCK})(?:-(${CLOCK}))?$`).exec(at);
    if (!m) return null;
    const from = parseClock(m[1]!);
    const to = m[2] ? parseClock(m[2]) : from;
    return to >= from ? { prefix: "", from, to } : null;
  }
  const prefix = kind === "text" ? TEXT_PREFIX : `v${N}`;
  const m = new RegExp(`^(${prefix})\\.p(${N})(?:-p(${N}))?$`).exec(at);
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] ? Number(m[3]) : from;
  return to >= from ? { prefix: m[1]!, from, to } : null;
}

/** The chunk a scene id (`<chunk>.s<n>`) belongs to, or null where it is no scene id. */
export function sceneChunk(sceneId: string): string | null {
  const m = new RegExp(`^(.+)\\.s${N}$`).exec(sceneId);
  return m && chunkKind(m[1]!) ? m[1]! : null;
}

// A span as written: one selector (a chunk, a chapter, a story, a volume) or two joined by `-`, the
// second of which may drop the leading segments it shares with the first (`v1.b3-b5`).
export type ParsedSpan = { from: string; to: string };

function isSelector(text: string): boolean {
  return (
    chunkKind(text) !== null ||
    new RegExp(`^s${N}$`).test(text) ||
    new RegExp(`^v${N}$`).test(text) ||
    new RegExp(`^${TEXT_PREFIX}$`).test(text)
  );
}

export function parseSpan(span: string): ParsedSpan | null {
  const parts = span.split("-");
  if (parts.length === 1) return isSelector(span) ? { from: span, to: span } : null;
  if (parts.length !== 2) return null;
  const [from, short] = parts as [string, string];
  const head = from.split(".");
  const tail = short.split(".");
  const to =
    tail.length < head.length
      ? [...head.slice(0, head.length - tail.length), ...tail].join(".")
      : short;
  return isSelector(from) && isSelector(to) ? { from, to } : null;
}

/** Whether chunk `chunk` is, or lies under, `selector`. */
export function chunkUnder(chunk: string, selector: string): boolean {
  return chunk === selector || chunk.startsWith(`${selector}.`);
}

/** The chunks `span` covers, in order, out of every chunk of the source; null where it covers none. */
export function resolveSpan(span: ParsedSpan, chunks: readonly string[]): string[] | null {
  const first = chunks.findIndex((c) => chunkUnder(c, span.from));
  const last = chunks.findLastIndex((c) => chunkUnder(c, span.to));
  if (first === -1 || last === -1 || last < first) return null;
  return chunks.slice(first, last + 1);
}

/**
 * The file stem each chunk is written under: every level's number padded to the widest at that level,
 * two digits at least (`c03`, `s05.c02`, `c03.02`).
 */
export function chunkFileStems(chunks: readonly string[]): Map<string, string> {
  const split = (id: string) =>
    id.split(".").map((seg, i) => {
      const m = /^([a-z]*)(\d+)$/.exec(seg)!;
      return { key: `${i}:${m[1]}`, letter: m[1]!, num: m[2]! };
    });
  const widths = new Map<string, number>();
  for (const id of chunks) {
    for (const seg of split(id)) {
      widths.set(seg.key, Math.max(widths.get(seg.key) ?? 2, seg.num.length));
    }
  }
  return new Map(
    chunks.map((id) => [
      id,
      split(id)
        .map((seg) => seg.letter + seg.num.padStart(widths.get(seg.key)!, "0"))
        .join("."),
    ]),
  );
}
