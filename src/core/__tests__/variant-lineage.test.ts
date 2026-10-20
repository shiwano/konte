import { describe, expect, it } from "vitest";
import type { KonteState, VariantState } from "../types/index.js";
import {
  acceptedConsumers,
  collectDescendants,
  hasAcceptedDescendant,
  isProtectedVariant,
  isReviewLeaf,
} from "../variant-lineage.js";

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

const ADDR = "animatic:shot.01.first";

// v-a, patched twice — a script edited and re-applied yields two attempts at one fix. Plus v-x, an
// unrelated reroll of the same address. One level is as deep as a lineage gets: a patch's output
// cannot itself be patched.
function chainState(overrides: Record<string, Partial<VariantState>> = {}): KonteState {
  return {
    schemaVersion: 5,
    assets: {
      [ADDR]: {
        variants: {
          "v-a": variant({ file: "a.png", ...overrides["v-a"] }),
          "v-b": variant({ file: "b.png", derivedFrom: "v-a", ...overrides["v-b"] }),
          "v-b2": variant({ file: "b2.png", derivedFrom: "v-a", ...overrides["v-b2"] }),
          "v-x": variant({ file: "x.png", ...overrides["v-x"] }),
        },
      },
    },
  };
}

describe("isReviewLeaf", () => {
  it("treats a patched take as a before, not a candidate", () => {
    const state = chainState();
    expect(isReviewLeaf(state, ADDR, "v-a")).toBe(false);
    // Both attempts are genuine candidates sharing one "before" — the constraint is one patch
    // SCRIPT per take, not one output.
    expect(isReviewLeaf(state, ADDR, "v-b")).toBe(true);
    expect(isReviewLeaf(state, ADDR, "v-b2")).toBe(true);
  });

  it("leaves an unrelated sibling a candidate", () => {
    expect(isReviewLeaf(chainState(), ADDR, "v-x")).toBe(true);
  });
});

describe("collectDescendants", () => {
  it("collects every correction of a take, excluding the take itself", () => {
    const state = chainState();
    expect(collectDescendants(state, ADDR, "v-a").sort()).toEqual(["v-b", "v-b2"]);
    expect(collectDescendants(state, ADDR, "v-b")).toEqual([]);
  });

  it("does not pull in an unrelated sibling", () => {
    expect(collectDescendants(chainState(), ADDR, "v-x")).toEqual([]);
  });

  // Deeper than a patch can build one, since the deletion paths this feeds must not depend on the
  // depth invariant holding in a state they did not write.
  it("walks a chain deeper than one level", () => {
    const state = chainState();
    state.assets[ADDR]!.variants!["v-c"] = variant({ file: "c.png", derivedFrom: "v-b" });
    expect(collectDescendants(state, ADDR, "v-a").sort()).toEqual(["v-b", "v-b2", "v-c"]);
  });
});

describe("hasAcceptedDescendant", () => {
  // The source file is the patch's input, so an accepted correction must keep the take it
  // corrected alive even though that one is not itself accepted.
  it("protects the source of an accepted correction", () => {
    const state = chainState({ "v-b": { status: "accepted" } });
    expect(hasAcceptedDescendant(state, ADDR, "v-a")).toBe(true);
    expect(hasAcceptedDescendant(state, ADDR, "v-b")).toBe(false);
  });

  it("does not protect anything when the lineage is unaccepted", () => {
    const state = chainState();
    expect(hasAcceptedDescendant(state, ADDR, "v-a")).toBe(false);
  });
});

describe("acceptedConsumers", () => {
  // reference:cat v-c -> animatic:shot.01.first v-k -> video:shot.01.motion v-m (accepted)
  function madeFromState(motionStatus: VariantState["status"]): KonteState {
    return {
      schemaVersion: 5,
      assets: {
        "reference:cat": {
          variants: {
            "v-c": variant({ outputHash: "h-cat" }),
            "v-c2": variant({ outputHash: "h-cat2", status: "accepted" }),
          },
        },
        [ADDR]: {
          variants: {
            "v-k": variant({
              outputHash: "h-key",
              inputFingerprints: { "reference:cat": "h-cat" },
            }),
          },
        },
        "video:shot.01.motion": {
          variants: {
            "v-m": variant({ status: motionStatus, inputFingerprints: { [ADDR]: "h-key" } }),
          },
        },
      },
    };
  }

  it("traces an accepted take back through every take it was made from", () => {
    const consumers = acceptedConsumers(madeFromState("accepted"));
    const root = [{ address: "video:shot.01.motion", variantId: "v-m" }];
    expect(consumers.get(`${ADDR} v-k`)).toEqual(root);
    expect(consumers.get("reference:cat v-c")).toEqual(root);
    expect(consumers.has("reference:cat v-c2")).toBe(false);
  });

  it("protects what an accepted take was made from, whatever its own status", () => {
    const state = madeFromState("accepted");
    expect(isProtectedVariant(state, "reference:cat", "v-c")).toBe(true);
    expect(isProtectedVariant(madeFromState("none"), "reference:cat", "v-c")).toBe(false);
  });

  // An accepted patched take carries its source's kept inputs, not what the source was made from.
  it("traces a patched take back through the take it corrected", () => {
    const state: KonteState = {
      schemaVersion: 5,
      assets: {
        "reference:cat": {
          variants: {
            "v-old": variant({ outputHash: "old" }),
            "v-new": variant({ outputHash: "new", status: "accepted" }),
          },
        },
        [ADDR]: {
          variants: {
            "v-src": variant({ outputHash: "src", inputFingerprints: { "reference:cat": "old" } }),
            "v-fix": variant({
              status: "accepted",
              derivedFrom: "v-src",
              inputFingerprints: { "reference:cat": "new" },
            }),
          },
        },
      },
    };
    expect(isProtectedVariant(state, "reference:cat", "v-old")).toBe(true);
  });
});
