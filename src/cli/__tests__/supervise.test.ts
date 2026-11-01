import { describe, expect, it } from "vitest";
import { superviseChild } from "../supervise.js";

describe("superviseChild", () => {
  it("returns the child's exit code", async () => {
    const code = await superviseChild(
      { exited: Promise.resolve(3), kill() {} },
      { forwardSigint: false },
    );
    expect(code).toBe(3);
  });
});
