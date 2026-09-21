import { describe, expect, it } from "vitest";
import { shortId } from "../short-id.js";

describe("shortId", () => {
  it("returns an 8-char alphanumeric string", () => {
    expect(shortId()).toMatch(/^[0-9A-Za-z]{8}$/);
  });

  it("uses only the expected alphabet (no `-`/`_`)", () => {
    for (let i = 0; i < 100; i++) {
      expect(shortId()).toMatch(/^[0-9A-Za-z]{8}$/);
    }
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = shortId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });
});
