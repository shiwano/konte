import { describe, expect, it } from "vitest";
import { DEFAULT_LIST_CAP, capList, moreLine } from "../format-list.js";

describe("capList", () => {
  it("returns every item when the count is at or below the cap", () => {
    const items = Array.from({ length: DEFAULT_LIST_CAP }, (_, i) => `item-${i}`);
    const { shown, hidden } = capList(items);
    expect(shown).toEqual(items);
    expect(hidden).toBe(0);
  });

  it("caps and reports the hidden remainder once the count exceeds the cap", () => {
    const items = Array.from({ length: DEFAULT_LIST_CAP + 5 }, (_, i) => `item-${i}`);
    const { shown, hidden } = capList(items);
    expect(shown).toHaveLength(DEFAULT_LIST_CAP);
    expect(hidden).toBe(5);
  });

  it("honors an explicit cap", () => {
    const { shown, hidden } = capList(["a", "b", "c"], { cap: 1 });
    expect(shown).toEqual(["a"]);
    expect(hidden).toBe(2);
  });

  it("shows everything when verbose regardless of size", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const { shown, hidden } = capList(items, { verbose: true });
    expect(shown).toHaveLength(100);
    expect(hidden).toBe(0);
  });
});

describe("moreLine", () => {
  it("summarizes the hidden count and names the flag that lifts the cap", () => {
    expect(moreLine(7)).toBe("… and 7 more (use -v)");
  });
});
