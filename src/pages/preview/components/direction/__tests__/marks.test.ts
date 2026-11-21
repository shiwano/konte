import { describe, expect, it } from "vitest";

import type { DirectionPartInfo } from "../../../../../core/types/review-state.js";
import { partMarks, rowMark } from "../marks.js";

const part = (address: string, status: DirectionPartInfo["status"]): DirectionPartInfo => ({
  address,
  status,
  feedback: [],
});

describe("partMarks", () => {
  it("marks nothing on a direction never signed off, whatever the brief holds", () => {
    const marks = partMarks([
      part("direction:brief.logline", "unsigned"),
      part("direction:policy.format", "unaccepted"),
      part("direction:sequence.01", "unaccepted"),
    ]);
    expect([...marks]).toEqual([]);
  });

  it("marks a part reworded or added since a sign-off, and never an unsigned one", () => {
    const marks = partMarks([
      part("direction:brief.logline", "unsigned"),
      part("direction:policy.format", "accepted"),
      part("direction:sequence.01", "stale"),
      part("direction:sequence.02", "unaccepted"),
    ]);
    expect([...marks]).toEqual([
      ["direction:sequence.01", "changed"],
      ["direction:sequence.02", "new"],
    ]);
  });

  it("marks the changed parts when every earlier sign-off went stale", () => {
    const marks = partMarks([
      part("direction:policy.format", "stale"),
      part("direction:sequence.01", "unaccepted"),
    ]);
    expect([...marks]).toEqual([
      ["direction:policy.format", "changed"],
      ["direction:sequence.01", "new"],
    ]);
  });
});

describe("rowMark", () => {
  const marks = new Map([
    ["direction:characters.a", "new"],
    ["direction:characters.a.voice", "new"],
    ["direction:setups.s1", "new"],
    ["direction:setups.s2", "changed"],
  ] as const);

  it("keeps a row's own mark over the marks of the parts inside it", () => {
    expect(rowMark(marks, "direction:characters.a", ["direction:characters.a.voice"])).toBe("new");
  });

  it("marks an unmarked row changed once a part inside it is marked", () => {
    expect(
      rowMark(marks, "direction:locations.l", ["direction:setups.s1", "direction:setups.s2"]),
    ).toBe("changed");
    expect(rowMark(marks, "direction:locations.l", [])).toBeUndefined();
  });
});
