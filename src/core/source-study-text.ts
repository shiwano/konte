// A text source: a novel or a script (.txt, .md, .epub) read into chapters and paragraphs. A
// chapter is the TOC's (EPUB), an Aozora Bunko heading note's, or a heading line's; one past the size
// a reader takes in one pass is split at paragraph boundaries into parts (`c3.1`, `c3.2`) whose
// paragraphs stay numbered through the chapter.

import { readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import yauzl from "yauzl";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError, errorMessage } from "./errors.js";
import type { SourceRef, SourceStudyKind } from "./source-study.js";
import { sourceChunksDir } from "./source-study.js";
import { quotedSpans, speechLangOf, spokenSecOf } from "./source-speech.js";

// A chunk holds about this much: characters for a CJK text, words for any other.
const CHUNK_CHARS = 8000;
const CHUNK_WORDS = 1500;
const MAX_NAMES = 30;
const MIN_NAME_COUNT = 2;

type Paragraph = { text: string; readings: string[] };

type Chapter = {
  // What its positions are written after: `c3`, or `s5.c2` in a story.
  prefix: string;
  title: string | null;
  unit: string;
  paragraphs: Paragraph[];
};

type Book = {
  stories: { id: string; title: string | null }[];
  chapters: Chapter[];
  notes: string[];
};

type TextChunk = { id: string; chapter: Chapter; from: number; to: number };

// --- decoding -------------------------------------------------------------------------------------

function decodeText(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("shift_jis").decode(bytes);
  }
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

const KANJI_RUN = /[㐀-鿿豈-﫿々〆ヶ〇]+$/;

/** The base text of `line` with Aozora ruby dropped, and each reading as `base《reading》`. */
export function stripAozoraRuby(line: string): Paragraph {
  const readings: string[] = [];
  let out = "";
  let rest = line;
  for (;;) {
    const open = rest.indexOf("《");
    if (open === -1) break;
    const close = rest.indexOf("》", open);
    if (close === -1) break;
    const before = rest.slice(0, open);
    const reading = rest.slice(open + 1, close);
    const bar = before.lastIndexOf("｜");
    let base: string;
    if (bar !== -1) {
      base = before.slice(bar + 1);
      out += before.slice(0, bar) + base;
    } else {
      base = KANJI_RUN.exec(before)?.[0] ?? "";
      out += before;
    }
    if (base) readings.push(`${base}《${reading}》`);
    rest = rest.slice(close + 1);
  }
  return { text: (out + rest).replaceAll("｜", ""), readings };
}

const AOZORA_NOTE = /［＃[^］]*］/g;

function isCjk(text: string): boolean {
  const letters = text.replace(/\s/g, "");
  if (letters.length === 0) return false;
  const cjk = letters.match(/[぀-ヿ㐀-鿿豈-﫿]/g)?.length ?? 0;
  return cjk / letters.length >= 0.1;
}

// Lines a paragraph was wrapped over, joined without a space between two CJK characters.
function joinWrapped(lines: readonly string[]): string {
  return lines
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .reduce((acc, line) => {
      if (acc === "") return line;
      return /[\x21-\x7E]$/.test(acc) || /^[\x21-\x7E]/.test(line) ? `${acc} ${line}` : acc + line;
    }, "");
}

// --- plain text, Markdown and Aozora Bunko --------------------------------------------------------

type Heading = { level: number; title: string };

const NUMERAL = "[一二三四五六七八九十百千〇零0-9０-９]+";
const STORY_HEADING = new RegExp(`^第${NUMERAL}部(?:[\\s　].*)?$`);
const CHAPTER_HEADING = new RegExp(`^第${NUMERAL}[章話回幕](?:[\\s　].*)?$`);
const ENGLISH_CHAPTER = /^(?:CHAPTER|Chapter)\s+[\dIVXLCivxlc]+\b.*$/;
const AOZORA_LEVEL: Record<string, number> = { 大: 1, 中: 2, 小: 3 };

