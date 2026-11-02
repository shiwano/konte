// A comic source: a comic a video is adapted from — a directory of page images, a .cbz, a .pdf, or
// a .zip of them — read as volumes of pages, cut into bundles of 12. A PDF page is the one image it
// embeds where it is nothing else, else drawn by pdf.js (pdf-render.ts).

import { readdirSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import yauzl from "yauzl";
import {
  type ContactSheetCell,
  drawContactSheet,
  planContactSheetLayout,
} from "./contact-sheet.js";
import { writeFileAtomic } from "./atomic-write.js";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import { KonteError, errorMessage } from "./errors.js";
import { SINGLE_FRAME_INPUT_ARGS, SINGLE_FRAME_OUTPUT_ARGS } from "./ffmpeg-binary.js";
import { runFfmpeg } from "./ffmpeg-exec.js";
import { type ParsedAt, parseAt } from "./source-locator.js";
import {
  type SourceExcerpt,
  type SourceRef,
  type SourceStudyKind,
  type StudyOptions,
  sourceChunksDir,
} from "./source-study.js";
import { imageFileSize } from "./image-size.js";
import { Pdf, type PdfDict, type PdfPageImage, PdfParseError } from "./pdf.js";
import { pdfInfo, renderPdfPage } from "./pdf-render.js";
import type { SourceStudyIndex } from "./types/index.js";

export const BUNDLE_PAGES = 12;
// The page images a reader reads are scaled to this short side.
const ANALYSIS_SHORT_SIDE = 720;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const VOLUME_EXTS = new Set([".pdf", ".cbz", ".zip"]);
const FULL_PAGES_DIR = "pages";

type Binding = "rtl" | "ltr";

// ---------------------------------------------------------------------------------------------------
// The book: its volumes and where each page's image is.

type ZipSource = { path: string } | { buffer: Buffer };
type PageSource =
  | { kind: "file"; abs: string }
  | { kind: "zip"; zip: ZipSource; name: string }
  | { kind: "pdf"; pdf: Pdf; page: PdfDict; n: number }
  // A PDF page konte cannot take its one image off, drawn by pdf.js (`n` 1-based).
  | { kind: "pdf-drawn"; data: Buffer; n: number };
type Volume = { label: string; pages: PageSource[]; binding: Binding | null };
type Book = { volumes: Volume[]; bindingFrom: string | null };

// A page's image as it is stored: encoded bytes, or the pixels of a PDF Flate image.
type PageImage = { bytes: Buffer; ext: string } | PdfPageImage;

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function isJunk(name: string): boolean {
  return name.startsWith("__MACOSX/") || path.posix.basename(name).startsWith(".");
}

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function openZip(src: ZipSource): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, zip?: yauzl.ZipFile) => (err ? reject(err) : resolve(zip!));
    if ("path" in src) yauzl.open(src.path, { lazyEntries: true }, done);
    else yauzl.fromBuffer(src.buffer, { lazyEntries: true }, done);
  });
}

