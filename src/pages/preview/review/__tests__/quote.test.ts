import { describe, expect, it } from "vitest";
import {
  type QuoteFields,
  type QuoteKind,
  markFragments,
  parseQuoteLine,
  quoteLines,
  quotedFragments,
  uniqueQuote,
} from "../quote.js";

const plain = (...fields: string[]): QuoteFields => new Map([[null, fields]]);
const quoted = (
  fields: QuoteFields,
  kind: QuoteKind | null,
  field: number,
  start: number,
  end: number,
) => uniqueQuote(fields, { kind, field, start, end })?.text ?? null;

describe("quoteLines", () => {
  it("prefixes each line and leaves a line to write on", () => {
    expect(
      quoteLines([
        { kind: null, text: "眉を寄せる" },
        { kind: null, text: "No... her eyes are kinder." },
      ]),
    ).toBe("> 眉を寄せる\n> No... her eyes are kinder.\n");
  });

  it("tags a quote with its kind", () => {
    expect(
      quoteLines([
        { kind: "script", text: "靴下の仕立て" },
        { kind: "handoff", text: "読みをご確認ください" },
      ]),
    ).toBe("> script: 靴下の仕立て\n> handoff: 読みをご確認ください\n");
  });
});

describe("uniqueQuote", () => {
  const action = "描いたばかりの目に顔を近づけ、目を細める。";
  const second = action.lastIndexOf("目");

  it("keeps words that occur once as selected, trimmed", () => {
    expect(quoted(plain(action), null, 0, 3, 8)).toBe("ばかりの目");
    expect(quoted(plain("  顔  "), null, 0, 0, 6)).toBe("顔");
  });

  it("widens repeated words until the quote occurs once", () => {
    expect(
      uniqueQuote(plain(action), { kind: null, field: 0, start: second, end: second + 1 }),
    ).toEqual({ kind: null, field: 0, start: second - 1, end: second + 2, text: "、目を" });
    expect(markFragments(plain(action), [{ kind: null, text: "、目を" }]).get(null)).toEqual([
      [[second - 1, second + 2]],
    ]);
  });

  it("counts the words in every field of the kind, not just the selected one", () => {
    expect(quoted(plain("顔を上げる", "顔"), null, 1, 0, 1)).toBe("顔");
    expect(quoted(plain("顔を上げる", "その顔"), null, 1, 2, 3)).toBe("の顔");
  });

  it("judges uniqueness within the selected kind alone", () => {
    const fields: QuoteFields = new Map<QuoteKind, readonly string[]>([
      ["script", ["その顔"]],
      ["handoff", ["顔を確認"]],
    ]);
    expect(quoted(fields, "script", 0, 2, 3)).toBe("顔");
  });

  it("stops at the whole field when another field repeats it", () => {
    expect(quoted(plain("Yes!", "Yes!"), null, 1, 0, 3)).toBe("Yes!");
  });

  it("quotes nothing for whitespace", () => {
    expect(quoted(plain("a  b"), null, 0, 1, 3)).toBeNull();
  });
});

describe("parseQuoteLine", () => {
  it("reads a known kind tag and leaves any other text untagged", () => {
    expect(parseQuoteLine("> camera: slow push", true)).toEqual({
      kind: "camera",
      text: "slow push",
    });
    expect(parseQuoteLine("> note: x", true)).toEqual({ kind: null, text: "note: x" });
    expect(parseQuoteLine("> script: ", true)).toBeNull();
    expect(parseQuoteLine("not a quote", true)).toBeNull();
  });

  it("reads an untagged page's quote as its words, a kind's name included", () => {
    expect(parseQuoteLine("> camera: slow push", false)).toEqual({
      kind: null,
      text: "camera: slow push",
    });
  });
});

describe("quotedFragments", () => {
  it("reads only the quote lines of each comment", () => {
    expect(
      quotedFragments(
        ["> 眉を寄せる\n> acting: 囁く\nもう少し溜めたい", "no quote", ">not a quote"],
        true,
      ),
    ).toEqual([
      { kind: null, text: "眉を寄せる" },
      { kind: "acting", text: "囁く" },
    ]);
  });
});

describe("markFragments", () => {
  it("marks the first occurrence in the first field holding the fragment", () => {
    expect(markFragments(plain("a b a", "a"), [{ kind: null, text: "a" }]).get(null)).toEqual([
      [[0, 1]],
      [],
    ]);
    expect(markFragments(plain("x", "hi a"), [{ kind: null, text: "a" }]).get(null)).toEqual([
      [],
      [[3, 4]],
    ]);
  });

  it("matches a quote only within fields of its kind", () => {
    const fields: QuoteFields = new Map<QuoteKind, readonly string[]>([
      ["script", ["the push"]],
      ["camera", ["slow push"]],
    ]);
    const marks = markFragments(fields, [{ kind: "camera", text: "push" }]);
    expect(marks.get("script")).toEqual([[]]);
    expect(marks.get("camera")).toEqual([[[5, 9]]]);
    expect(markFragments(fields, [{ kind: null, text: "push" }]).get("camera")).toEqual([[]]);
  });

  it("merges overlapping marks", () => {
    const quotes = ["abc", "bcd", "f"].map((text) => ({ kind: null, text }));
    expect(markFragments(plain("abcdef"), quotes).get(null)).toEqual([
      [
        [0, 4],
        [5, 6],
      ],
    ]);
  });

  it("marks nothing once the quoted words are gone", () => {
    expect(
      markFragments(plain("rewritten"), [{ kind: null, text: "眉を寄せる" }]).get(null),
    ).toEqual([[]]);
  });
});