function plainHeading(line: string, markdown: boolean): Heading | null {
  const t = line.trim();
  const md = markdown ? /^(#{1,6})\s+(.+?)\s*#*$/.exec(t) : null;
  const title = md ? md[2]! : t;
  if (STORY_HEADING.test(title)) return { level: 0, title };
  if (CHAPTER_HEADING.test(title) || ENGLISH_CHAPTER.test(title)) return { level: 10, title };
  return md ? { level: md[1]!.length, title } : null;
}

function aozoraHeading(line: string): Heading | null {
  const quoted = /［＃「(.+?)」は(大|中|小)見出し］/.exec(line);
  if (quoted) return { level: AOZORA_LEVEL[quoted[2]!]!, title: quoted[1]! };
  const wrapped = /［＃(?:窓)?(大|中|小)見出し］(.+?)［＃(?:窓)?(?:大|中|小)見出し終わり］/.exec(
    line,
  );
  if (wrapped) return { level: AOZORA_LEVEL[wrapped[1]!]!, title: wrapped[2]! };
  return null;
}

function isAozora(text: string): boolean {
  return /［＃/.test(text) || /^底本：/m.test(text);
}

// The Aozora body: past the title block and the 凡例 between two rules of hyphens, up to 底本.
function aozoraBody(lines: string[]): string[] {
  const rules = lines
    .slice(0, 80)
    .map((l, i) => (/^-{20,}\s*$/.test(l) ? i : -1))
    .filter((i) => i !== -1);
  let start = 0;
  if (rules.length >= 2) start = rules[1]! + 1;
  else if (lines.length > 2) start = 2;
  let end = lines.findIndex((l, i) => i >= start && /^底本：/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).filter((l) => !/^［＃本文終わり］/.test(l));
}

type Block = { heading: Heading } | { paragraph: Paragraph };

function plainBlocks(text: string, markdown: boolean, aozora: boolean): Block[] {
  let lines = text.split("\n");
  if (aozora) lines = aozoraBody(lines);
  const blocks: Block[] = [];
  const pushParagraph = (raw: readonly string[]) => {
    const joined = joinWrapped(raw.map((l) => l.replace(AOZORA_NOTE, "")));
    if (joined === "") return;
    blocks.push({ paragraph: stripAozoraRuby(joined) });
  };
  // Aozora writes one paragraph per line; elsewhere a blank line ends one where the text has any.
  const byBlank = !aozora && lines.some((l) => l.trim() === "");
  let pending: string[] = [];
  for (const line of lines) {
    const heading = aozora ? aozoraHeading(line) : plainHeading(line, markdown);
    if (heading) {
      pushParagraph(pending);
      pending = [];
      blocks.push({ heading: { ...heading, title: stripAozoraRuby(heading.title).text } });
    } else if (!byBlank) {
      pushParagraph([line]);
    } else if (line.trim() === "") {
      pushParagraph(pending);
      pending = [];
    } else {
      pending.push(line);
    }
  }
  pushParagraph(pending);
  return blocks;
}

// The heading levels a book is split on: the upper of two is its stories, the only one its chapters.
// A level written once, before any other heading, is the document's title. In Markdown only a part
// heading (第一部) is a story.
function splitLevels(
  headings: readonly Heading[],
  markdown: boolean,
): { story: number | null; chapter: number } | null {
  let used = [...new Set(headings.map((h) => h.level))].sort((a, b) => a - b);
  const top = used[0];
  if (
    used.length > 1 &&
    headings.filter((h) => h.level === top).length === 1 &&
    headings[0]!.level === top
  ) {
    used = used.slice(1);
  }
  if (used.length === 0) return null;
  if (markdown && used[0] !== 0) {
    return { story: null, chapter: used.includes(10) ? 10 : used[0]! };
  }
  return used.length === 1
    ? { story: null, chapter: used[0]! }
    : { story: used[0]!, chapter: used[1]! };
}

function bookOfBlocks(
  blocks: readonly Block[],
  noun: string,
  cjk: boolean,
  markdown: boolean,
): Book {
  const headings = blocks.flatMap((b) => ("heading" in b ? [b.heading] : []));
  const levels = splitLevels(headings, markdown);
  const paragraphs = blocks.flatMap((b) => ("paragraph" in b ? [b.paragraph] : []));
  if (!levels) return bookByLength(paragraphs, `no ${noun}: split by length`, cjk);

  const book: Book = { stories: [], chapters: [], notes: [] };
  let story: { id: string; title: string | null } | null = null;
  let chapter: Chapter | null = null;
  let chapterCount = 0;
  // A heading opens its chapter at its first paragraph, so one with none (a title) takes no number.
  let heading: string | null = null;
  for (const block of blocks) {
    if ("heading" in block) {
      const { level, title } = block.heading;
      if (levels.story !== null && level <= levels.story) {
        story = { id: `s${book.stories.length + 1}`, title };
        book.stories.push(story);
        chapterCount = 0;
        chapter = null;
        heading = null;
      } else if (level <= levels.chapter) {
        chapter = null;
        heading = title;
      }
      continue;
    }
    // Text before a chapter's heading: a story's opening, or the book's front.
    if (!chapter) {
      chapterCount++;
      const prefix = story ? `${story.id}.c${chapterCount}` : `c${chapterCount}`;
      chapter = { prefix, title: heading, unit: story ? story.id : prefix, paragraphs: [] };
      book.chapters.push(chapter);
      heading = null;
    }
    chapter.paragraphs.push(block.paragraph);
  }
  return book;
}

function bookByLength(paragraphs: readonly Paragraph[], note: string, cjk: boolean): Book {
  const groups = splitBySize(
    paragraphs.map((p) => p.text),
    cjk,
  );
  const chapters = groups.map(([from, to], i) => ({
    prefix: `c${i + 1}`,
    title: null,
    unit: `c${i + 1}`,
    paragraphs: paragraphs.slice(from, to),
  }));
  return { stories: [], chapters, notes: [note] };
}

// --- EPUB -----------------------------------------------------------------------------------------

const EPUB_TEXT = /\.(?:xml|opf|ncx|x?html?)$/i;

async function readZipText(file: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, string>();
      zip.on("error", reject);
      zip.on("end", () => resolve(out));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName) || !EPUB_TEXT.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const parts: Buffer[] = [];
          stream.on("data", (d: Buffer) => parts.push(d));
          stream.on("error", reject);
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(parts).toString("utf-8"));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}

