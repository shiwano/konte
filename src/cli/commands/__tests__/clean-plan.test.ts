import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { KonteState, VariantState } from "../../../core/types/index.js";
import { variantDir } from "../../../core/variant-dir.js";
import { type CleanCategory, planClean } from "../clean-plan.js";

function variant(overrides: Partial<VariantState> = {}): VariantState {
  return {
    status: "none",
    file: null,
    definitionHash: null,
    outputHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    inputFingerprints: {},
    metadata: {},
    ...overrides,
  };
}

const SOURCE = "reference:latentA";
const STEP = "reference:patch.v-src.patched";
const STEP_FILE = path.join(variantDir("", STEP, "v-step"), "out.png");

function patchedState(step: Partial<VariantState>): KonteState {
  return {
    schemaVersion: 5,
    assets: {
      [SOURCE]: {
        variants: {
          "v-src": variant({ file: "src.png", status: "dismissed" }),
          "v-out": variant({ file: STEP_FILE, derivedFrom: "v-src" }),
        },
      },
      [STEP]: { variants: { "v-step": variant(step) } },
    },
  };
}

function plan(
  state: KonteState,
  opts: {
    only: Record<string, CleanCategory>;
    active?: string[];
    deleteUndecided?: boolean;
    stale?: string[];
  },
) {
  return planClean({
    state,
    addresses: Object.keys(state.assets),
    absent: new Set(),
    leaving: new Set(),
    only: new Map(Object.entries(opts.only)),
    deadLeaves: new Set(),
    isStaleLeftover: (_address, variantId) => (opts.stale ?? []).includes(variantId),
    stepPolicy: { reusable: new Set(), unloadedSources: "all" },
    activeJobVariantIds: new Set(opts.active ?? []),
    deleteUndecided: opts.deleteUndecided ?? false,
  });
}

describe("planClean", () => {
  it("keeps a source take whose patch is mid-apply", () => {
    const state = patchedState({});
    delete state.assets[SOURCE]!.variants!["v-out"];

    const result = plan(state, { only: { [`${SOURCE} v-src`]: "dismissed" }, active: ["v-step"] });

    expect(result.remove).toEqual([]);
    expect(result.kept).toEqual(["patch-applying"]);
  });

  it("keeps a step hosting the file of a take it was not judged with", () => {
    const state = patchedState({ file: STEP_FILE });

    const result = plan(state, {
      only: { [`${STEP} v-step`]: "undecided" },
      deleteUndecided: true,
    });

    expect(result.remove).toEqual([]);
    expect(result.kept).toEqual(["file-host"]);
  });

  it("removes a step together with the take whose file it hosts", () => {
    const state = patchedState({ file: STEP_FILE });

    const result = plan(state, {
      only: { [`${STEP} v-step`]: "undecided", [`${SOURCE} v-out`]: "undecided" },
      deleteUndecided: true,
    });

    expect(result.remove.map((c) => c.variantId).sort()).toEqual(["v-out", "v-step"]);
  });

  it("keeps a take deletable now only for a reason other than the one confirmed", () => {
    const state = patchedState({});
    state.assets[SOURCE]!.variants!["v-src"]!.status = "none";
    delete state.assets[SOURCE]!.variants!["v-out"];

    const result = plan(state, { only: { [`${SOURCE} v-src`]: "dismissed" }, stale: ["v-src"] });

    expect(result.remove).toEqual([]);
    expect(result.kept).toEqual(["reclassified"]);
  });
});
