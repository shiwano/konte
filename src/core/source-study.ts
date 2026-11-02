// A video's source (`videos/<name>/source/`) is the original it is adapted from. `konte source import`
// copies it in and splits it into chunks under `chunks/`, which a reader turns into `digest/<chunk>.ts`.
// Everything under `chunks/` is rebuilt from the original: `index.json` alone is what the locator check
// reads, and the chunk files beside it are made again whenever one is missing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { mapConcurrent } from "./concurrency.js";
import { KonteError } from "./errors.js";
import {
  type ParsedAt,
  type SourceKind,
  chunkFileStems,
  sourceKindOfFile,
} from "./source-locator.js";
import { sha256OfFile } from "./study-clip.js";
import {
  type SourceFileFingerprint,
  type SourceStudyIndex,
  SourceStudyIndexSchema,
} from "./types/index.js";

export const SOURCE_DIR = "source";
const CHUNKS_DIR = "chunks";
export const DIGEST_DIR = "digest";
// A digest file under `digest/`, named after its chunk.
export const DIGEST_FILE_PATTERN = /^[a-z0-9.]+\.ts$/;
export const INDEX_JSON = "index.json";
export const INDEX_MD = "index.md";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

// A video's source: its `source/` directory, and the original relative to it.
export type SourceRef = { dir: string; file: string };

export function sourceDirOf(videoRoot: string): string {
  return path.join(videoRoot, SOURCE_DIR);
}

/** The source directory as a reader is handed it: `videos/<name>/source`, from the workspace. */
export function sourceDirLabel(src: Pick<SourceRef, "dir">): string {
  return path.relative(path.resolve(src.dir, "../../.."), src.dir);
}

export function sourceChunksDir(src: Pick<SourceRef, "dir">): string {
  return path.join(src.dir, CHUNKS_DIR);
}

// What `source/` holds beside `chunks/` and `digest/`: the original, where it holds one.
function originalEntries(dir: string): string[] {
  return readdirSync(dir).filter((e) => e !== CHUNKS_DIR && e !== DIGEST_DIR && !e.startsWith("."));
}

/**
 * The video's source: the original its chunks' index names, else the one file or directory beside
 * `chunks/` and `digest/`. Null where the video holds none.
 */
export function sourceRefIn(videoRoot: string): SourceRef | null {
  const dir = sourceDirOf(videoRoot);
  if (!existsSync(dir)) return null;
  const indexed = readStudyIndex({ dir })?.file;
  if (indexed && existsSync(path.join(dir, indexed))) return { dir, file: indexed };
  const originals = originalEntries(dir);
  if (originals.length === 0) return null;
  if (originals.length > 1) {
    throw new KonteError(
      "SOURCE_UNREADABLE",
      `${SOURCE_DIR}/ holds ${originals.length} originals (${originals.join(", ")}) — ` +
        "konte source remove, then konte source import the one to adapt",
    );
  }
  return { dir, file: originals[0]! };
}

function sourceKindOf(src: SourceRef): SourceKind {
  const abs = path.join(src.dir, src.file);
  if (!existsSync(abs)) throw new KonteError("SOURCE_UNREADABLE", `No such file: ${abs}`);
  const kind = sourceKindOfFile(abs, statSync(abs).isDirectory());
  if (!kind) {
    throw new KonteError(
      "SOURCE_UNREADABLE",
      `${src.file} is no source konte reads — text: .txt .md .epub; comic: a directory of pages, ` +
        ".cbz .pdf .zip; clip: a video",
    );
  }
  return kind;
}