/** An XHTML fragment's text, with `<ruby>` reduced to its base and each reading collected. */
export function htmlParagraph(html: string): Paragraph {
  const readings: string[] = [];
  const noRuby = html.replace(/<ruby\b[^>]*>([\s\S]*?)<\/ruby>/gi, (_, inner: string) => {
    const reading = [...inner.matchAll(/<rt\b[^>]*>([\s\S]*?)<\/rt>/gi)].map((m) => m[1]!).join("");
    const base = inner
      .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
      .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, "");
    const baseText = decodeEntities(base.replace(/<[^>]+>/g, "")).trim();
    const readingText = decodeEntities(reading.replace(/<[^>]+>/g, "")).trim();
    if (baseText && readingText) readings.push(`${baseText}《${readingText}》`);
    return baseText;
  });
  const text = decodeEntities(noRuby.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return { text, readings };
}

type TocEntry = { title: string; target: string; children: TocEntry[] };

function resolveHref(base: string, href: string): string {
  const [file, frag] = href.split("#");
  const joined = file
    ? path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(file)))
    : base;
  return frag ? `${joined}#${frag}` : joined;
}

function navToc(nav: string, navPath: string): TocEntry[] {
  const tocNav =
    /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(
      nav,
    )?.[1] ?? /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(nav)?.[1];
  if (!tocNav) return [];
  const root: TocEntry[] = [];
  const lists: TocEntry[][] = [];
  const items: TocEntry[] = [];
  for (const m of tocNav.matchAll(/<(\/?)(ol|ul|li|a)\b[^>]*>/gi)) {
    const close = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (tag === "ol" || tag === "ul") {
      if (close) lists.pop();
      else lists.push(lists.length === 0 ? root : (items.at(-1)?.children ?? root));
    } else if (tag === "li") {
      if (close) items.pop();
      else {
        const entry: TocEntry = { title: "", target: "", children: [] };
        (lists.at(-1) ?? root).push(entry);
        items.push(entry);
      }
    } else if (!close && items.length > 0) {
      const entry = items.at(-1)!;
      const href = attr(m[0], "href");
      if (href) entry.target = resolveHref(navPath, href);
      const rest = tocNav.slice(m.index! + m[0].length);
      entry.title = htmlParagraph(rest.slice(0, rest.search(/<\/a>/i))).text;
    }
  }
  return root.filter((e) => e.target);
}

