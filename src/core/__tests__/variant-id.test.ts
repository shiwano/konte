import { describe, expect, it } from "vitest";
import { generateVariantId } from "../variant-id.js";

describe("generateVariantId", () => {
  it("returns a v-<nanoid> format string", () => {
    const id = generateVariantId();
    expect(id).toMatch(/^v-[0-9A-Za-z]{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = generateVariantId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });
});
