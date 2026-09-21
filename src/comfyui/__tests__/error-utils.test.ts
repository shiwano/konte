import { describe, expect, it } from "vitest";
import { extractHistoryError, historyOutcome } from "../error-utils.js";
import type { ComfyUIHistoryEntry } from "../types.js";

function makeHistory(
  statusStr: string,
  messages: Array<[string, Record<string, unknown>]> = [],
  completed = true,
): ComfyUIHistoryEntry {
  return {
    outputs: {},
    status: {
      status_str: statusStr,
      completed,
      messages,
    },
  };
}

describe("extractHistoryError", () => {
  it("returns null for successful history", () => {
    const history = makeHistory("success");
    expect(extractHistoryError(history)).toBeNull();
  });

  it("extracts error details from execution_error message", () => {
    const history = makeHistory("error", [
      [
        "execution_error",
        {
          node_id: "5",
          exception_type: "RuntimeError",
          exception_message: "CUDA out of memory",
        },
      ],
    ]);

    const result = extractHistoryError(history);
    expect(result).toContain("node 5");
    expect(result).toContain("RuntimeError");
    expect(result).toContain("CUDA out of memory");
  });

  it("returns generic message for error without execution_error messages", () => {
    const history = makeHistory("error", [["some_other_message", {}]]);

    const result = extractHistoryError(history);
    expect(result).toBe("ComfyUI execution failed");
  });

  it("returns generic message for error with empty messages", () => {
    const history = makeHistory("error");

    const result = extractHistoryError(history);
    expect(result).toBe("ComfyUI execution failed");
  });

  it("handles partial execution_error data", () => {
    const history = makeHistory("error", [["execution_error", { exception_type: "TypeError" }]]);

    const result = extractHistoryError(history);
    expect(result).toContain("TypeError");
  });

  it("skips non-error messages and finds execution_error", () => {
    const history = makeHistory("error", [
      ["execution_start", { prompt_id: "abc" }],
      [
        "execution_error",
        {
          node_id: "10",
          exception_type: "ValueError",
          exception_message: "Bad input shape",
        },
      ],
    ]);

    const result = extractHistoryError(history);
    expect(result).toContain("node 10");
    expect(result).toContain("ValueError");
    expect(result).toContain("Bad input shape");
  });
});

describe("historyOutcome", () => {
  it("reports error for a failed prompt (status_str error, completed false)", () => {
    // ComfyUI's real shape on failure — completed stays false.
    expect(historyOutcome(makeHistory("error", [], false))).toBe("error");
  });

  it("reports error even if status_str error somehow pairs with completed true", () => {
    expect(historyOutcome(makeHistory("error", [], true))).toBe("error");
  });

  it("reports success for a completed non-error prompt", () => {
    expect(historyOutcome(makeHistory("success", [], true))).toBe("success");
  });

  it("reports running for an in-progress prompt", () => {
    expect(historyOutcome(makeHistory("", [], false))).toBe("running");
  });
});