function ncxToc(ncx: string, ncxPath: string): TocEntry[] {
  const root: TocEntry[] = [];
  const stack: TocEntry[] = [];
  for (const m of ncx.matchAll(
    /<(\/?)navPoint\b[^>]*>|<text>([\s\S]*?)<\/text>|<content\b([^>]*)\/?>/gi,
  )) {
    if (m[0].startsWith("</")) {
      stack.pop();
    } else if (/^<navPoint/i.test(m[0])) {
      const entry: TocEntry = { title: "", target: "", children: [] };
      (stack.at(-1)?.children ?? root).push(entry);
      stack.push(entry);
    } else if (m[2] !== undefined && stack.length > 0 && !stack.at(-1)!.title) {
      stack.at(-1)!.title = decodeEntities(m[2]).trim();
    } else if (m[3] !== undefined && stack.length > 0) {
      const src = attr(` ${m[3]}`, "src");
      if (src && !stack.at(-1)!.target) stack.at(-1)!.target = resolveHref(ncxPath, src);
    }
  }
  return root;
}

const MATTER =
  /\b(?:frontmatter|backmatter|titlepage|imprint|colophon|copyright-page|halftitlepage|toc|index|endnotes|loi|lot)\b/;

type Stream = {
  paragraphs: Paragraph[];
  // Where each document, and each element id in one, starts: the paragraph index it opens on.
  anchors: Map<string, number>;
  // The documents marked as front or back matter.
  matter: Set<string>;
};

function streamOf(docs: readonly { path: string; html: string }[]): Stream {
  const stream: Stream = { paragraphs: [], anchors: new Map(), matter: new Set() };
  for (const doc of docs) {
    stream.anchors.set(doc.path, stream.paragraphs.length);
    const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(doc.html);
    const bodyTag = /<body\b[^>]*>/i.exec(doc.html)?.[0] ?? "";
    const firstSection = /<section\b[^>]*>/i.exec(doc.html)?.[0] ?? "";
    if (
      MATTER.test(attr(bodyTag, "epub:type") ?? "") ||
      MATTER.test(attr(firstSection, "epub:type") ?? "")
    ) {
      stream.matter.add(doc.path);
    }
    const html = body?.[1] ?? doc.html;
    const anchor = (id: string) => {
      const key = `${doc.path}#${id}`;
      if (!stream.anchors.has(key)) stream.anchors.set(key, stream.paragraphs.length);
    };
    for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>|<[a-z][^>]*>/gi)) {
      for (const id of m[0].matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)) anchor(id[1]!);
      if (m[1] === undefined) continue;
      const p = htmlParagraph(m[1]);
      if (p.text) stream.paragraphs.push(p);
    }
  }
  return stream;
}

