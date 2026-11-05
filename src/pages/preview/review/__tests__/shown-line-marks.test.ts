import { describe, expect, it } from "vitest";
import { shownLineMarks } from "../shown-line-marks.js";

const line = (n: number, t: number | null) => ({ line: n, marks: [], timeAt: [t] });

describe("shownLineMarks", () => {
  const takes = [
    { address: "a", variantId: "v-1", resolved: true, lines: [line(1, 1)] },
    { address: "a", variantId: "v-2", resolved: false, lines: [line(1, 2)] },
    { address: "b", variantId: "v-3", resolved: true, lines: [line(1, null), line(2, 3)] },
  ];

  it("reads each address's resolved take, a line off the clip heard saying it", () => {
    expect(shownLineMarks(takes, {})).toEqual([line(1, 1), line(2, 3)]);
  });

  it("reads the take the page shows in its place", () => {
    expect(shownLineMarks(takes, { a: "v-2" })).toEqual([line(1, 2), line(2, 3)]);
  });
});
