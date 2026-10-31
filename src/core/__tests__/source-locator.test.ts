import { describe, expect, it } from "vitest";
import {
  chunkFileStems,
  chunkKind,
  chunkPositionPrefix,
  formatClipClock,
  parseAt,
  parseSpan,
  resolveSpan,
  sceneChunk,
  sourceKindOfFile,
} from "../source-locator.js";

describe("source locators", () => {
  it("reads a kind off a chunk id and off the original", () => {
    expect(chunkKind("c3")).toBe("text");
    expect(chunkKind("s5.c2.1")).toBe("text");
    expect(chunkKind("v1.b3")).toBe("comic");
    expect(chunkKind("w3")).toBe("clip");
    expect(chunkKind("c03")).toBeNull();
    expect(sourceKindOfFile("a.epub", false)).toBe("text");
    expect(sourceKindOfFile("pages", true)).toBe("comic");
    expect(sourceKindOfFile("a.mkv", false)).toBe("clip");
    expect(sourceKindOfFile("a.docx", false)).toBeNull();
  });

  it("numbers a split chapter's paragraphs through the chapter", () => {
    expect(chunkPositionPrefix("c3.2")).toBe("c3");
    expect(chunkPositionPrefix("s5.c2")).toBe("s5.c2");
    expect(parseAt("text", "c3.p140-p150")).toEqual({ prefix: "c3", from: 140, to: 150 });
    expect(parseAt("text", "c3.p12")).toEqual({ prefix: "c3", from: 12, to: 12 });
    expect(parseAt("text", "c3.p18-p12")).toBeNull();
    expect(parseAt("comic", "v1.p31-p34")).toEqual({ prefix: "v1", from: 31, to: 34 });
    expect(parseAt("clip", "01:12.5-01:30.0")).toEqual({ prefix: "", from: 72.5, to: 90 });
    expect(formatClipClock(72.5)).toBe("01:12.5");
  });

  it("reads a scene's chunk", () => {
    expect(sceneChunk("c3.2.s1")).toBe("c3.2");
    expect(sceneChunk("v1.b3.s4")).toBe("v1.b3");
    expect(sceneChunk("c3")).toBeNull();
  });

  it("resolves a span over chapters, stories and abbreviated ranges", () => {
    const chunks = ["s1.c1", "s1.c2", "s2.c1", "s2.c2", "s2.c3"];
    expect(resolveSpan(parseSpan("s2")!, chunks)).toEqual(["s2.c1", "s2.c2", "s2.c3"]);
    expect(resolveSpan(parseSpan("s1.c2-s2.c1")!, chunks)).toEqual(["s1.c2", "s2.c1"]);
    expect(resolveSpan(parseSpan("c3-c4")!, ["c3.1", "c3.2", "c4", "c5"])).toEqual([
      "c3.1",
      "c3.2",
      "c4",
    ]);
    expect(parseSpan("v1.b3-b5")).toEqual({ from: "v1.b3", to: "v1.b5" });
    expect(resolveSpan(parseSpan("w9")!, ["w1", "w2"])).toBeNull();
    expect(parseSpan("chapter 3")).toBeNull();
  });

  it("pads each level of a file name to its widest number", () => {
    const stems = chunkFileStems(["c3", "c3.1", "c10"]);
    expect([...stems.values()]).toEqual(["c03", "c03.01", "c10"]);
    expect(chunkFileStems(["s5.c2"]).get("s5.c2")).toBe("s05.c02");
  });
});