async function readEpub(file: string): Promise<{ book: Book; cjk: boolean }> {
  let entries: Map<string, string>;
  try {
    entries = await readZipText(file);
  } catch (err) {
    throw new KonteError("SOURCE_UNREADABLE", `${file} is not an EPUB: ${errorMessage(err)}`);
  }
  const container = entries.get("META-INF/container.xml");
  const opfPath = container && attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] ?? "", "full-path");
  const opf = opfPath ? entries.get(opfPath) : undefined;
  if (!opfPath || !opf) throw new KonteError("SOURCE_UNREADABLE", `${file} holds no EPUB package`);

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], "id");
    const href = attr(m[0], "href");
    if (id && href) {
      manifest.set(id, {
        href: resolveHref(opfPath, href),
        type: attr(m[0], "media-type") ?? "",
        props: attr(m[0], "properties") ?? "",
      });
    }
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)]
    .map((m) => manifest.get(attr(m[0], "idref") ?? "")?.href)
    .filter((href): href is string => href !== undefined && entries.has(href));
  const stream = streamOf(spine.map((p) => ({ path: p, html: entries.get(p)! })));

  const nav = [...manifest.values()].find((i) => /\bnav\b/.test(i.props));
  const ncx = [...manifest.values()].find((i) => i.type === "application/x-dtbncx+xml");
  let toc: TocEntry[] = [];
  if (nav && entries.has(nav.href)) toc = navToc(entries.get(nav.href)!, nav.href);
  if (toc.length === 0 && ncx && entries.has(ncx.href))
    toc = ncxToc(entries.get(ncx.href)!, ncx.href);
  const cjk = isCjk(
    stream.paragraphs
      .slice(0, 400)
      .map((p) => p.text)
      .join(""),
  );
  return { book: bookOfToc(toc, stream, cjk), cjk };
}

function anchorOf(stream: Stream, target: string): number | null {
  return stream.anchors.get(target) ?? stream.anchors.get(target.split("#")[0]!) ?? null;
}

function bookOfToc(toc: readonly TocEntry[], stream: Stream, cjk: boolean): Book {
  const inMatter = (e: TocEntry) => stream.matter.has(e.target.split("#")[0]!);
  // A matter entry over body entries (a half-title over the stories) gives way to them.
  const entries = toc.flatMap((e) =>
    inMatter(e) && e.children.some((c) => !inMatter(c)) ? e.children : [e],
  );
  // Every entry down to the chapter level bounds the one before it, matter included.
  const twoLevel = entries.some((e) => e.children.length > 0);
  const bounds = new Set<number>();
  for (const e of toc) {
    const at = anchorOf(stream, e.target);
    if (at !== null) bounds.add(at);
  }
  for (const e of entries) {
    const at = anchorOf(stream, e.target);
    if (at !== null) bounds.add(at);
    if (twoLevel) {
      for (const c of e.children) {
        const cat = anchorOf(stream, c.target);
        if (cat !== null) bounds.add(cat);
      }
    }
  }
  bounds.add(stream.paragraphs.length);
  const sorted = [...bounds].sort((a, b) => a - b);
  const extent = (at: number) =>
    [at, sorted.find((b) => b > at) ?? stream.paragraphs.length] as const;

  const body = entries.filter((e) => !inMatter(e) && anchorOf(stream, e.target) !== null);
  if (body.length === 0) {
    return bookByLength(stream.paragraphs, "no table of contents: split by length", cjk);
  }
  const book: Book = { stories: [], chapters: [], notes: [] };
  if (!twoLevel) {
    for (const e of body) {
      const [from, to] = extent(anchorOf(stream, e.target)!);
      const prefix = `c${book.chapters.length + 1}`;
      const paragraphs = stream.paragraphs.slice(from, to);
      if (paragraphs.length > 0)
        book.chapters.push({ prefix, title: e.title || null, unit: prefix, paragraphs });
    }
    return book;
  }
  for (const e of body) {
    const story = { id: `s${book.stories.length + 1}`, title: e.title || null };
    const start = anchorOf(stream, e.target)!;
    const children = e.children
      .map((c) => ({ title: c.title || null, at: anchorOf(stream, c.target) }))
      .filter((c): c is { title: string | null; at: number } => c.at !== null);
    const parts: { title: string | null; paragraphs: Paragraph[] }[] = [];
    if (children.length === 0) {
      const [from, to] = extent(start);
      parts.push({ title: story.title, paragraphs: stream.paragraphs.slice(from, to) });
    } else {
      for (const [i, c] of children.entries()) {
        const [from, to] = extent(c.at);
        // A story's opening, before its first chapter, opens that chapter.
        const lead = i === 0 && start < c.at ? stream.paragraphs.slice(start, c.at) : [];
        parts.push({ title: c.title, paragraphs: [...lead, ...stream.paragraphs.slice(from, to)] });
      }
    }
    const kept = parts.filter((p) => p.paragraphs.length > 0);
    if (kept.length === 0) continue;
    book.stories.push(story);
    for (const [i, p] of kept.entries()) {
      book.chapters.push({
        prefix: `${story.id}.c${i + 1}`,
        title: p.title,
        unit: story.id,
        paragraphs: p.paragraphs,
      });
    }
  }
  return book;
}

