// What a video's source holds for an agent and a direction: its chunks, the digest readers wrote, the
// span a direction's `brief.source` covers, and the locator check.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Direction } from "./dsl/direction.js";
import type { SourceChunk, SourceLook, SourceScene } from "./dsl/source.js";
import { errorMessage } from "./errors.js";
import type { Finding } from "./finding.js";
import { speechLangOf, spokenSecOf } from "./source-speech.js";
import { chunkKind, formatClipClock, parseAt, parseSpan, resolveSpan } from "./source-locator.js";
import {
  DIGEST_DIR,
  DIGEST_FILE_PATTERN,
  SOURCE_DIR,
  type SourceExcerpt,
  type SourceRef,
  chunkStems,
  refreshStudyIndex,
  sourceExcerpt,
  sourceRefIn,
} from "./source-study.js";
import type { SourceStudyIndex } from "./types/index.js";

// Evicted per read, so a digest rewritten while the process runs is read again.
const moduleCache: Record<string, unknown> = createRequire(import.meta.url).cache;

// A digest file that does not load: a reader's mistake, or a file caught mid-write.
export type UnreadableDigest = { file: string; message: string };

/** Every digest a reader has written under `digest/`, each read as its file stands now. */
export async function readDigest(
  src: Pick<SourceRef, "dir">,
): Promise<{ chunks: SourceChunk[]; unreadable: UnreadableDigest[] }> {
  const dir = path.join(src.dir, DIGEST_DIR);
  if (!existsSync(dir)) return { chunks: [], unreadable: [] };
  // The loader resolves a digest's `konte` import; it is loaded here, not at the top, to keep the
  // check layer free of it.
  await import("./loader.js");
  const files = readdirSync(dir)
    .filter((f) => DIGEST_FILE_PATTERN.test(f))
    .sort();
  const read = await Promise.all(
    files.map(async (f) => {
      const file = path.join(dir, f);
      delete moduleCache[file];
      try {
        const chunk: unknown = (await import(pathToFileURL(file).href)).default;
        if (typeof chunk !== "object" || chunk === null || !("chunk" in chunk)) {
          return {
            file: f,
            message: "its default export is no defineSourceChunk(…)",
          } satisfies UnreadableDigest;
        }
        return chunk as SourceChunk;
      } catch (err) {
        return {
          file: f,
          message: errorMessage(err)
            .trim()
            .replace(/\s*\n\s*/g, " "),
        } satisfies UnreadableDigest;
      }
    }),
  );
  return {
    chunks: read.filter((r): r is SourceChunk => "chunk" in r),
    unreadable: read.filter((r): r is UnreadableDigest => !("chunk" in r)),
  };
}

// A source as an agent or a direction reads it: where it is, its chunks' index (null where it cannot
// be read), its digest, and the span a direction covers — null before one names it.
export type SourceView = {
  ref: SourceRef;
  index: SourceStudyIndex | null;
  chunks: SourceChunk[];
  unreadable: UnreadableDigest[];
  span: string | null;
};

/** The source of the video at `videoRoot`, with the span a direction names; null where it holds none. */
export async function sourceViewIn(
  videoRoot: string,
  span: string | null,
): Promise<SourceView | null> {
  const ref = sourceRefIn(videoRoot);
  if (!ref) return null;
  const index = await refreshStudyIndex(ref).then(
    (r) => r.index,
    () => null,
  );
  return { ref, index, ...(await readDigest(ref)), span };
}

/** The source a direction's `brief.source` covers, read from the video at `videoRoot`. */
export async function sourceViewOf(
  direction: Direction,
  videoRoot: string,
): Promise<SourceView | null> {
  const brief = direction.brief?.source;
  return brief ? sourceViewIn(videoRoot, brief.span) : null;
}

/**
 * What a person calls a chunk: its heading, else its pages (comic) or its stretch of the clock
 * (clip), else its id.
 */
export function chunkLabel(index: SourceStudyIndex | null, chunk: string): string {
  const extent = index?.chunks.find((c) => c.id === chunk);
  if (!extent) return chunk;
  if (extent.title) return extent.title;
  if (index!.kind === "comic") return `pp. ${extent.from}–${extent.to}`;
  if (index!.kind === "clip") {
    return `${formatClipClock(extent.from)}–${formatClipClock(extent.to)}`;
  }
  return chunk;
}

/** The chunks the span covers in reading order — every chunk before a span is named. */
export function spanChunks(sv: SourceView): string[] {
  if (!sv.index) return [];
  const all = sv.index.chunks.map((c) => c.id);
  if (sv.span === null) return all;
  const parsed = parseSpan(sv.span);
  return (parsed && resolveSpan(parsed, all)) ?? [];
}

