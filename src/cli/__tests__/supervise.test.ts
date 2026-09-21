import { describe, expect, it } from "vitest";
import { RESTART_EXIT_CODE } from "../../core/process-restart.js";
import { superviseChild } from "../supervise.js";

function child(code: number) {
  return { exited: Promise.resolve(code), kill() {} };
}

describe("superviseChild", () => {
  it("returns the child's exit code", async () => {
    let spawns = 0;
    const code = await superviseChild(
      () => {
        spawns++;
        return child(3);
      },
      { forwardSigint: false },
    );
    expect(code).toBe(3);
    expect(spawns).toBe(1);
  });

  it("spawns a fresh child each time one asks to be restarted", async () => {
    const codes = [RESTART_EXIT_CODE, RESTART_EXIT_CODE, 0];
    let spawns = 0;
    const code = await superviseChild(
      () => {
        spawns++;
        return child(codes.shift()!);
      },
      { forwardSigint: false },
    );
    expect(code).toBe(0);
    expect(spawns).toBe(3);
  });
});