/** Every file entry of a zip, read into memory where `want` takes it. */
async function readZip(
  src: ZipSource,
  want: (name: string) => boolean,
): Promise<{ names: string[]; files: Map<string, Buffer> }> {
  const zip = await openZip(src);
  const names: string[] = [];
  const files = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve());
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName;
      if (name.endsWith("/") || isJunk(name)) return zip.readEntry();
      names.push(name);
      if (!want(name)) return zip.readEntry();
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", reject);
        stream.on("end", () => {
          files.set(name, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  zip.close();
  return { names: names.sort(natural), files };
}

/** The binding ComicInfo.xml states: `YesAndRightToLeft` turns right to left, `Yes`/`No` left to right. */
export function comicInfoBinding(xml: string): Binding | null {
  const m = /<Manga>\s*([A-Za-z]+)\s*<\/Manga>/.exec(xml);
  if (!m || m[1] === "Unknown") return null;
  return m[1] === "YesAndRightToLeft" ? "rtl" : "ltr";
}

function isComicInfo(name: string): boolean {
  return path.posix.basename(name).toLowerCase() === "comicinfo.xml";
}

async function zipVolume(label: string, zip: ZipSource): Promise<Volume> {
  const { names, files } = await readZip(zip, isComicInfo);
  const info = [...files.values()][0];
  return {
    label,
    pages: names
      .filter((n) => IMAGE_EXTS.has(extOf(n)))
      .map((name) => ({ kind: "zip", zip, name })),
    binding: info ? comicInfoBinding(info.toString("utf-8")) : null,
  };
}

// Each page taken off as its one image where it is nothing else, else drawn; every page drawn where
// konte's own reader cannot open the file.
async function pdfVolume(label: string, buffer: Buffer): Promise<Volume> {
  let pdf: Pdf | null = null;
  try {
    pdf = new Pdf(buffer);
    if (pdf.encrypted) pdf = null;
  } catch {
    pdf = null;
  }
  const pages = pdf?.pages() ?? [];
  if (!pdf || pages.length === 0) {
    const info = await pdfInfo(buffer);
    return {
      label,
      pages: Array.from({ length: info.pages }, (_, i) => ({
        kind: "pdf-drawn",
        data: buffer,
        n: i + 1,
      })),
      binding: info.direction,
    };
  }
  try {
    return {
      label,
      pages: pages.map((page, i) =>
        pdf.imageOnly(page)
          ? { kind: "pdf", pdf, page, n: i + 1 }
          : { kind: "pdf-drawn", data: buffer, n: i + 1 },
      ),
      binding: pdf.direction(),
    };
  } catch (err) {
    if (err instanceof PdfParseError) {
      throw new KonteError("SOURCE_UNREADABLE", `${label}: ${err.message}`);
    }
    throw err;
  }
}

function listImagesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      natural(a.name, b.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (IMAGE_EXTS.has(extOf(entry.name))) out.push(full);
    }
  };
  walk(dir);
  return out.sort((a, b) => natural(path.relative(dir, a), path.relative(dir, b)));
}

async function openBookUncached(abs: string): Promise<Book> {
  const name = path.basename(abs);
  if (statSync(abs).isDirectory()) {
    const pages = listImagesUnder(abs);
    const info = readdirSync(abs).find((n) => n.toLowerCase() === "comicinfo.xml");
    const binding = info
      ? comicInfoBinding(await fs.readFile(path.join(abs, info), "utf-8"))
      : null;
    return {
      volumes: [{ label: name, pages: pages.map((p) => ({ kind: "file", abs: p })), binding }],
      bindingFrom: binding ? "ComicInfo.xml" : null,
    };
  }
  const ext = extOf(abs);
  if (ext === ".pdf") {
    const volume = await pdfVolume(name, await fs.readFile(abs));
    return { volumes: [volume], bindingFrom: volume.binding ? "the PDF" : null };
  }
  // A .cbz or a .zip: its volumes where it wraps PDFs or comic archives, else its own pages.
  const { names, files } = await readZip(
    { path: abs },
    (n) => VOLUME_EXTS.has(extOf(n)) || isComicInfo(n),
  );
  const inner = names.filter((n) => VOLUME_EXTS.has(extOf(n)));
  if (inner.length === 0) {
    const volume = await zipVolume(name, { path: abs });
    return { volumes: [volume], bindingFrom: volume.binding ? "ComicInfo.xml" : null };
  }
  const outerInfo = names.find(isComicInfo);
  const outerBinding = outerInfo ? comicInfoBinding(files.get(outerInfo)!.toString("utf-8")) : null;
  const volumes: Volume[] = [];
  for (const n of inner) {
    const buffer = files.get(n)!;
    volumes.push(
      extOf(n) === ".pdf"
        ? await pdfVolume(path.posix.basename(n), buffer)
        : await zipVolume(path.posix.basename(n), { buffer }),
    );
  }
  const binding = outerBinding ?? volumes.find((v) => v.binding)?.binding ?? null;
  return {
    volumes: volumes.map((v) => ({ ...v, binding: v.binding ?? binding })),
    bindingFrom: binding ? (outerBinding ? "ComicInfo.xml" : "its volumes") : null,
  };
}

// The book last opened, kept while the original stays the same.
let lastBook: { key: string; book: Promise<Book> } | null = null;

// What the book is cached by: every file it is made of, by size and mtime — a page added to a
// subfolder moves no directory's own stat.
function bookKey(abs: string): string {
  const st = statSync(abs);
  if (!st.isDirectory()) return `${abs}:${st.size}:${st.mtimeMs}`;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const f = statSync(full);
        files.push(`${path.relative(abs, full)}:${f.size}:${f.mtimeMs}`);
      }
    }
  };
  walk(abs);
  return `${abs}|${files.sort().join("|")}`;
}