// The files a source's original is made of: the one file, or every page image under a directory.
function originalFiles(src: SourceRef): string[] {
  const abs = path.join(src.dir, src.file);
  if (!statSync(abs).isDirectory()) return [src.file];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSorted(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        out.push(path.relative(src.dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(abs);
  return out;
}

function readdirSorted(dir: string) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

const HASH_CONCURRENCY = 8;

async function fingerprintOf(src: SourceRef): Promise<SourceFileFingerprint[]> {
  return mapConcurrent(originalFiles(src), HASH_CONCURRENCY, async (rel) => {
    const abs = path.join(src.dir, rel);
    const st = statSync(abs);
    return { path: rel, size: st.size, mtimeMs: st.mtimeMs, sha256: await sha256OfFile(abs) };
  });
}

/**
 * The fingerprint the original holds to, where it still is what `known` fingerprinted: the same
 * files, each the same size and mtime — or, where only the mtime moved, the same sha256, with that
 * mtime taken in. Null where the original changed.
 */
async function fingerprintHolds(
  src: SourceRef,
  known: readonly SourceFileFingerprint[],
): Promise<SourceFileFingerprint[] | null> {
  const abs = path.join(src.dir, src.file);
  if (!existsSync(abs)) return null;
  const files = originalFiles(src);
  if (files.length !== known.length) return null;
  const byPath = new Map(known.map((f) => [f.path, f]));
  const out: SourceFileFingerprint[] = [];
  for (const rel of files) {
    const was = byPath.get(rel);
    if (!was) return null;
    const st = statSync(path.join(src.dir, rel));
    if (st.size !== was.size) return null;
    if (st.mtimeMs !== was.mtimeMs) {
      if ((await sha256OfFile(path.join(src.dir, rel))) !== was.sha256) return null;
      out.push({ ...was, mtimeMs: st.mtimeMs });
    } else {
      out.push(was);
    }
  }
  return out;
}

export function readStudyIndex(src: Pick<SourceRef, "dir">): SourceStudyIndex | null {
  try {
    const parsed = SourceStudyIndexSchema.safeParse(
      JSON.parse(readFileSync(path.join(sourceChunksDir(src), INDEX_JSON), "utf-8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// One kind's reading of an original.
export type SourceStudyKind = {
  kind: SourceKind;
  // Bumped whenever what this kind reads, or how, changes: an index of another version is read again.
  version: number;
  // The original's structure — its chunks and their extents — counted without writing any chunk.
  structure(
    src: SourceRef,
    opts: StudyOptions,
  ): Promise<Omit<SourceStudyIndex, "fingerprint" | "version" | "kind" | "file">>;
  // Writes one chunk's files under `chunks/` from the original, every one named after `stem`.
  writeChunk(src: SourceRef, index: SourceStudyIndex, chunk: string, stem: string): Promise<void>;
  // The files one chunk is written to, relative to `chunks/`; the first is the one a reader opens.
  chunkFiles(index: SourceStudyIndex, chunk: string, stem: string): string[];
  // Whether `excerpt` reads the chunk's written files.
  excerptReadsChunk: boolean;
  // What `at`, inside a written chunk, shows: its paragraphs (text), or its page images or frames as
  // absolute paths (comic, clip).
  excerpt(
    src: SourceRef,
    index: SourceStudyIndex,
    chunk: string,
    stem: string,
    at: ParsedAt,
  ): Promise<SourceExcerpt>;
};

export type SourceExcerpt = { text: string[] } | { images: string[] };

export type StudyOptions = {
  progress: (line: string) => void;
  // A comic's binding, over what its file states.
  binding?: "rtl" | "ltr";
};

const KINDS = new Map<SourceKind, () => Promise<SourceStudyKind>>([
  ["text", async () => (await import("./source-study-text.js")).TEXT_STUDY],
  ["comic", async () => (await import("./source-study-comic.js")).COMIC_STUDY],
  ["clip", async () => (await import("./source-study-clip.js")).CLIP_STUDY],
]);

async function studyKind(kind: SourceKind): Promise<SourceStudyKind> {
  return KINDS.get(kind)!();
}

export function chunkStems(index: SourceStudyIndex): Map<string, string> {
  return chunkFileStems(index.chunks.map((c) => c.id));
}

async function clearStudy(src: SourceRef): Promise<void> {
  const dir = sourceChunksDir(src);
  if (!existsSync(dir)) return;
  for (const entry of await fs.readdir(dir)) {
    if (entry !== INDEX_JSON) await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function countStructure(
  src: SourceRef,
  impl: SourceStudyKind,
  opts: StudyOptions,
): Promise<SourceStudyIndex> {
  const fingerprint = await fingerprintOf(src);
  const structure = await impl.structure(src, opts);
  return { version: impl.version, kind: impl.kind, file: src.file, fingerprint, ...structure };
}

async function writeIndex(src: SourceRef, index: SourceStudyIndex): Promise<void> {
  await writeFileAtomic(
    path.join(sourceChunksDir(src), INDEX_JSON),
    `${JSON.stringify(index, null, 2)}\n`,
  );
}

/**
 * `index.json` as the original stands: read back where the fingerprint holds, else counted again
 * from the original, with every chunk file the old one left removed. Writes no chunk.
 */
export async function refreshStudyIndex(
  src: SourceRef,
  opts: StudyOptions = { progress: () => {} },
): Promise<{ index: SourceStudyIndex; recounted: boolean }> {
  const read = readStudyIndex(src);
  const known = read?.file === src.file ? read : null;
  const impl = await studyKind(known?.kind ?? sourceKindOf(src));
  const rebound = opts.binding !== undefined && opts.binding !== known?.binding;
  if (known && known.version === impl.version && !rebound) {
    const fingerprint = await fingerprintHolds(src, known.fingerprint);
    if (fingerprint) {
      if (fingerprint.some((f, i) => f.mtimeMs !== known.fingerprint[i]!.mtimeMs)) {
        await writeIndex(src, { ...known, fingerprint });
      }
      return { index: { ...known, fingerprint }, recounted: false };
    }
  }
  const index = await countStructure(src, impl, {
    ...opts,
    binding: opts.binding ?? known?.binding,
  });
  await clearStudy(src);
  await writeIndex(src, index);
  return { index, recounted: true };
}

function chunkWritten(
  src: SourceRef,
  index: SourceStudyIndex,
  impl: SourceStudyKind,
  chunk: string,
): boolean {
  const stem = chunkStems(index).get(chunk)!;
  return impl
    .chunkFiles(index, chunk, stem)
    .every((f) => existsSync(path.join(sourceChunksDir(src), f)));
}

// One write per chunk in flight: two excerpts of an unwritten chunk wait on the same write.
const chunkWrites = new Map<string, Promise<void>>();

/** Writes `chunk`'s files where any is missing; returns the one a reader opens, relative to `chunks/`. */
export async function ensureChunk(
  src: SourceRef,
  index: SourceStudyIndex,
  chunk: string,
): Promise<string> {
  const impl = await studyKind(index.kind);
  const stem = chunkStems(index).get(chunk);
  if (!stem) throw new KonteError("SOURCE_UNREADABLE", `The source has no chunk ${chunk}`);
  const key = path.join(src.dir, chunk);
  let write = chunkWrites.get(key);
  if (!write && !chunkWritten(src, index, impl, chunk)) {
    write = impl.writeChunk(src, index, chunk, stem).finally(() => chunkWrites.delete(key));
    chunkWrites.set(key, write);
  }
  await write;
  return impl.chunkFiles(index, chunk, stem)[0]!;
}

/** Studies the whole original: `index.json`, `index.md` and every chunk not yet written. */
export async function studySource(
  src: SourceRef,
  opts: StudyOptions,
): Promise<{ index: SourceStudyIndex; recounted: boolean }> {
  const { index, recounted } = await refreshStudyIndex(src, opts);
  const impl = await studyKind(index.kind);
  const missing = index.chunks.filter((c) => !chunkWritten(src, index, impl, c.id));
  if (missing.length > 0) opts.progress(`writing ${missing.length} chunk(s)`);
  for (const c of missing) await ensureChunk(src, index, c.id);
  await fs.writeFile(path.join(sourceChunksDir(src), INDEX_MD), studyIndexMarkdown(index, impl));
  await fs.mkdir(path.join(src.dir, DIGEST_DIR), { recursive: true });
  return { index, recounted };
}

function studyIndexMarkdown(index: SourceStudyIndex, impl: SourceStudyKind): string {
  const stems = chunkStems(index);
  const lines = [`# ${index.file}`, "", index.summary, ""];
  for (const note of index.notes) lines.push(`- ${note}`);
  if (index.notes.length > 0) lines.push("");
  lines.push("| chunk | title | size | file | digest |", "| --- | --- | --- | --- | --- |");
  for (const c of index.chunks) {
    const stem = stems.get(c.id)!;
    lines.push(
      `| ${c.id} | ${c.title ?? ""} | ${c.size} | ${CHUNKS_DIR}/${impl.chunkFiles(index, c.id, stem)[0]} | ${DIGEST_DIR}/${stem}.ts |`,
    );
  }
  if (index.names.length > 0) lines.push("", `Names: ${index.names.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/** What `at` in `chunk` shows, writing the chunk first where the excerpt reads it and it is missing. */
export async function sourceExcerpt(
  src: SourceRef,
  index: SourceStudyIndex,
  chunk: string,
  at: ParsedAt,
): Promise<SourceExcerpt> {
  const impl = await studyKind(index.kind);
  if (impl.excerptReadsChunk) await ensureChunk(src, index, chunk);
  return impl.excerpt(src, index, chunk, chunkStems(index).get(chunk)!, at);
}

export async function sameOriginal(a: string, b: string): Promise<boolean> {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory())
    return sa.size === sb.size && (await sha256OfFile(a)) === (await sha256OfFile(b));
  const ea = readdirSorted(a);
  const eb = readdirSorted(b);
  if (ea.length !== eb.length) return false;
  for (const [i, entry] of ea.entries()) {
    if (entry.name !== eb[i]!.name) return false;
    if (!(await sameOriginal(path.join(a, entry.name), path.join(b, entry.name)))) return false;
  }
  return true;
}

/**
 * `abs` as the video's source: where it lies, if under `source/`; else copied there, over an original
 * of the same name that differs from it. The caller removes an original of another name first.
 */
export async function importOriginal(videoRoot: string, abs: string): Promise<SourceRef> {
  const dir = sourceDirOf(videoRoot);
  const rel = path.relative(dir, abs);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    const [top] = rel.split(path.sep);
    if (!top || top === CHUNKS_DIR || top === DIGEST_DIR) {
      throw new KonteError("SOURCE_UNREADABLE", `${abs} is not an original — it is konte's own`);
    }
    return { dir, file: top };
  }
  const file = path.basename(abs);
  if (file === CHUNKS_DIR || file === DIGEST_DIR) {
    throw new KonteError(
      "SOURCE_UNREADABLE",
      `${abs} is named ${file}, which source/ keeps for konte's own — rename it, then import it`,
    );
  }
  const dest = path.join(dir, file);
  if (!existsSync(dest) || !(await sameOriginal(abs, dest))) {
    await fs.mkdir(dir, { recursive: true });
    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(abs, dest, { recursive: true });
  }
  return { dir, file };
}
