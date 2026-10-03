import { describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";

describe("KonteError", () => {
  it("lists its items under the headline", () => {
    const err = new KonteError("VALIDATION_FAILED", "2 thing(s) are wrong — fix them", [
      "  a",
      "  b",
    ]);
    expect(err.message).toBe("2 thing(s) are wrong — fix them:\n  a\n  b");
  });

  it("is the headline alone without items", () => {
    expect(new KonteError("VALIDATION_FAILED", "one thing").message).toBe("one thing");
  });
});