async function openBook(abs: string): Promise<Book> {
  let key: string;
  try {
    key = bookKey(abs);
  } catch {
    throw new KonteError("SOURCE_UNREADABLE", `No such file: ${abs}`);
  }
  if (lastBook?.key !== key) {
    const book = openBookUncached(abs).catch((err: unknown) => {
      if (lastBook?.key === key) lastBook = null;
      if (err instanceof KonteError) throw err;
      throw new KonteError(
        "SOURCE_UNREADABLE",
        `${abs} is not a comic konte reads: ${errorMessage(err)}`,
      );
    });
    lastBook = { key, book };
  }
  const book = await lastBook.book;
  const empty = book.volumes.filter((v) => v.pages.length === 0);
  if (book.volumes.length === 0 || empty.length > 0) {
    throw new KonteError(
      "SOURCE_UNREADABLE",
      `${abs} holds no page${empty.length > 0 ? ` in ${empty.map((v) => v.label).join(", ")}` : ""}`,
    );
  }
  return book;
}

async function readPageImage(page: PageSource): Promise<PageImage> {
  switch (page.kind) {
    case "file":
      return { bytes: await fs.readFile(page.abs), ext: extOf(page.abs) };
    case "zip": {
      const { files } = await readZip(page.zip, (n) => n === page.name);
      return { bytes: files.get(page.name)!, ext: extOf(page.name) };
    }
    case "pdf":
      try {
        return page.pdf.pageImage(page.page);
      } catch {
        return { bytes: await renderPdfPage(page.pdf.bytes, page.n), ext: ".jpg" };
      }
    case "pdf-drawn":
      return { bytes: await renderPdfPage(page.data, page.n), ext: ".jpg" };
  }
}

// ---------------------------------------------------------------------------------------------------
// Writing pages.

async function ffmpeg(args: string[], what: string): Promise<void> {
  await runFfmpeg(
    [
      "-v",
      "error",
      "-y",
      ...SINGLE_FRAME_INPUT_ARGS,
      ...args.slice(0, -1),
      ...SINGLE_FRAME_OUTPUT_ARGS,
      args.at(-1)!,
    ],
    what,
  );
}

/** The page as a file ffmpeg reads: its own bytes, or its pixels encoded as a PNG. */
async function pageFile(image: PageImage, base: string): Promise<string> {
  if ("bytes" in image) {
    const file = `${base}${image.ext === ".jpeg" ? ".jpg" : image.ext}`;
    await fs.writeFile(file, image.bytes);
    return file;
  }
  const raw = `${base}.raw`;
  await fs.writeFile(raw, image.raw);
  const file = `${base}.png`;
  await ffmpeg(
    [
      "-f",
      "rawvideo",
      "-pix_fmt",
      image.pixFmt,
      "-s",
      `${image.width}x${image.height}`,
      "-i",
      raw,
      "-frames:v",
      "1",
      file,
    ],
    "ffmpeg could not encode the page",
  );
  await fs.rm(raw, { force: true });
  return file;
}

async function writeScaled(input: string, out: string): Promise<void> {
  const s = ANALYSIS_SHORT_SIDE;
  await ffmpeg(
    [
      "-i",
      input,
      "-vf",
      `scale='if(gt(iw,ih),-2,trunc(min(${s},iw)/2)*2)':'if(gt(iw,ih),trunc(min(${s},ih)/2)*2,-2)'`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      out,
    ],
    "ffmpeg could not scale the page",
  );
}

async function sizeOfFile(file: string): Promise<{ width: number; height: number }> {
  const size = await imageFileSize(file);
  if (!size) throw new KonteError("FFPROBE_ERROR", `Could not measure ${file}`);
  return size;
}

// ---------------------------------------------------------------------------------------------------
// The index.

function volumeId(i: number): string {
  return `v${i + 1}`;
}

function pagePad(index: SourceStudyIndex, volume: string): number {
  const last = Math.max(
    ...index.chunks.filter((c) => c.id.startsWith(`${volume}.`)).map((c) => c.to),
  );
  return Math.max(3, String(last).length);
}

function chunkOf(index: SourceStudyIndex, chunk: string) {
  const c = index.chunks.find((x) => x.id === chunk);
  if (!c) throw new KonteError("SOURCE_UNREADABLE", `the study holds no chunk ${chunk}`);
  return c;
}

