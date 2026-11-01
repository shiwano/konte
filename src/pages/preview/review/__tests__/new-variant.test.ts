import { describe, expect, it } from "vitest";
import { isNewVariant } from "../new-variant.js";

describe("isNewVariant", () => {
  const variant = { variantStatus: "none" as const, stale: false, dismissed: false };

  it("counts an undecided take whether or not one is accepted beside it", () => {
    expect(isNewVariant(variant)).toBe(true);
  });

  it("leaves out an accepted, a stale and a dismissed take", () => {
    expect(isNewVariant({ ...variant, variantStatus: "accepted" })).toBe(false);
    expect(isNewVariant({ ...variant, stale: true })).toBe(false);
    expect(isNewVariant({ ...variant, dismissed: true })).toBe(false);
  });
});