/** The span as a person reads it: its first chunk's label to its last's. */
export function spanLabelOf(sv: SourceView): string {
  const chunks = spanChunks(sv);
  if (chunks.length === 0) return sv.span ?? "";
  const first = chunkLabel(sv.index, chunks[0]!);
  const last = chunkLabel(sv.index, chunks.at(-1)!);
  return first === last ? first : `${first} – ${last}`;
}

export function unreadChunks(sv: SourceView): string[] {
  const read = new Set(sv.chunks.map((c) => c.chunk));
  return spanChunks(sv).filter((chunk) => !read.has(chunk));
}

// How much the span holds at the original's own pace: its scenes, a scene running on past a chunk
// counted once; what every line takes to say as written (a text's quotations, a comic's balloons);
// a clip's run, and a comic's pages. `unread` chunks have no digest yet, so the scenes, and a
// comic's lines, are a floor.
export type SpanMeasure = {
  scenes: number;
  unread: number;
  spokenSec: number | null;
  runSec: number | null;
  pages: number | null;
};

export function spanMeasure(sv: SourceView): SpanMeasure {
  const chunks = spanChunks(sv);
  const byId = new Map(sv.chunks.map((c) => [c.chunk, c]));
  const extents = (sv.index?.chunks ?? []).filter((c) => chunks.includes(c.id));
  let scenes = 0;
  chunks.forEach((id, i) => {
    const own = byId.get(id);
    if (!own) return;
    const all = Object.values(own.scenes) as SourceScene[];
    const runOn = i + 1 < chunks.length && byId.has(chunks[i + 1]!);
    scenes += all.length - (runOn ? all.filter((sc) => sc.continues).length : 0);
  });
  const kind = sv.index?.kind ?? null;
  let spokenSec: number | null = null;
  if (kind === "text") spokenSec = extents.reduce((sum, c) => sum + (c.spokenSec ?? 0), 0);
  if (kind === "comic") {
    const balloons = chunks.flatMap((id) =>
      Object.values(byId.get(id)?.pages ?? {}).flatMap((panels) =>
        panels.flatMap((p) =>
          p.text.filter((t) => t.kind === "balloon").map((t) => t.text.replace(/《[^》]*》/g, "")),
        ),
      ),
    );
    spokenSec = spokenSecOf(balloons, speechLangOf(balloons.join("")));
  }
  return {
    scenes,
    unread: chunks.filter((id) => !byId.has(id)).length,
    spokenSec,
    runSec: kind === "clip" ? extents.reduce((sum, c) => sum + (c.to - c.from), 0) : null,
    pages: kind === "comic" ? extents.reduce((sum, c) => sum + (c.to - c.from + 1), 0) : null,
  };
}

export type LocatedScene = { id: string; chunk: string; scene: SourceScene };

export function sourceScenes(chunks: readonly SourceChunk[]): Map<string, LocatedScene> {
  const out = new Map<string, LocatedScene>();
  for (const c of chunks) {
    for (const [id, scene] of Object.entries(c.scenes) as [string, SourceScene][]) {
      out.set(id, { id, chunk: c.chunk, scene });
    }
  }
  return out;
}

/** Every look the digest holds, by the name it is of, names in the order they first show. */
export function looksByName(
  chunks: readonly SourceChunk[],
): Map<string, (SourceLook & { chunk: string })[]> {
  const out = new Map<string, (SourceLook & { chunk: string })[]>();
  for (const c of chunks) {
    for (const look of c.looks) {
      out.set(look.of, [...(out.get(look.of) ?? []), { ...look, chunk: c.chunk }]);
    }
  }
  return out;
}

function within(index: SourceStudyIndex, chunk: string, at: string): boolean {
  const extent = index.chunks.find((c) => c.id === chunk);
  const kind = chunkKind(chunk);
  const parsed = kind && parseAt(kind, at);
  return Boolean(extent && parsed && parsed.from >= extent.from && parsed.to <= extent.to);
}

/** What `at` in `chunk` shows of the original; null where it lies outside the chunks. */
export async function excerptOf(
  sv: SourceView,
  chunk: string,
  at: string,
): Promise<SourceExcerpt | null> {
  const kind = chunkKind(chunk);
  const parsed = kind && parseAt(kind, at);
  if (!parsed || !sv.index || !within(sv.index, chunk, at)) return null;
  return sourceExcerpt(sv.ref, sv.index, chunk, parsed);
}

export function importCommand(sv: Pick<SourceView, "ref" | "index">): string {
  return `konte source import ${sv.index?.kind ?? "<kind>"} ${path.join(SOURCE_DIR, sv.ref.file)}`;
}

export type DigestProblem = { file: string; chunk: string | null; message: string };