function pageNumbers(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function analysisPage(index: SourceStudyIndex, volume: string, stem: string, page: number): string {
  return `${stem}/p${String(page).padStart(pagePad(index, volume), "0")}.jpg`;
}

async function structure(
  src: SourceRef,
  opts: StudyOptions,
): ReturnType<SourceStudyKind["structure"]> {
  const book = await openBook(path.join(src.dir, src.file));
  const fileBinding = book.volumes.find((v) => v.binding)?.binding ?? null;
  const binding = opts.binding ?? fileBinding;
  if (!binding) {
    throw new KonteError(
      "COMIC_BINDING_UNKNOWN",
      `${src.file} states no binding — neither a ComicInfo.xml nor the PDF says which way its ` +
        `pages turn; run konte source import comic ${path.relative(process.cwd(), path.join(src.dir, src.file))} --binding rtl (right to left, manga) or --binding ltr`,
    );
  }
  const multi = book.volumes.length > 1;
  const chunks: SourceStudyIndex["chunks"] = [];
  const units: SourceStudyIndex["units"] = [];
  book.volumes.forEach((volume, vi) => {
    const v = volumeId(vi);
    if (multi) units.push({ id: v, title: volume.label });
    for (let from = 1, b = 1; from <= volume.pages.length; from += BUNDLE_PAGES, b++) {
      const to = Math.min(volume.pages.length, from + BUNDLE_PAGES - 1);
      const id = `${v}.b${b}`;
      if (!multi) units.push({ id, title: null });
      chunks.push({
        id,
        title: null,
        unit: multi ? v : id,
        from,
        to,
        size: `${to - from + 1} pages`,
      });
    }
  });
  const pages = book.volumes.reduce((sum, v) => sum + v.pages.length, 0);
  const other = binding === "rtl" ? "ltr" : "rtl";
  const notes = [
    opts.binding && opts.binding !== fileBinding
      ? `binding ${binding} given by --binding`
      : `binding ${binding} read off ${book.bindingFrom} — --binding ${other} where its pages turn the other way`,
  ];
  return {
    summary: [
      `${pages.toLocaleString("en-US")} pages`,
      ...(multi ? [`${book.volumes.length} volumes`] : []),
      `${chunks.length} bundle${chunks.length === 1 ? "" : "s"}`,
      binding,
    ].join(" · "),
    notes,
    names: [],
    binding,
    units,
    chunks,
  };
}

/**
 * The cells of one bundle's sheet: its pages in spreads, the two pages of a spread side by side, an
 * odd first page alone. Right to left, each row reads from its right end.
 */
export function sheetOrder<T>(
  pages: readonly { page: number; cell: T }[],
  columns: number,
  binding: Binding,
  blank: T,
): T[] {
  const cells: T[] = [];
  if (pages.length > 0 && pages[0]!.page % 2 === 1) cells.push(blank);
  cells.push(...pages.map((p) => p.cell));
  while (cells.length % columns !== 0) cells.push(blank);
  if (binding === "ltr") return cells;
  const rows: T[] = [];
  for (let at = 0; at < cells.length; at += columns)
    rows.push(...cells.slice(at, at + columns).reverse());
  return rows;
}

async function writeChunk(
  src: SourceRef,
  index: SourceStudyIndex,
  chunk: string,
  stem: string,
): Promise<void> {
  const c = chunkOf(index, chunk);
  const volume = chunk.split(".")[0]!;
  const book = await openBook(path.join(src.dir, src.file));
  const pages = book.volumes[Number(volume.slice(1)) - 1]?.pages;
  if (!pages || pages.length < c.to) {
    throw new KonteError(
      "SOURCE_UNREADABLE",
      `${src.file} no longer holds ${chunk} — konte source import it again`,
    );
  }
  const studyDir = sourceChunksDir(src);
  await fs.mkdir(path.join(studyDir, stem), { recursive: true });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "konte-comic-"));
  try {
    const numbers = pageNumbers(c.from, c.to);
    const written = await mapConcurrent(numbers, FFMPEG_CONCURRENCY, async (page) => {
      const input = await pageFile(
        await readPageImage(pages[page - 1]!),
        path.join(work, `p${page}`),
      );
      const rel = analysisPage(index, volume, stem, page);
      await writeScaled(input, path.join(studyDir, rel));
      const { width, height } = await sizeOfFile(path.join(studyDir, rel));
      return { page, rel, aspect: width / height };
    });
    const aspect = written[0]!.aspect;
    const binding = index.binding ?? "ltr";
    const blankFile = path.join(work, "blank.png");
    await ffmpeg(
      ["-f", "lavfi", "-i", "color=c=0x111111:s=16x16", "-frames:v", "1", blankFile],
      "ffmpeg could not make the blank cell",
    );
    const blank: ContactSheetCell = { label: " ", file: blankFile, aspect };
    // A leading blank where the bundle opens on a lone page, rounded up to whole spreads.
    const count = Math.ceil((numbers.length + 1) / 2) * 2;
    const layout = planContactSheetLayout(count, count, { groupSize: 2, aspect });
    const cells = sheetOrder<ContactSheetCell>(
      written.map((w) => ({
        page: w.page,
        cell: { label: `${volume}.p${w.page}`, file: path.join(studyDir, w.rel), aspect: w.aspect },
      })),
      layout.columns,
      binding,
      blank,
    );
    const { bytes } = await drawContactSheet(cells, {
      ...layout,
      blanks: layout.columns * layout.rows - cells.length,
    });
    await fs.writeFile(path.join(studyDir, `${stem}.jpg`), bytes);
    const lines = [
      `# ${chunk} — ${volume}.p${c.from}-p${c.to} (${binding})`,
      "",
      `sheet: ${stem}.jpg`,
      "",
      ...written.map((w) => `${volume}.p${w.page} ${w.rel}`),
    ];
    // Last: its presence, with the pages, is what says the bundle is whole.
    await writeFileAtomic(path.join(studyDir, `${stem}.md`), `${lines.join("\n")}\n`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

function chunkFiles(index: SourceStudyIndex, chunk: string, stem: string): string[] {
  const c = chunkOf(index, chunk);
  const volume = chunk.split(".")[0]!;
  return [
    `${stem}.md`,
    `${stem}.jpg`,
    ...pageNumbers(c.from, c.to).map((p) => analysisPage(index, volume, stem, p)),
  ];
}

async function excerpt(
  src: SourceRef,
  index: SourceStudyIndex,
  chunk: string,
  stem: string,
  at: ParsedAt,
): Promise<SourceExcerpt> {
  const c = chunkOf(index, chunk);
  const volume = chunk.split(".")[0]!;
  const from = Math.max(at.from, c.from);
  const to = Math.min(at.to, c.to);
  return {
    images:
      at.prefix === volume && from <= to
        ? pageNumbers(from, to).map((p) =>
            path.join(sourceChunksDir(src), analysisPage(index, volume, stem, p)),
          )
        : [],
  };
}

export const COMIC_STUDY: SourceStudyKind = {
  excerptReadsChunk: true,
  kind: "comic",
  version: 1,
  structure,
  writeChunk,
  chunkFiles,
  excerpt,
};

/** One page (`v1.p31`) at its own size, written under `chunks/pages/`. Reads no index. */
export async function comicPage(
  src: SourceRef,
  locator: string,
  _opts: StudyOptions,
): Promise<{ path: string; width: number; height: number }> {
  const at = parseAt("comic", locator);
  if (!at || at.from !== at.to) {
    throw new KonteError(
      "INVALID_OPTION",
      `--at takes one page as v<volume>.p<page>, got ${locator}`,
    );
  }
  const book = await openBook(path.join(src.dir, src.file));
  const vi = Number(at.prefix.slice(1)) - 1;
  const pages = book.volumes[vi]?.pages;
  if (!pages || at.from > pages.length) {
    const counts = book.volumes.map((v, i) => `${volumeId(i)}: ${v.pages.length} pages`).join(", ");
    throw new KonteError("INVALID_OPTION", `--at ${locator} is outside ${src.file} (${counts})`);
  }
  const dir = path.join(sourceChunksDir(src), FULL_PAGES_DIR);
  await fs.mkdir(dir, { recursive: true });
  const width = Math.max(3, String(pages.length).length);
  const file = await pageFile(
    await readPageImage(pages[at.from - 1]!),
    path.join(dir, `${at.prefix}.p${String(at.from).padStart(width, "0")}`),
  );
  return { path: file, ...(await sizeOfFile(file)) };
}
