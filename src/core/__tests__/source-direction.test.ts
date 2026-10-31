import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDirectionBriefAddress } from "../address.js";
import { directionPartHashes } from "../direction-hash.js";
import { type Direction, defineDirection } from "../dsl/direction.js";
import {
  checkSourceLocators,
  excerptOf,
  looksByName,
  readDigest,
  sourceScenes,
  type SourceView,
  sourceViewIn,
  spanMeasure,
  unreadChunks,
  untranscribedPages,
} from "../source-direction.js";
import type { SourceChunk } from "../dsl/source.js";
import type { SourceStudyIndex } from "../types/index.js";
import {
  type SourceRef,
  importOriginal,
  readStudyIndex,
  refreshStudyIndex,
  sourceRefIn,
  studySource,
} from "../source-study.js";
import { directionDefaults } from "./helpers/direction.js";

const DSL = pathToFileURL(path.resolve(__dirname, "../dsl/source.ts")).href;

const NOVEL = `# 第一章

澪は駅に来た。

「切符を」と駅長が言った。

澪は答えなかった。

# 第二章

雨が止んだ。

澪は歩き出した。
`;

let root: string;
let videoRoot: string;
let ref: SourceRef;

function write(rel: string, body: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// c1's digest, its one scene at `at`, and c2's.
function writeDigest(at: string, change = "澪が切符を買えない"): void {
  write(
    "videos/main/source/digest/c01.ts",
    `import { defineSourceChunk } from ${JSON.stringify(DSL)};
export default defineSourceChunk({
  chunk: "c1",
  scenes: {
    "c1.s1": { at: ${JSON.stringify(at)}, place: "駅", present: ["澪", "駅長"], change: ${JSON.stringify(change)} },
  },
  looks: [{ of: "澪", at: "c1.p1", text: "澪は駅に来た。" }],
});`,
  );
  write(
    "videos/main/source/digest/c02.ts",
    `import { defineSourceChunk } from ${JSON.stringify(DSL)};
export default defineSourceChunk({
  chunk: "c2",
  scenes: { "c2.s1": { at: "c2.p1-p2", place: "道", present: ["澪"], change: "澪が歩き出す" } },
});`,
  );
}

function direction(span: string): Direction {
  return defineDirection({
    ...directionDefaults,
    brief: { logline: "x", source: { span, keep: ["切符"] } },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [{ id: "01", role: "ordinary", action: "x", setup: "front", duration: 2, lineup: [] }],
    },
  }) as unknown as Direction;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "konte-source-dir-")));
  write("konte.config.json", "{}");
  write("videos/main/source/novel.md", NOVEL);
  videoRoot = path.join(root, "videos", "main");
  fs.mkdirSync(videoRoot, { recursive: true });
  ref = { dir: path.join(videoRoot, "source"), file: "novel.md" };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("the source locator check", () => {
  it("passes a digest inside its chunks and a span the chunks hold", async () => {
    writeDigest("c1.p1-p3");
    await studySource(ref, { progress: () => {} });
    expect(await checkSourceLocators(direction("c1-c2"), videoRoot)).toEqual([]);
  });

  it("finds an `at` past its chunk and a span past the original", async () => {
    writeDigest("c1.p2-p9");
    const findings = await checkSourceLocators(direction("c1-c7"), videoRoot);
    expect(findings.map((f) => [f.code, f.subject])).toEqual([
      ["source-locator-out-of-range", "brief.source.span"],
      ["source-locator-out-of-range", "source:c1"],
    ]);
    expect(findings[1]!.message).toContain("c1.s1 at c1.p2-p9");
  });

  it("finds a source the video does not hold", async () => {
    fs.rmSync(ref.dir, { recursive: true });
    const findings = await checkSourceLocators(direction("c1"), videoRoot);
    expect(findings.map((f) => f.subject)).toEqual(["brief.source"]);
  });

  it("counts a changed original again and drops the chunks of the old count", async () => {
    writeDigest("c1.p1-p3");
    await studySource(ref, { progress: () => {} });
    const chunkFile = path.join(ref.dir, "chunks/c01.md");
    expect(fs.existsSync(chunkFile)).toBe(true);

    write("videos/main/source/novel.md", NOVEL.replace("澪は答えなかった。\n\n", ""));
    const findings = await checkSourceLocators(direction("c1"), videoRoot);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("konte source import text source/novel.md");
    expect(fs.existsSync(chunkFile)).toBe(false);
  });
});

