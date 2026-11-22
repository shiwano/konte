import { describe, expect, it } from "vitest";
import type { LocalAssetDefinition } from "../../core/types/index.js";
import { localInputs } from "../inputs.js";

const def = (inputs: Record<string, unknown>): LocalAssetDefinition => ({
  kind: "local",
  operation: "trim",
  mediaType: "video",
  inputs,
});

describe("localInputs", () => {
  it("reads an operation's inputs as it declares them", () => {
    expect(localInputs(def({ source: "a.mp4", start: "tail", duration: 2 }), "trim")).toEqual({
      source: "a.mp4",
      start: "tail",
      duration: 2,
    });
  });

  it("refuses inputs the operation cannot read", () => {
    expect(() => localInputs(def({ source: "a.mp4", start: "head", duration: 2 }), "trim")).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