/**
 * What is wrong in the digest against the chunks' index: a file that does not load, a chunk the
 * index does not hold, an `at` outside its chunk. `file` is relative to the video.
 */
export function digestProblems(
  index: SourceStudyIndex,
  digest: { chunks: readonly SourceChunk[]; unreadable: readonly UnreadableDigest[] },
): DigestProblem[] {
  const out: DigestProblem[] = [];
  const stems = chunkStems(index);
  for (const { file, message } of digest.unreadable) {
    out.push({
      file: path.join(SOURCE_DIR, DIGEST_DIR, file),
      chunk: null,
      message: `digest/${file} cannot be read (${message})`,
    });
  }
  for (const c of digest.chunks) {
    const file = path.join(SOURCE_DIR, DIGEST_DIR, `${stems.get(c.chunk) ?? c.chunk}.ts`);
    const extent = index.chunks.find((x) => x.id === c.chunk);
    if (!extent) {
      out.push({ file, chunk: c.chunk, message: `chunk ${c.chunk} is not among the chunks` });
      continue;
    }
    const ats = [
      ...(Object.entries(c.scenes) as [string, SourceScene][]).map(([id, sc]) => [id, sc.at]),
      ...c.looks.map((l) => [`look of ${l.of}`, l.at]),
      ...Object.keys(c.pages ?? {}).map((at) => [`page ${at}`, at]),
    ];
    const bad = ats.filter(([, at]) => !within(index, c.chunk, at!));
    if (bad.length > 0) {
      out.push({
        file,
        chunk: c.chunk,
        message:
          `${bad.map(([what, at]) => `${what} at ${at}`).join(", ")} lies outside ${c.chunk} ` +
          `(${extent.from}–${extent.to})`,
      });
    }
  }
  return out;
}

/** The pages of each comic digest left out of its `pages`. */
export function untranscribedPages(
  index: SourceStudyIndex,
  chunks: readonly SourceChunk[],
): DigestProblem[] {
  const stems = chunkStems(index);
  const out: DigestProblem[] = [];
  for (const c of chunks) {
    const extent = index.chunks.find((x) => x.id === c.chunk);
    if (!extent || !c.pages) continue;
    const volume = c.chunk.split(".")[0]!;
    const missing: string[] = [];
    for (let p = extent.from; p <= extent.to; p++) {
      if (!(`${volume}.p${p}` in c.pages)) missing.push(`${volume}.p${p}`);
    }
    if (missing.length > 0) {
      out.push({
        file: path.join(SOURCE_DIR, DIGEST_DIR, `${stems.get(c.chunk) ?? c.chunk}.ts`),
        chunk: c.chunk,
        message: `${missing.join(", ")} of ${c.chunk} not transcribed in \`pages\``,
      });
    }
  }
  return out;
}

/**
 * `source-locator-out-of-range` for every digest `at` and the span that points past the chunks of the
 * original. The chunks' `index.json` is counted again first where the original changed, and the
 * chunks the old count wrote are removed.
 */
export async function checkSourceLocators(
  direction: Direction,
  videoRoot: string,
): Promise<Finding[]> {
  const brief = direction.brief?.source;
  if (!brief) return [];
  const finding = (subject: string, message: string, file: string): Finding => ({
    code: "source-locator-out-of-range",
    subject,
    fixIn: { stage: "direction" },
    message: `${message} — fix it in ${file}`,
  });
  let ref: SourceRef | null;
  let index: SourceStudyIndex;
  let recounted: boolean;
  try {
    ref = sourceRefIn(videoRoot);
    if (!ref) {
      return [
        finding(
          "brief.source",
          "brief.source names a source the video does not hold — konte source import <kind> <file>",
          "direction.ts",
        ),
      ];
    }
    ({ index, recounted } = await refreshStudyIndex(ref));
  } catch (err) {
    return [
      finding(
        "brief.source",
        `the original of brief.source cannot be read (${errorMessage(err)})`,
        SOURCE_DIR,
      ),
    ];
  }
  const reimport = recounted
    ? `; the original changed since it was imported, so its chunks are gone — ${importCommand({ ref, index })} writes them again`
    : "";
  const out: Finding[] = [];
  const parsed = parseSpan(brief.span);
  if (
    !parsed ||
    !resolveSpan(
      parsed,
      index.chunks.map((c) => c.id),
    )
  ) {
    out.push(
      finding(
        "brief.source.span",
        `span "${brief.span}" covers no chunk of ${ref.file}${reimport}`,
        "direction.ts",
      ),
    );
  }
  for (const p of digestProblems(index, await readDigest(ref))) {
    out.push(
      finding(`source:${p.chunk ?? path.basename(p.file)}`, `${p.message}${reimport}`, p.file),
    );
  }
  return out;
}