describe("brief.source hashing", () => {
  it("hashes the span and the map", () => {
    const address = formatDirectionBriefAddress("source");
    const one = directionPartHashes(direction("c1")).get(address);
    expect(one).toBeDefined();
    expect(directionPartHashes(direction("c1-c2")).get(address)).not.toBe(one);
  });
});

describe("refreshing the chunks' index", () => {
  it("takes a touched original's new mtime without counting it again", async () => {
    await studySource(ref, { progress: () => {} });
    const file = path.join(ref.dir, "novel.md");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const first = await refreshStudyIndex(ref);
    expect(first.recounted).toBe(false);
    expect(readStudyIndex(ref)!.fingerprint[0]!.mtimeMs).toBe(fs.statSync(file).mtimeMs);
    expect(fs.existsSync(path.join(ref.dir, "chunks/c01.md"))).toBe(true);
  });

  it("reads a source that moved to another file as that file's kind", async () => {
    await studySource(ref, { progress: () => {} });
    write("videos/main/source/page/001.png", "");
    await expect(refreshStudyIndex({ ...ref, file: "page" })).rejects.toMatchObject({
      code: "COMIC_BINDING_UNKNOWN",
    });
  });
});

describe("reading a source", () => {
  it("names the span's chunks no reader has read", async () => {
    writeDigest("c1.p1-p3");
    expect(unreadChunks((await sourceViewIn(videoRoot, "c1-c2"))!)).toEqual([]);
    fs.rmSync(path.join(ref.dir, "digest/c02.ts"));
    expect(unreadChunks((await sourceViewIn(videoRoot, "c1-c2"))!)).toEqual(["c2"]);
  });

  it("reads the scenes, the looks by name and a scene's passage", async () => {
    writeDigest("c1.p1-p3");
    const sv = (await sourceViewIn(videoRoot, null))!;
    expect([...sourceScenes(sv.chunks).keys()]).toEqual(["c1.s1", "c2.s1"]);
    expect([...looksByName(sv.chunks)].map(([name, looks]) => [name, looks.length])).toEqual([
      ["澪", 1],
    ]);
    expect(await excerptOf(sv, "c1", "c1.p2")).toEqual({
      text: ["c1.p2 「切符を」と駅長が言った。"],
    });
  });

  it("reads a digest rewritten since it was last read", async () => {
    writeDigest("c1.p1-p3");
    expect((await readDigest(ref)).chunks[0]!.scenes).toMatchObject({
      "c1.s1": { change: "澪が切符を買えない" },
    });
    const later = new Date(Date.now() + 60_000);
    writeDigest("c1.p1-p3", "澪が切符を見つける");
    fs.utimesSync(path.join(ref.dir, "digest/c01.ts"), later, later);
    expect((await readDigest(ref)).chunks[0]!.scenes).toMatchObject({
      "c1.s1": { change: "澪が切符を見つける" },
    });
  });
});

describe("a digest that does not load", () => {
  it("is a finding of the check, and the rest of the digest still reads", async () => {
    writeDigest("c1.p1-p3");
    await studySource(ref, { progress: () => {} });
    write("videos/main/source/digest/c03.ts", "export default {");
    write("videos/main/source/digest/c04.ts", "export const value = 1;");
    const findings = await checkSourceLocators(direction("c1-c2"), videoRoot);
    expect(findings.map((f) => f.subject)).toEqual(["source:c03.ts", "source:c04.ts"]);
    const sv = (await sourceViewIn(videoRoot, "c1-c2"))!;
    expect(sv.chunks.map((c) => c.chunk)).toEqual(["c1", "c2"]);
    expect(sv.unreadable.map((u) => u.file)).toEqual(["c03.ts", "c04.ts"]);
  });
});

describe("importing an original", () => {
  it("copies a file in once, and again only where it changed", async () => {
    fs.rmSync(ref.dir, { recursive: true });
    const outside = write("books/ame.md", NOVEL);
    expect(await importOriginal(videoRoot, outside)).toEqual({ dir: ref.dir, file: "ame.md" });
    const copy = path.join(ref.dir, "ame.md");
    const mtime = fs.statSync(copy).mtimeMs;
    await importOriginal(videoRoot, outside);
    expect(fs.statSync(copy).mtimeMs).toBe(mtime);
    write("books/ame.md", `${NOVEL}\n終わり\n`);
    await importOriginal(videoRoot, outside);
    expect(fs.readFileSync(copy, "utf-8")).toContain("終わり");
  });

  it("refuses an original named as konte's own directory", async () => {
    const pages = write("books/chunks/001.png", "");
    await expect(importOriginal(videoRoot, path.dirname(pages))).rejects.toMatchObject({
      code: "SOURCE_UNREADABLE",
    });
  });

  it("takes an original already under source/ where it lies", async () => {
    expect(await importOriginal(videoRoot, path.join(ref.dir, "novel.md"))).toEqual(ref);
    expect(sourceRefIn(videoRoot)).toEqual(ref);
  });
});

