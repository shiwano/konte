import { describe, expect, it } from "vitest";
import { hasSeedPlaceholder, seed } from "../dsl/shot-context.js";

const DEP = "__konte:animatic:shot.01.first__";

describe("hasSeedPlaceholder", () => {
  it("detects a seed placeholder at any depth", () => {
    expect(hasSeedPlaceholder({ seed: seed() })).toBe(true);
    expect(hasSeedPlaceholder({ nested: { s: seed() } })).toBe(true);
    expect(hasSeedPlaceholder({ list: ["x", seed()] })).toBe(true);
  });

  it("returns false when no seed placeholder is present", () => {
    expect(hasSeedPlaceholder({ prompt: "a cat", image: DEP, count: 3 })).toBe(false);
    expect(hasSeedPlaceholder({})).toBe(false);
  });
});
