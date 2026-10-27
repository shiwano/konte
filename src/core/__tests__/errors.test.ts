import { describe, expect, it } from "vitest";
import { KonteError, errorMessage } from "../errors.js";

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

describe("errorMessage", () => {
  it("reads the message off a non-Error event", () => {
    const event = Object.assign(Object.create({ constructor: function ErrorEvent() {} }), {
      message: "WebSocket connection failed",
    });
    expect(errorMessage(event)).toBe("WebSocket connection failed");
  });

  it("stringifies a value with no message", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage({ message: 1 })).toBe("[object Object]");
  });
});