function comicView(chunks: SourceChunk[], span: string | null): SourceView {
  const index: SourceStudyIndex = {
    version: 1,
    kind: "comic",
    file: "vol01.zip",
    fingerprint: [],
    summary: "",
    notes: [],
    names: [],
    units: [{ id: "v1", title: null }],
    chunks: [
      { id: "v1.b1", title: null, unit: "v1", from: 1, to: 2, size: "2 pages" },
      { id: "v1.b2", title: null, unit: "v1", from: 3, to: 4, size: "2 pages" },
    ],
  };
  return { ref, index, chunks, unreadable: [], span };
}

const scene = (at: string, continues?: boolean) => ({
  at,
  place: "x",
  present: [],
  change: "x",
  ...(continues ? { continues } : {}),
});

describe("spanMeasure", () => {
  it("counts a text's scenes and what its quotations take to say", async () => {
    writeDigest("c1.p1-p3");
    await studySource(ref, { progress: () => {} });
    const sv = (await sourceViewIn(videoRoot, "c1-c2"))!;
    const m = spanMeasure(sv);
    expect(m).toMatchObject({ scenes: 2, unread: 0, runSec: null, pages: null });
    expect(m.spokenSec).toBeGreaterThan(0);
    expect(sv.index!.chunks.find((c) => c.id === "c2")!.spokenSec).toBe(0);
  });

  it("counts a scene running on past a chunk once, and a comic's balloons alone, ruby dropped", () => {
    const b1: SourceChunk = {
      chunk: "v1.b1",
      scenes: { "v1.b1.s1": scene("v1.p1"), "v1.b1.s2": scene("v1.p2", true) },
      looks: [],
      pages: {
        "v1.p1": [
          {
            picture: "居間",
            text: [
              { kind: "caption", text: "翌朝、ベーカー街の居間に一人の客が訪ねてきた" },
              { kind: "balloon", by: "ホームズ", text: "やあ" },
            ],
          },
        ],
        "v1.p2": [
          {
            picture: "戸口",
            text: [
              { kind: "sfx", text: "ガチャ" },
              { kind: "thought", by: "斉藤", text: "スゴイな……牛田さん……" },
            ],
          },
        ],
      },
    };
    const b2: SourceChunk = {
      chunk: "v1.b2",
      scenes: { "v1.b2.s1": scene("v1.p3"), "v1.b2.s2": scene("v1.p4") },
      looks: [],
      pages: {},
    };
    const both = spanMeasure(comicView([b1, b2], "v1"));
    expect(both).toMatchObject({ scenes: 3, unread: 0, pages: 4, runSec: null });
    const balloonOnly = spanMeasure(comicView([b1], "v1.b1"));
    expect(balloonOnly.spokenSec).toBe(both.spokenSec);
    expect(both.spokenSec).toBeLessThan(2);
    const ruby: SourceChunk = {
      ...b1,
      pages: {
        ...b1.pages,
        "v1.p1": [
          {
            picture: "居間",
            text: [
              { kind: "caption", text: "翌朝、ベーカー街の居間に一人の客が訪ねてきた" },
              { kind: "balloon", by: "ホームズ", text: "やあ《やあやあやあやあ》" },
            ],
          },
        ],
      },
    };
    expect(spanMeasure(comicView([ruby, b2], "v1")).spokenSec).toBe(both.spokenSec);
  });

  it("marks the chunks not read, whose scenes are not counted", () => {
    const b1: SourceChunk = {
      chunk: "v1.b1",
      scenes: { "v1.b1.s1": scene("v1.p1", true) },
      looks: [],
      pages: {},
    };
    expect(spanMeasure(comicView([b1], "v1"))).toMatchObject({ scenes: 1, unread: 1 });
  });
});

describe("untranscribedPages", () => {
  it("names each page of a comic chunk its pages leave out", () => {
    const b1: SourceChunk = {
      chunk: "v1.b1",
      scenes: {},
      looks: [],
      pages: { "v1.p2": [{ picture: "x", text: [] }] },
    };
    const sv = comicView([b1], "v1");
    expect(untranscribedPages(sv.index!, sv.chunks).map((p) => p.message)).toEqual([
      "v1.p1 of v1.b1 not transcribed in `pages`",
    ]);
  });
});
