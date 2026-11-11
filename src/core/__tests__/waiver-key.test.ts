import { describe, it } from "vitest";
import { defineDirection } from "../dsl/index.js";
import { directionDefaults } from "./helpers/direction.js";

const sequence = {
  lens: "mini-drama",
  pleasure: "cute",
  shots: [{ id: "01", role: "ordinary", action: "a", duration: 2, setup: "front", lineup: [] }],
} as const;

describe("a waiver key", () => {
  it("takes a waivable code, bare or with a subject", () => {
    defineDirection({
      ...directionDefaults,
      waivers: { "no-payoff": "a loop", "multi-sentence-action_01": "a quiet shot" },
      sequence,
    });
  });

  it("refuses a code only a fix clears", () => {
    defineDirection({
      ...directionDefaults,
      waivers: {
        // @ts-expect-error -- `unused-setup` is cleared only by a fix
        "unused-setup_front": "kept for later",
      },
      sequence,
    });
  });

  it("refuses a code no finding has", () => {
    defineDirection({
      ...directionDefaults,
      waivers: {
        // @ts-expect-error -- a misspelled code
        "multi-sentance-action_01": "a quiet shot",
      },
      sequence,
    });
  });
});