// --- chunks ---------------------------------------------------------------------------------------

function sizeOf(text: string, cjk: boolean): number {
  return cjk ? text.replace(/\s/g, "").length : text.split(/\s+/).filter(Boolean).length;
}

// Paragraph ranges [from, to) of about one chunk each, cut at paragraph boundaries.
function splitBySize(texts: readonly string[], cjk: boolean): [number, number][] {
  const sizes = texts.map((t) => sizeOf(t, cjk));
  const total = sizes.reduce((a, b) => a + b, 0);
  const limit = cjk ? CHUNK_CHARS : CHUNK_WORDS;
  const parts = Math.max(1, Math.ceil(total / limit));
  if (parts === 1) return texts.length > 0 ? [[0, texts.length]] : [];
  const target = total / parts;
  const out: [number, number][] = [];
  let from = 0;
  let acc = 0;
  for (let i = 0; i < sizes.length; i++) {
    acc += sizes[i]!;
    if (acc >= target * (out.length + 1) && out.length < parts - 1 && i + 1 < sizes.length) {
      out.push([from, i + 1]);
      from = i + 1;
    }
  }
  out.push([from, sizes.length]);
  return out;
}

function chunksOf(book: Book, cjk: boolean): TextChunk[] {
  return book.chapters.flatMap((chapter) => {
    const groups = splitBySize(
      chapter.paragraphs.map((p) => p.text),
      cjk,
    );
    return groups.map(([from, to], i) => ({
      id: groups.length === 1 ? chapter.prefix : `${chapter.prefix}.${i + 1}`,
      chapter,
      from: from + 1,
      to,
    }));
  });
}

type Reading = { book: Book; chunks: TextChunk[]; cjk: boolean };

// One reading per original per process, keyed by its size and mtime.
const readings = new Map<string, { key: string; reading: Reading }>();

async function readBook(src: SourceRef): Promise<Reading> {
  const abs = path.join(src.dir, src.file);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new KonteError("SOURCE_UNREADABLE", `No such file: ${abs}`);
  }
  const key = `${st.size}:${st.mtimeMs}`;
  const known = readings.get(abs);
  if (known?.key === key) return known.reading;

  const ext = path.extname(abs).toLowerCase();
  let book: Book;
  let cjk: boolean;
  if (ext === ".epub") {
    ({ book, cjk } = await readEpub(abs));
  } else {
    const text = decodeText(readFileSync(abs));
    cjk = isCjk(text);
    book = bookOfBlocks(
      plainBlocks(text, ext === ".md", ext === ".txt" && isAozora(text)),
      "headings",
      cjk,
      ext === ".md",
    );
  }
  const reading = { book, chunks: chunksOf(book, cjk), cjk };
  readings.set(abs, { key, reading });
  return reading;
}

