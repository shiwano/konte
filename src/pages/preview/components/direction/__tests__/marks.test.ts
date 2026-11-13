import { describe, expect, it } from "vitest";

import type { DirectionPartInfo } from "../../../types.js";
import { partMarks } from "../marks.js";

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
