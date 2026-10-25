import { describe, expect, it } from "vitest";
import { isNewVariant } from "../new-variant.js";

describe("isNewVariant", () => {
  const take = { variantStatus: "none" as const, stale: false, dismissed: false };

  it("counts an undecided take whether or not one is accepted beside it", () => {
    expect(isNewVariant(take)).toBe(true);
  });

  it("leaves out an accepted, a stale and a dismissed take", () => {
    expect(isNewVariant({ ...take, variantStatus: "accepted" })).toBe(false);
    expect(isNewVariant({ ...take, stale: true })).toBe(false);
    expect(isNewVariant({ ...take, dismissed: true })).toBe(false);
  });
});