// --- summary --------------------------------------------------------------------------------------

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? noun : plural}`;
}

/** The share of the paragraphs inside 「」, “” or "", marks included, as a whole percentage. */
export function dialogueShare(paragraphs: readonly string[]): number {
  const size = (t: string) => t.replace(/\s/g, "").length;
  let total = 0;
  let inside = 0;
  for (const p of paragraphs) {
    total += size(p);
    for (const q of quotedSpans(p)) inside += size(q);
  }
  return total === 0 ? 0 : Math.round((inside / total) * 100);
}

/** Name candidates: katakana runs for a CJK text, else capitalized words never at a sentence start. */
export function nameCandidates(paragraphs: readonly string[], cjk: boolean): string[] {
  const counts = new Map<string, number>();
  const bump = (w: string) => counts.set(w, (counts.get(w) ?? 0) + 1);
  if (cjk) {
    for (const p of paragraphs) for (const m of p.matchAll(/[ァ-ヺー]{2,}/g)) bump(m[0]);
  } else {
    const lower = new Set<string>();
    for (const p of paragraphs) {
      for (const m of p.matchAll(/[A-Za-z][a-z']*/g))
        if (m[0][0] === m[0][0]!.toLowerCase()) lower.add(m[0]);
      for (const m of p.matchAll(/([^\s]?)(\s*)\b([A-Z][a-z]+)\b/g)) {
        const before = p.slice(0, m.index! + m[1]!.length + m[2]!.length).trimEnd();
        if (before === "" || /[.!?"“‘(—:;]$/.test(before)) continue;
        if (!lower.has(m[3]!.toLowerCase())) bump(m[3]!);
      }
    }
  }
  return [...counts]
    .filter(([, n]) => n >= MIN_NAME_COUNT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_NAMES)
    .map(([w]) => w);
}

// --- the kind -------------------------------------------------------------------------------------

function chunkTexts(chunk: TextChunk): string[] {
  return chunk.chapter.paragraphs.slice(chunk.from - 1, chunk.to).map((p) => p.text);
}

function chunkSize(chunk: TextChunk, cjk: boolean): string {
  const n = chunkTexts(chunk).reduce((sum, t) => sum + sizeOf(t, cjk), 0);
  return count(n, cjk ? "char" : "word");
}

export const TEXT_STUDY: SourceStudyKind = {
  excerptReadsChunk: true,
  kind: "text",
  version: 1,

  async structure(src) {
    const { book, chunks, cjk } = await readBook(src);
    if (book.chapters.length === 0) {
      throw new KonteError("SOURCE_UNREADABLE", `${src.file} holds no text`);
    }
    const all = book.chapters.flatMap((c) => c.paragraphs.map((p) => p.text));
    const lang = speechLangOf(all.join(""));
    const total = all.reduce((sum, t) => sum + sizeOf(t, cjk), 0);
    const summary = [
      count(total, cjk ? "char" : "word"),
      book.stories.length > 0
        ? count(book.stories.length, "story", "stories")
        : count(book.chapters.length, "chapter"),
      count(chunks.length, "chunk"),
      `dialogue ${dialogueShare(all)}%`,
    ].join(" · ");
    const units =
      book.stories.length > 0
        ? book.stories.map((s) => ({ id: s.id, title: s.title }))
        : book.chapters.map((c) => ({ id: c.prefix, title: c.title }));
    return {
      summary,
      notes: book.notes,
      names: nameCandidates(all, cjk),
      units,
      chunks: chunks.map((c) => ({
        id: c.id,
        title: c.chapter.title,
        unit: c.chapter.unit,
        from: c.from,
        to: c.to,
        size: chunkSize(c, cjk),
        spokenSec: spokenSecOf(chunkTexts(c).flatMap(quotedSpans), lang),
      })),
    };
  },

  async writeChunk(src, _index, chunk, stem) {
    const { chunks } = await readBook(src);
    const found = chunks.find((c) => c.id === chunk);
    if (!found) throw new KonteError("SOURCE_UNREADABLE", `The source has no chunk ${chunk}`);
    const lines: string[] = [];
    const readingsOf = new Set<string>();
    for (let n = found.from; n <= found.to; n++) {
      const p = found.chapter.paragraphs[n - 1]!;
      lines.push(`${found.chapter.prefix}.p${n} ${p.text}`);
      for (const r of p.readings) readingsOf.add(r);
    }
    if (readingsOf.size > 0) lines.push("", `読み: ${[...readingsOf].join(" ")}`);
    const dir = sourceChunksDir(src);
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(path.join(dir, `${stem}.md`), `${lines.join("\n")}\n`);
  },

  chunkFiles(_index, _chunk, stem) {
    return [`${stem}.md`];
  },

  async excerpt(src, _index, _chunk, stem, at) {
    const text = await fs.readFile(path.join(sourceChunksDir(src), `${stem}.md`), "utf-8");
    const wanted = new Set<string>();
    for (let n = at.from; n <= at.to; n++) wanted.add(`${at.prefix}.p${n}`);
    return { text: text.split("\n").filter((line) => wanted.has(line.split(" ", 1)[0]!)) };
  },
};
