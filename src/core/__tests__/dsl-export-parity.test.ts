import { describe, expect, it } from "vitest";
import * as index from "../dsl/index.js";
import * as templateEntry from "../dsl/template-entry.js";

// AGENTS.md: a new DSL function/type must be exported from BOTH dsl/index.ts (runtime)
// and dsl/template-entry.ts (the user-facing type surface). This guards the runtime
// (value) exports against drift; type-only exports can't be checked at runtime.

// Exports index.ts carries for konte's own callers, deliberately absent from the user-facing
// template surface: the render helpers, and the fixture adapter the tests drive a reviewable asset
// with (see internal-test-asset.ts — a workspace has no use for it, so `.konte/mod.ts` must not
// declare it).
const INDEX_ONLY = new Set([
  "runInRenderMode",
  "runTimelineInRenderMode",
  "internalTestImage",
  "internalTestPlate",
]);

describe("DSL export parity", () => {
  it("every runtime index export is on the template surface", () => {
    const missing = Object.keys(index).filter(
      (name) => !INDEX_ONLY.has(name) && !(name in templateEntry),
    );
    expect(missing).toEqual([]);
  });

  it("the index-only allowlist stays accurate", () => {
    for (const name of INDEX_ONLY) {
      expect(name in index).toBe(true);
      expect(name in templateEntry).toBe(false);
    }
  });
});
