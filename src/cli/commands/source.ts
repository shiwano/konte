import { existsSync, readdirSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../core/errors.js";
import {
  type SourceView,
  chunkLabel,
  digestProblems,
  excerptOf,
  importCommand,
  looksByName,
  readDigest,
  sourceScenes,
  sourceViewIn,
  spanChunks,
  spanMeasure,
  untranscribedPages,
  spanLabelOf,
} from "../../core/source-direction.js";
import { type SourceKind, formatClipClock, sourceKindOfFile } from "../../core/source-locator.js";
import {
  DIGEST_DIR,
  INDEX_MD,
  SOURCE_DIR,
  type SourceExcerpt,
  type SourceRef,
  type StudyOptions,
  ensureChunk,
  importOriginal,
  sameOriginal,
  sourceChunksDir,
  sourceDirLabel,
  sourceDirOf,
  sourceRefIn,
  studySource,
} from "../../core/source-study.js";
import { prepareClipSource, sourceClipFrameAt } from "../../core/source-study-clip.js";
import { comicPage } from "../../core/source-study-comic.js";
import { ensureFfmpeg } from "../../core/ffmpeg.js";
import { ffprobeBin } from "../../core/ffmpeg-binary.js";
import { parseTimecode } from "../../core/timecode.js";
import type { SourceStudyIndex } from "../../core/types/index.js";
import { getPathSize } from "./clean-utils.js";
import { confirmDeletion, printAborted } from "../confirm.js";
import { typeCheckWorkspace } from "../../core/tsc.js";
import { requireVideoRoot, requireWorkspaceRoot } from "../context.js";
import { loadDirectionIfPresent } from "../../core/stage-definitions.js";
import { declareScope } from "../scope.js";

const progress = (line: string) => console.error(`konte: ${line}…`);

function rel(file: string): string {
  return path.relative(process.cwd(), file);
}

// The source as an agent acts on it after an import: its size, its index, and a reader per unread
// chunk.
async function printImported(src: SourceRef, index: SourceStudyIndex): Promise<void> {
  console.log(rel(path.join(src.dir, src.file)));
  console.log(`  ${index.summary}`);
  for (const note of index.notes) console.log(`  ${note}`);
  console.log(`  index: ${rel(path.join(sourceChunksDir(src), INDEX_MD))}`);
  const read = new Set((await readDigest(src)).chunks.map((c) => c.chunk));
  console.log("");
  console.log("Next steps:");
  if (index.chunks.every((c) => read.has(c.id))) {
    console.log("  konte source show   Read the scenes and looks the digest holds");
    return;
  }
  console.log(
    `  Spawn one konte-source-reader with ${sourceDirLabel(src)} and the part the human named ` +
      '(their words; "the whole work" when none) — it answers the span',
  );
}

function requireKind(abs: string, file: string, kind: SourceKind): void {
  if (!existsSync(abs)) throw new KonteError("SOURCE_UNREADABLE", `No such file: ${file}`);
  const found = sourceKindOfFile(abs, statSync(abs).isDirectory());
  if (found !== kind) {
    throw new KonteError(
      "SOURCE_UNREADABLE",
      found
        ? `${file} is a ${found} source — konte source import ${found} ${file}`
        : `${file} is no ${kind} source`,
    );
  }
}

// Removes the video's source where it is another original than `abs` — another name, or the same
// name with other contents — once the human agrees.
async function replaceOther(
  videoRoot: string,
  abs: string,
  confirm: { yes?: boolean; no?: boolean },
): Promise<boolean> {
  const dir = sourceDirOf(videoRoot);
  const inside = !path.relative(dir, abs).startsWith("..");
  const current = sourceRefIn(videoRoot);
  if (inside || !current) return true;
  const same =
    current.file === path.basename(abs) &&
    (await sameOriginal(abs, path.join(current.dir, current.file)));
  if (same) return true;
  if (!(await confirmRemoval(videoRoot, current, confirm))) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

async function confirmRemoval(
  videoRoot: string,
  src: SourceRef,
  confirm: { yes?: boolean; no?: boolean },
): Promise<boolean> {
  const digestDir = path.join(src.dir, DIGEST_DIR);
  const digests = existsSync(digestDir) ? readdirSync(digestDir).length : 0;
  const subjects = [`the source ${rel(path.join(src.dir, src.file))}`];
  if (digests > 0) subjects.push(`${digests} digest file(s) its readers wrote`);
  const proceed = await confirmDeletion({
    subjects,
    totalSize: await getPathSize(sourceDirOf(videoRoot)),
    yes: confirm.yes,
    no: confirm.no,
  });
  if (!proceed) printAborted();
  return proceed;
}

type ImportOptions = { yes?: boolean; no?: boolean };

async function runImport(
  file: string,
  kind: SourceKind,
  opts: ImportOptions & Omit<StudyOptions, "progress">,
): Promise<void> {
  const videoRoot = requireVideoRoot();
  const abs = path.resolve(file);
  requireKind(abs, file, kind);
  if (!(await replaceOther(videoRoot, abs, opts))) return;
  const src = await importOriginal(videoRoot, abs);
  if (kind === "clip") {
    await ensureFfmpeg();
    await ffprobeBin();
    await prepareClipSource(src, progress);
  }
  const { index } = await studySource(src, { progress, binding: opts.binding });
  await printImported(src, index);
}

async function requireSourceView(span: string | undefined): Promise<SourceView> {
  const videoRoot = requireVideoRoot();
  const brief = span ?? (await loadDirectionIfPresent(videoRoot))?.brief.source?.span ?? null;
  const sv = await sourceViewIn(videoRoot, brief);
  if (!sv) {
    throw new KonteError(
      "SOURCE_UNREADABLE",
      "The video holds no source — konte source import text|comic|clip <file>",
    );
  }
  return sv;
}

function printExcerpt(sv: SourceView, excerpt: SourceExcerpt | null, indent: string): void {
  if (!excerpt) {
    console.log(`${indent}(not among the chunks — ${importCommand(sv)})`);
    return;
  }
  if ("text" in excerpt) for (const line of excerpt.text) console.log(`${indent}${line}`);
  else for (const file of excerpt.images) console.log(`${indent}${rel(file)}`);
}

function formatRun(sec: number): string {
  const whole = Math.round(sec);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const ss = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function measureLine(sv: SourceView): string {
  const m = spanMeasure(sv);
  const floor = m.unread > 0 ? "+" : "";
  const parts = [`${m.scenes}${floor} scene${m.scenes === 1 && !floor ? "" : "s"}`];
  if (m.pages !== null) parts.push(`${m.pages} pages`);
  if (m.runSec !== null) parts.push(`runs ${formatRun(m.runSec)}`);
  if (m.spokenSec !== null) {
    const lines = sv.index?.kind === "comic" ? "balloon" : "quoted line";
    const more = sv.index?.kind === "comic" ? floor : "";
    parts.push(`every ${lines} as written speaks ${formatRun(m.spokenSec)}${more}`);
  }
  if (m.unread > 0) parts.push(`${m.unread} chunk(s) not read`);
  return parts.join(" · ");
}

async function printShow(sv: SourceView): Promise<void> {
  const file = rel(path.join(sv.ref.dir, sv.ref.file));
  console.log(
    sv.span === null
      ? `${file} — no span named yet`
      : `${file} — ${spanLabelOf(sv)} (span ${sv.span})`,
  );
  console.log(`  ${measureLine(sv)}`);
  for (const { file, message } of sv.unreadable) {
    console.log(`  digest/${file} cannot be read (${message}) — rewrite it`);
  }
  const scenes = [...sourceScenes(sv.chunks).values()];
  console.log("");
  console.log(sv.span === null ? "Scenes:" : "Scenes of the span:");
  const chunks = spanChunks(sv);
  if (sv.span !== null && chunks.length === 0) {
    console.log(`  span ${sv.span} covers no chunk — konte source show --span <span> picks others`);
  }
  for (const chunk of chunks) {
    const chunkFile = sv.index ? await ensureChunk(sv.ref, sv.index, chunk) : null;
    const where = chunkFile ? `  ${rel(path.join(sourceChunksDir(sv.ref), chunkFile))}` : "";
    console.log(`  ${chunkLabel(sv.index, chunk)}${where}`);
    const own = scenes.filter((s) => s.chunk === chunk);
    if (own.length === 0) console.log("    (not read yet)");
    for (const { id, scene } of own) {
      const present = scene.present.join(", ") || "no one";
      console.log(`    ${id}  ${scene.at}  ${scene.place} — ${present} — ${scene.change}`);
    }
  }
  const looks = looksByName(sv.chunks);
  const named = new Set(scenes.flatMap((s) => s.scene.present));
  const lookless = [...named].filter((name) => !looks.has(name));
  if (looks.size === 0 && lookless.length === 0) return;
  console.log("");
  console.log("Looks:");
  for (const [name, own] of looks) {
    console.log(`  ${name}`);
    for (const look of own) {
      console.log(`    ${look.text}  (${chunkLabel(sv.index, look.chunk)}, ${look.at})`);
      if (sv.index && sv.index.kind !== "text") {
        printExcerpt(sv, await excerptOf(sv, look.chunk, look.at), "      ");
      }
    }
  }
  if (lookless.length > 0) console.log(`  No look in the digest: ${lookless.join(", ")}`);
}

// One comic page or one clip moment, written at the original's own size.
async function printAt(sv: SourceView, at: string): Promise<void> {
  const file = rel(path.join(sv.ref.dir, sv.ref.file));
  if (sv.index?.kind === "comic") {
    const page = await comicPage(sv.ref, at, { progress, binding: sv.index.binding });
    console.log(`${file} at ${at}`);
    console.log(`  ${rel(page.path)}  ${page.width}×${page.height}`);
    const panels = sv.chunks.find((c) => c.pages && at in c.pages)?.pages?.[at];
    if (!panels) {
      console.log("  (not transcribed yet)");
      return;
    }
    panels.forEach((panel, i) => {
      console.log("");
      console.log(`  ${i + 1}. ${panel.picture}`);
      for (const t of panel.text) {
        const who = "by" in t ? ` ${t.by ?? "?"}` : "";
        console.log(`     [${t.kind}${who}] ${t.text}`);
      }
    });
    return;
  }
  if (sv.index?.kind === "clip") {
    await ensureFfmpeg();
    await ffprobeBin();
    const sec = parseTimecode(at);
    const frame = await sourceClipFrameAt(sv.ref, sec);
    console.log(`${file} at ${formatClipClock(sec)}`);
    console.log(`  ${rel(frame.path)}  ${frame.probe.width}×${frame.probe.height}`);
    return;
  }
  throw new KonteError(
    "INVALID_OPTION",
    "--at writes a comic page or a clip moment; a text reads in its chunk file",
  );
}

const CONFIRM_YES = "Skip the confirmation prompt";
const CONFIRM_NO = "Abort without prompting (treat confirmation as 'no')";

function registerImport(source: Command): void {
  const importCmd = source
    .command("import")
    .description("Bring an original into the video and split it into chunks a reader digests");

  declareScope(
    importCmd
      .command("text <file>")
      .description("A novel or a script: .txt, .md or .epub")
      .option("-y, --yes", CONFIRM_YES)
      .option("--no", CONFIRM_NO)
      .addHelpText(
        "after",
        `
Copies the file into the video's source/ and writes source/chunks/: index.md, index.json, and one file
per chunk, a paragraph per line opened by its locator (c3.p12). A chunk is a chapter, or a part of one
past about 8,000 characters (1,500 English words); a story of a collection is a level above (s5.c2).
A .txt that is not UTF-8 is read as Shift_JIS; Aozora Bunko notes are dropped and ruby is kept as base
text, its readings listed at the chunk's end.

Importing the same file again picks up where it stopped. Another file, or this one changed, replaces
the source and its digest once confirmed; an original edited inside source/ is counted again in place.

Examples:
  konte source import text ~/books/adventures.epub
  konte source import text rashomon.txt
`,
      )
      .action(async (file: string, opts: ImportOptions) => runImport(file, "text", opts)),
    { scope: "video", skipTypeCheck: true },
  );

  declareScope(
    importCmd
      .command("comic <file>")
      .description("A comic: a directory of page images, .cbz, .pdf, or a .zip of them")
      .option("--binding <rtl|ltr>", "Which way its pages turn, where its file does not say")
      .option("-y, --yes", CONFIRM_YES)
      .option("--no", CONFIRM_NO)
      .addHelpText(
        "after",
        `
Copies the comic into the video's source/ and writes source/chunks/: index.md, index.json, and per
bundle of 12 pages a contact sheet and its pages scaled down. Nothing is read off a page; a reader
transcribes each one, its panels and every piece of text on them, into the digest. A PDF page that
is more than its one image (typeset lines, drawn shapes), or whose image konte does not decode, is
drawn by pdf.js in the managed Chromium; a PDF that needs a password to open, or carries DRM, is not
read. The binding comes off ComicInfo.xml or the PDF; --binding
sets it over what the file states, and importing again with it corrects one read wrong.

Examples:
  konte source import comic ~/comics/vol01.zip
  konte source import comic ~/comics/vol01.pdf --binding rtl
`,
      )
      .action(async (file: string, opts: ImportOptions & { binding?: string }) => {
        if (opts.binding !== undefined && opts.binding !== "rtl" && opts.binding !== "ltr") {
          throw new KonteError("INVALID_OPTION", `--binding takes rtl or ltr, got ${opts.binding}`);
        }
        await runImport(file, "comic", { ...opts, binding: opts.binding as "rtl" | "ltr" });
      }),
    { scope: "video", skipTypeCheck: true },
  );

  declareScope(
    importCmd
      .command("clip <file>")
      .description("A film or an episode: a video file")
      .option("-y, --yes", CONFIRM_YES)
      .option("--no", CONFIRM_NO)
      .addHelpText(
        "after",
        `
Copies the video into the video's source/ and writes source/chunks/ with no length cap, in windows of
about 3 minutes (w1, w2 …) cut at the nearest shot change. Each window shows every shot — one frame
per shot, one every 5 s of a shot past 10 s — on sheets labelled with the clock, and its w<n>.md
lists the words heard in it, each line opened by its clock (01:12.5).

Examples:
  konte source import clip ~/films/film.mp4
`,
      )
      .action(async (file: string, opts: ImportOptions) => runImport(file, "clip", opts)),
    { scope: "video", skipTypeCheck: true },
  );
}

export function registerSourceCommand(program: Command): void {
  const source = program
    .command("source")
    .description("The original the video is adapted from: import it, read it, remove it");

  registerImport(source);

  declareScope(
    source
      .command("show")
      .description("The span's scenes, its length at the original's pace, and how each name looks")
      .option("--span <span>", "The chunks to list, in place of brief.source.span (c3-c5, v1.b2)")
      .option(
        "--at <locator>",
        "Write one comic page (v1.p31), with its transcription, or clip moment (01:12.5) full size",
      )
      .addHelpText(
        "after",
        `
Opens with the span at the original's pace: its scenes (one running on past a chunk counted once),
what every line takes to say as written (a text's quotations, a comic's balloons), a comic's pages
and a clip's run. Then, chapter by chapter, the chunk file holding the original's words and each
scene the digest holds: its id, where it lies, its place, who is present and what changes. Then every
look the digest holds by name, from the whole source, and the names it holds no look for. Before
brief.source names a span, every chunk is listed.

Examples:
  konte source show                 The span's scenes and every look
  konte source show --span c1-c9    Other chapters, as when widening the span
  konte source show --at v1.p31     A comic page at full size, and its transcription
`,
      )
      .action(async (opts: { span?: string; at?: string }) => {
        const sv = await requireSourceView(opts.span);
        if (opts.at !== undefined) await printAt(sv, opts.at);
        else await printShow(sv);
      }),
    { scope: "video" },
  );

  declareScope(
    source
      .command("check")
      .description(
        "Check the digest readers wrote: its types, that it loads, its locators, a comic's every page",
      )
      .action(async () => {
        const videoRoot = requireVideoRoot();
        const sv = await requireSourceView(undefined);
        const workspaceRoot = requireWorkspaceRoot();
        const digestDir = path.join(sv.ref.dir, DIGEST_DIR) + path.sep;
        const typed = await typeCheckWorkspace(workspaceRoot, videoRoot);
        const problems = typed.diagnostics
          .filter((d) => path.resolve(workspaceRoot, d.file).startsWith(digestDir))
          .map((d) => `${rel(path.resolve(workspaceRoot, d.file))}:${d.line}: ${d.message}`);
        if (!sv.index) problems.push(`the chunks' index cannot be read — ${importCommand(sv)}`);
        else {
          for (const p of [
            ...digestProblems(sv.index, sv),
            ...untranscribedPages(sv.index, sv.chunks),
          ]) {
            problems.push(`${rel(path.join(videoRoot, p.file))}: ${p.message}`);
          }
        }
        if (problems.length > 0) {
          throw new KonteError(
            "VALIDATION_FAILED",
            `${problems.length} problem(s) in the digest`,
            problems,
          );
        }
        console.log(`${sv.chunks.length} digest file(s) read, no problem`);
      }),
    { scope: "video", skipTypeCheck: true },
  );

  declareScope(
    source
      .command("remove")
      .description("Delete the video's source: the original's copy, its chunks and its digest")
      .option("-y, --yes", CONFIRM_YES)
      .option("--no", CONFIRM_NO)
      .action(async (opts: ImportOptions) => {
        const videoRoot = requireVideoRoot();
        const src = sourceRefIn(videoRoot);
        if (!src) {
          console.log("The video holds no source");
          return;
        }
        if (!(await confirmRemoval(videoRoot, src, opts))) return;
        await fs.rm(sourceDirOf(videoRoot), { recursive: true, force: true });
        console.log(`Removed ${SOURCE_DIR}/`);
        if ((await loadDirectionIfPresent(videoRoot))?.brief.source) {
          console.log("");
          console.log("Next steps:");
          console.log(
            "  Drop brief.source from direction.ts, or konte source import the original again",
          );
        }
      }),
    { scope: "video", skipTypeCheck: true },
  );
}
