import { describe, expect, it } from "vitest";
import { markFragments, quoteLines, quotedFragments, uniqueQuote } from "../quote.js";

describe("quoteLines", () => {
  it("prefixes each line and leaves a line to write on", () => {
    expect(quoteLines(["眉を寄せる", "No... her eyes are kinder."])).toBe(
      "> 眉を寄せる\n> No... her eyes are kinder.\n",
    );
  });
});

describe("uniqueQuote", () => {
  const action = "描いたばかりの目に顔を近づけ、目を細める。";
  const second = action.lastIndexOf("目");

  it("keeps words that occur once as selected, trimmed", () => {
    expect(uniqueQuote([action], { field: 0, start: 3, end: 8 })).toBe("ばかりの目");
    expect(uniqueQuote(["  顔  "], { field: 0, start: 0, end: 6 })).toBe("顔");
  });

  it("widens repeated words until the quote occurs once", () => {
    expect(uniqueQuote([action], { field: 0, start: second, end: second + 1 })).toBe("、目を");
    expect(markFragments([action], ["、目を"])).toEqual([[[second - 1, second + 2]]]);
  });

  it("counts the words in every field, not just the selected one", () => {
    expect(uniqueQuote(["顔を上げる", "顔"], { field: 1, start: 0, end: 1 })).toBe("顔");
    expect(uniqueQuote(["顔を上げる", "その顔"], { field: 1, start: 2, end: 3 })).toBe("の顔");
  });

  it("stops at the whole field when another field repeats it", () => {
    expect(uniqueQuote(["Yes!", "Yes!"], { field: 1, start: 0, end: 3 })).toBe("Yes!");
  });

  it("quotes nothing for whitespace", () => {
    expect(uniqueQuote(["a  b"], { field: 0, start: 1, end: 3 })).toBeNull();
  });
});

describe("quotedFragments", () => {
  it("reads only the quote lines of each comment", () => {
    expect(quotedFragments(["> 眉を寄せる\nもう少し溜めたい", "no quote", ">not a quote"])).toEqual(
      ["眉を寄せる"],
    );
  });
});

describe("markFragments", () => {
  it("marks the first occurrence in the first field holding the fragment", () => {
    expect(markFragments(["a b a", "a"], ["a"])).toEqual([[[0, 1]], []]);
    expect(markFragments(["x", "hi a"], ["a"])).toEqual([[], [[3, 4]]]);
  });

  it("merges overlapping marks", () => {
    expect(markFragments(["abcdef"], ["abc", "bcd", "f"])).toEqual([
      [
        [0, 4],
        [5, 6],
      ],
    ]);
  });

  it("marks nothing once the quoted words are gone", () => {
    expect(markFragments(["rewritten"], ["眉を寄せる"])).toEqual([[]]);
  });
});
