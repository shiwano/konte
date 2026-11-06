import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { parseAt } from "../source-locator.js";
import { type SourceRef, readSourceIndex, chunkSource } from "../source-chunker.js";
import {
  TEXT_CHUNKER,
  dialogueShare,
  htmlParagraph,
  nameCandidates,
  stripAozoraRuby,
} from "../source-chunker-text.js";

// A zip of stored entries, enough for an EPUB.
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

function xhtml(body: string, type = "bodymatter"): string {
  return `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body epub:type="${type}">${body}</body></html>`;
}

const EPUB = {
  mimetype: "application/epub+zip",
  "META-INF/container.xml":
    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  "OEBPS/content.opf": `<package><manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="title" href="text/titlepage.xhtml" media-type="application/xhtml+xml"/>
    <item id="one" href="text/scandal.xhtml" media-type="application/xhtml+xml"/>
    <item id="two" href="text/league.xhtml" media-type="application/xhtml+xml"/>
  </manifest><spine><itemref idref="title"/><itemref idref="one"/><itemref idref="two"/></spine></package>`,
  "OEBPS/nav.xhtml": xhtml(
    `<nav epub:type="toc"><ol>
      <li><a href="text/titlepage.xhtml">Titlepage</a></li>
      <li><a href="text/scandal.xhtml">A Scandal in Bohemia</a><ol>
        <li><a href="text/scandal.xhtml#i">I</a></li>
        <li><a href="text/scandal.xhtml#ii">II</a></li>
      </ol></li>
      <li><a href="text/league.xhtml">The Red-Headed League</a></li>
    </ol></nav>`,
    "frontmatter",
  ),
  "OEBPS/text/titlepage.xhtml": xhtml("<p>The Adventures</p>", "frontmatter"),
  "OEBPS/text/scandal.xhtml": xhtml(
    `<section id="i"><h3>I</h3><p>To Sherlock Holmes she is always <i>the</i> woman.</p>
     <p>“I have seen Holmes,” said Watson &amp; smiled.</p></section>
     <section id="ii"><h3>II</h3><p>At three o’clock Holmes came.</p></section>`,
  ),
  "OEBPS/text/league.xhtml": xhtml(
    "<p>I had called upon my friend.</p><p><ruby>澪<rt>みお</rt></ruby>が来た。</p>",
  ),
};

const dirs: string[] = [];

async function source(file: string, content: Buffer | string): Promise<SourceRef> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "konte-source-text-"));
  dirs.push(root);
  const dir = path.join(root, "videos", "s", "source");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), content);
  return { dir, file };
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const progress = () => {};

describe("stripAozoraRuby", () => {
  it("keeps the base text and lists each reading", () => {
    expect(stripAozoraRuby("｜東京駅《とうきょうえき》で澪《みお》は待つ")).toEqual({
      text: "東京駅で澪は待つ",
      readings: ["東京駅《とうきょうえき》", "澪《みお》"],
    });
  });

  it("reads the kanji run before 《 where no ｜ opens the base", () => {
    expect(stripAozoraRuby("ある日の暮方《くれがた》の事").text).toBe("ある日の暮方の事");
    expect(stripAozoraRuby("ある日の暮方《くれがた》の事").readings).toEqual(["暮方《くれがた》"]);
  });
});

describe("htmlParagraph", () => {
  it("reduces ruby to its base and decodes entities", () => {
    expect(
      htmlParagraph("<ruby><rb>澪</rb><rp>(</rp><rt>みお</rt><rp>)</rp></ruby> &amp; 蓮"),
    ).toEqual({
      text: "澪 & 蓮",
      readings: ["澪《みお》"],
    });
  });
});

describe("dialogueShare", () => {
  it('counts what is inside 「」, “” and ""', () => {
    expect(dialogueShare(["「ああ」と言う"])).toBe(57);
    expect(dialogueShare(['"Go," he said'])).toBe(45);
    expect(dialogueShare(["no quotes"])).toBe(0);
  });

  it("runs a quotation left open to its paragraph's end, and no further", () => {
    expect(dialogueShare(["“Open", "shut"])).toBe(56);
  });
});

