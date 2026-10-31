import { describe, expect, it } from "vitest";
import { defineSourceChunk } from "../dsl/source.js";

describe("defineSourceChunk", () => {
  it("keeps a chunk's scenes and looks", () => {
    const c = defineSourceChunk({
      chunk: "c3.2",
      scenes: {
        "c3.2.s1": { at: "c3.p140-p150", place: "駅", present: ["澪"], change: "澪が来る" },
      },
      looks: [{ of: "澪", at: "c3.p141", text: "濡れた前髪" }],
    });
    expect(Object.keys(c.scenes)).toEqual(["c3.2.s1"]);
    expect(c.looks.map((l) => l.of)).toEqual(["澪"]);
  });

  it("refuses a scene id of another chunk and a locator outside its chapter", () => {
    expect(() =>
      defineSourceChunk({
        chunk: "c3",
        // @ts-expect-error -- a scene of c4 in c3's digest
        scenes: { "c4.s1": { at: "c3.p1", place: "x", present: [], change: "x" } },
      }),
    ).toThrow(/c4\.s1/);
    expect(() =>
      defineSourceChunk({
        chunk: "c3",
        scenes: { "c3.s1": { at: "c4.p1", place: "x", present: [], change: "x" } },
      }),
    ).toThrow(/outside chunk c3/);
    expect(() =>
      defineSourceChunk({
        chunk: "v1.b3",
        scenes: { "v1.b3.s1": { at: "v1.p031", place: "x", present: [], change: "x" } },
        pages: {},
      }),
    ).toThrow(/no comic locator/);
  });

  it("keeps a comic chunk's pages, its panels in reading order", () => {
    const c = defineSourceChunk({
      chunk: "v1.b3",
      scenes: { "v1.b3.s1": { at: "v1.p31", place: "居間", present: ["ホームズ"], change: "x" } },
      pages: {
        "v1.p31": [
          {
            picture: "居間を引きで",
            text: [
              { kind: "caption", text: "三月二十日" },
              { kind: "balloon", by: "ホームズ", text: "やあ" },
            ],
          },
        ],
      },
    });
    expect(c.pages?.["v1.p31"]?.[0]?.text.map((t) => t.kind)).toEqual(["caption", "balloon"]);
  });

  it("demands pages of a comic chunk alone, a page per key, each with a panel", () => {
    expect(() =>
      // @ts-expect-error -- a comic chunk transcribes its pages
      defineSourceChunk({ chunk: "v1.b3", scenes: {} }),
    ).toThrow(/transcribes its pages/);
    expect(() =>
      // @ts-expect-error -- a text chunk holds no pages
      defineSourceChunk({ chunk: "c3", scenes: {}, pages: {} }),
    ).toThrow(/only a comic chunk/);
    expect(() =>
      defineSourceChunk({
        chunk: "v1.b3",
        scenes: {},
        pages: {
          "v1.p31": [],
          // @ts-expect-error -- a page per key
          "v1.p32-p33": [{ picture: "x", text: [] }],
        },
      }),
    ).toThrow(/digest of v1\.b3 has 2 error/);
  });
});