describe("nameCandidates", () => {
  it("takes capitalized words never seen at a sentence start or in lower case", () => {
    const names = nameCandidates(
      ["The man met Holmes and Watson.", "Then Holmes left with Watson.", "The end."],
      false,
    );
    expect(names).toEqual(["Holmes", "Watson"]);
  });

  it("takes katakana runs in a CJK text", () => {
    expect(nameCandidates(["ホームズとワトソン", "ホームズが来た"], true)).toEqual(["ホームズ"]);
  });
});

describe("TEXT_CHUNKER", () => {
  it("reads an EPUB's two-level TOC as stories and chapters, leaving front matter out", async () => {
    const src = await source("book.epub", storedZip(EPUB));
    const { index } = await chunkSource(src, { progress });
    expect(index.units).toEqual([
      { id: "s1", title: "A Scandal in Bohemia" },
      { id: "s2", title: "The Red-Headed League" },
    ]);
    expect(index.chunks.map((c) => [c.id, c.unit, c.from, c.to])).toEqual([
      ["s1.c1", "s1", 1, 2],
      ["s1.c2", "s1", 1, 1],
      ["s2.c1", "s2", 1, 2],
    ]);
    const chunk = await fs.readFile(path.join(src.dir, "chunks", "s01.c01.md"), "utf-8");
    expect(chunk).toBe(
      "s1.c1.p1 To Sherlock Holmes she is always the woman.\n" +
        "s1.c1.p2 “I have seen Holmes,” said Watson & smiled.\n",
    );
    const league = await fs.readFile(path.join(src.dir, "chunks", "s02.c01.md"), "utf-8");
    expect(league).toContain("s2.c1.p2 澪が来た。\n\n読み: 澪《みお》\n");
    expect(readSourceIndex(src)?.summary).toMatch(/· 2 stories · 3 chunks · dialogue \d+%$/);
  });

  it("reads the stories a half-title's TOC entry holds as the chapters", async () => {
    const epub = {
      ...EPUB,
      "OEBPS/content.opf": EPUB["OEBPS/content.opf"]
        .replace(
          '<item id="one"',
          '<item id="half" href="text/halftitlepage.xhtml" media-type="application/xhtml+xml"/><item id="one"',
        )
        .replace('<itemref idref="one"/>', '<itemref idref="half"/><itemref idref="one"/>'),
      "OEBPS/nav.xhtml": xhtml(
        `<nav epub:type="toc"><ol>
          <li><a href="text/titlepage.xhtml">Titlepage</a></li>
          <li><a href="text/halftitlepage.xhtml">The Adventures</a><ol>
            <li><a href="text/scandal.xhtml">A Scandal in Bohemia</a></li>
            <li><a href="text/league.xhtml">The Red-Headed League</a></li>
          </ol></li>
        </ol></nav>`,
        "frontmatter",
      ),
      "OEBPS/text/halftitlepage.xhtml": xhtml(
        '<section epub:type="halftitlepage"><p>The Adventures</p></section>',
        "frontmatter",
      ),
    };
    const src = await source("book.epub", storedZip(epub));
    const { index } = await chunkSource(src, { progress });
    expect(index.chunks.map((c) => [c.id, c.from, c.to])).toEqual([
      ["c1", 1, 3],
      ["c2", 1, 2],
    ]);
  });

  it("reads a Shift_JIS Aozora text: its heading notes, ruby, and none of its front or back matter", async () => {
    const text = [
      "羅生門",
      "芥川龍之介",
      "",
      "-------------------------------------------------------",
      "【テキスト中に現れる記号について】",
      "《》：ルビ",
      "-------------------------------------------------------",
      "",
      "上［＃「上」は中見出し］",
      "　ある日の暮方《くれがた》の事である。",
      "　一人の下人《げにん》が、羅生門《らしょうもん》の下で雨やみを待っていた。［＃「待っていた。」に傍点］",
      "下［＃「下」は中見出し］",
      "　「何をしていた」と下人は言った。",
      "",
      "底本：「芥川龍之介全集1」ちくま文庫、筑摩書房",
      "入力：j.utsugi",
    ].join("\r\n");
    const src = await source("rashomon.txt", shiftJis(text));
    const { index } = await chunkSource(src, { progress });
    expect(index.units).toEqual([
      { id: "c1", title: "上" },
      { id: "c2", title: "下" },
    ]);
    const c1 = await fs.readFile(path.join(src.dir, "chunks", "c01.md"), "utf-8");
    expect(c1).toBe(
      "c1.p1 ある日の暮方の事である。\n" +
        "c1.p2 一人の下人が、羅生門の下で雨やみを待っていた。\n" +
        "\n読み: 暮方《くれがた》 下人《げにん》 羅生門《らしょうもん》\n",
    );
    const c2 = await fs.readFile(path.join(src.dir, "chunks", "c02.md"), "utf-8");
    expect(c2).not.toContain("底本");
    expect(index.summary).toMatch(/chars · 2 chapters · 2 chunks · dialogue \d+%$/);
  });

  it("splits a text with no headings by length, as one chunk where it is short", async () => {
    const src = await source("short.md", "一段落目。\n\n二段落目。\n");
    const { index } = await chunkSource(src, { progress });
    expect(index.chunks.map((c) => c.id)).toEqual(["c1"]);
    expect(index.notes).toEqual(["no headings: split by length"]);
  });

  it("reads Markdown's chapters off its top level, a part heading alone making a story", async () => {
    const book = await source(
      "book.md",
      "# 本\n\n## 一\n\n### 朝\n\n雨。\n\n### 夜\n\n月。\n\n## 二\n\n晴れ。\n",
    );
    const { index } = await chunkSource(book, { progress });
    expect(index.chunks.map((c) => [c.id, c.title])).toEqual([
      ["c1", "一"],
      ["c2", "二"],
    ]);
    const parts = await source(
      "parts.md",
      "## 第一部\n\n### 第一章\n\n雨。\n\n## 第二部\n\n### 第一章\n\n月。\n",
    );
    const { index: parted } = await chunkSource(parts, { progress });
    expect(parted.chunks.map((c) => c.id)).toEqual(["s1.c1", "s2.c1"]);
  });

  it("splits a long chapter into parts whose paragraphs stay numbered through it", async () => {
    const paragraph = "あ".repeat(1000);
    const body = Array.from({ length: 20 }, () => paragraph).join("\n\n");
    const src = await source("long.md", `# 第一章\n\n${body}\n\n# 第二章\n\n短い。\n`);
    const { index } = await chunkSource(src, { progress });
    expect(index.chunks.map((c) => [c.id, c.from, c.to])).toEqual([
      ["c1.1", 1, 7],
      ["c1.2", 8, 14],
      ["c1.3", 15, 20],
      ["c2", 1, 1],
    ]);
    const part = await fs.readFile(path.join(src.dir, "chunks", "c01.02.md"), "utf-8");
    expect(part.split("\n")[0]).toMatch(/^c1\.p8 /);
    const excerpt = await TEXT_CHUNKER.excerpt(
      src,
      index,
      "c1.2",
      "c01.02",
      parseAt("text", "c1.p9-p10")!,
    );
    expect(excerpt).toEqual({ text: [`c1.p9 ${paragraph}`, `c1.p10 ${paragraph}`] });
  });
});

function shiftJis(text: string): Buffer {
  // Every character the fixture holds, encoded off the decoder's own table.
  const decoder = new TextDecoder("shift_jis");
  const table = new Map<string, number[]>();
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi > 0x9f && hi < 0xe0) continue;
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      const ch = decoder.decode(new Uint8Array([hi, lo]));
      if (ch.length === 1 && !table.has(ch)) table.set(ch, [hi, lo]);
    }
  }
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else out.push(...table.get(ch)!);
  }
  return Buffer.from(out);
}
