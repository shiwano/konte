import { describe, expect, it } from "vitest";
import {
  collectUndecidedUpstreamTakes,
  collectStaleDependents,
  collectStaleVariants,
  computeAcceptedStaleness,
  computeVariantStaleness,
  createStalenessCache,
  formatStaleReason,
  isVariantStale,
  keptViaMarker,
  newestReadyUndecidedTake,
  undecidedTakeBesideAccepted,
  readyUndecidedTakes,
  resolvedStaleness,
  selectResolvedVariant,
} from "../staleness.js";
import type { KonteState, VariantState } from "../types/index.js";

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

function makeState(assets: KonteState["assets"]): KonteState {
  return { schemaVersion: 3, assets };
}

describe("computeVariantStaleness", () => {
  // (a) timeline.latent catch-22 regression: a deterministic upstream is accepted, but its
  // bytes are identical, so recorded == current => downstream stays NOT stale.
  it("does not mark a downstream stale when the accepted upstream output is byte-identical", () => {
    const latentHash = "latent-hash";
    const state = makeState({
      "video:timeline.latent": {
        variants: {
          "v-old": variant({ status: "none", file: "l.png", outputHash: latentHash }),
          "v-new": variant({ status: "accepted", file: "l.png", outputHash: latentHash }),
        },
      },
      "video:shot.01.motion": {
        variants: {
          "v-m": variant({
            status: "accepted",
            file: "m.mp4",
            inputFingerprints: { "video:timeline.latent": latentHash },
          }),
        },
      },
    });
    const downstream = state.assets["video:shot.01.motion"]!.variants!["v-m"]!;
    const s = computeVariantStaleness(state, "video:shot.01.motion", downstream, null);
    expect(s.inputStale).toBe(false);
    expect(s.definitionStale).toBe(false);
  });

  // (b) reroll / bytes change: the upstream accepted output hash differs from the recorded
  // fingerprint => downstream is input-stale.
  it("marks a downstream input-stale when the accepted upstream output bytes change", () => {
    const state = makeState({
      "video:shot.01.first": {
        variants: {
          "v-up": variant({ status: "accepted", file: "f.png", outputHash: "new-hash" }),
        },
      },
      "video:shot.01.motion": {
        variants: {
          "v-m": variant({
            status: "accepted",
            file: "m.mp4",
            inputFingerprints: { "video:shot.01.first": "old-hash" },
          }),
        },
      },
    });
    const downstream = state.assets["video:shot.01.motion"]!.variants!["v-m"]!;
    const s = computeVariantStaleness(state, "video:shot.01.motion", downstream, null);
    expect(s.inputStale).toBe(true);
    expect(s.changedInputs).toEqual([
      { assetPath: "video:shot.01.first", recorded: "old-hash", current: "new-hash" },
    ]);
  });

  // (c) definition edit: only definition-stale, not input-stale.
  it("marks a variant definition-stale when the definition changed but inputs match", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-m": variant({ status: "accepted", file: "m.mp4", definitionHash: "def-old" }),
        },
      },
    });
    const v = state.assets["video:shot.01.motion"]!.variants!["v-m"]!;
    const s = computeVariantStaleness(state, "video:shot.01.motion", v, "def-new");
    expect(s.definitionStale).toBe(true);
    expect(s.inputStale).toBe(false);
  });

  // (d) both input-stale and definition-stale.
  it("reports both input-stale and definition-stale together", () => {
    const state = makeState({
      "video:shot.01.first": {
        variants: {
          "v-up": variant({ status: "accepted", file: "f.png", outputHash: "new-hash" }),
        },
      },
      "video:shot.01.motion": {
        variants: {
          "v-m": variant({
            status: "accepted",
            file: "m.mp4",
            definitionHash: "def-old",
            inputFingerprints: { "video:shot.01.first": "old-hash" },
          }),
        },
      },
    });
    const v = state.assets["video:shot.01.motion"]!.variants!["v-m"]!;
    const s = computeVariantStaleness(state, "video:shot.01.motion", v, "def-new");
    expect(s.inputStale).toBe(true);
    expect(s.definitionStale).toBe(true);
  });

  // (e) missing recorded fingerprint / nothing resolves upstream => not determinable => not stale.
  it("treats a missing recorded fingerprint as not stale", () => {
    const state = makeState({
      "video:shot.01.first": {
        variants: {
          "v-up": variant({ status: "accepted", file: "f.png", outputHash: "h" }),
        },
      },
      "video:shot.01.motion": {
        variants: { "v-m": variant({ status: "accepted", file: "m.mp4" }) },
      },
    });
    const v = state.assets["video:shot.01.motion"]!.variants!["v-m"]!;
    expect(isVariantStale(state, "video:shot.01.motion", v, null)).toBe(false);
  });

  it("treats an upstream that resolves to nothing as not stale", () => {
    const state = makeState({
      "video:shot.01.first": {
        variants: { "v-up": variant({ status: "none", file: null, outputHash: null }) },
      },
      "video:shot.01.motion": {
        variants: {
          "v-m": variant({
            status: "accepted",
            file: "m.mp4",
            inputFingerprints: { "video:shot.01.first": "old-hash" },
          }),
        },
      },
    });
    const v = state.assets["video:shot.01.motion"]!.variants!["v-m"]!;
    expect(isVariantStale(state, "video:shot.01.motion", v, null)).toBe(false);
  });

  // Where nothing is accepted, resolution falls through to the newest non-stale take — so what
  // downstream consumes can move without an accept.
  describe("an unaccepted upstream", () => {
    const patchedUpstream = () =>
      makeState({
        "animatic:shot.12.last": {
          variants: {
            "v-src": variant({
              file: "src.png",
              outputHash: "before",
              createdAt: "2026-01-01T00:00:01.000Z",
            }),
            "v-fix": variant({
              file: "fix.png",
              outputHash: "after",
              derivedFrom: "v-src",
              createdAt: "2026-01-01T00:00:02.000Z",
            }),
          },
        },
        "animatic:shot.12.first": {
          variants: {
            "v-first": variant({
              file: "first.png",
              inputFingerprints: { "animatic:shot.12.last": "before" },
            }),
          },
        },
      });

    // The WORK.md scenario.
    it("stales a downstream when a patch lands on it", () => {
      const state = patchedUpstream();
      const v = state.assets["animatic:shot.12.first"]!.variants!["v-first"]!;
      const s = computeVariantStaleness(state, "animatic:shot.12.first", v, null);
      expect(s.inputStale).toBe(true);
      expect(s.changedInputs).toEqual([
        { assetPath: "animatic:shot.12.last", recorded: "before", current: "after" },
      ]);
    });

    // Same blind spot, reached by reroll rather than patch.
    it("stales a downstream when a reroll lands on it", () => {
      const state = patchedUpstream();
      delete state.assets["animatic:shot.12.last"]!.variants!["v-fix"]!.derivedFrom;
      const v = state.assets["animatic:shot.12.first"]!.variants!["v-first"]!;
      expect(isVariantStale(state, "animatic:shot.12.first", v, null)).toBe(true);
    });

    it("leaves a downstream alone while an accepted take pins the resolution", () => {
      const state = patchedUpstream();
      state.assets["animatic:shot.12.last"]!.variants!["v-src"]!.status = "accepted";
      const v = state.assets["animatic:shot.12.first"]!.variants!["v-first"]!;
      expect(isVariantStale(state, "animatic:shot.12.first", v, null)).toBe(false);

      state.assets["animatic:shot.12.last"]!.variants!["v-src"]!.status = "none";
      state.assets["animatic:shot.12.last"]!.variants!["v-fix"]!.status = "accepted";
      expect(isVariantStale(state, "animatic:shot.12.first", v, null)).toBe(true);
    });

    // A stale upstream resolves to nothing, so its own downstream is not determinable until it
    // is regenerated — staleness reaches one level at a time, as it always has.
    it("stops at an upstream that is itself stale, rather than reporting past it", () => {
      const state = patchedUpstream();
      state.assets["animatic:shot.13.first"] = {
        variants: {
          "v-13": variant({
            file: "13.png",
            inputFingerprints: { "animatic:shot.12.first": "first-hash" },
          }),
        },
      };
      state.assets["animatic:shot.12.first"]!.variants!["v-first"]!.outputHash = "first-hash";
      const v13 = state.assets["animatic:shot.13.first"]!.variants!["v-13"]!;
      expect(isVariantStale(state, "animatic:shot.13.first", v13, null)).toBe(false);

      // Rebuilding the middle level moves the wave one hop on.
      state.assets["animatic:shot.12.first"]!.variants!["v-rebuilt"] = variant({
        file: "first2.png",
        outputHash: "rebuilt-hash",
        createdAt: "2026-01-01T00:00:03.000Z",
        inputFingerprints: { "animatic:shot.12.last": "after" },
      });
      expect(isVariantStale(state, "animatic:shot.13.first", v13, null)).toBe(true);
    });

    it("reports the same stale dependents to collectStaleDependents", () => {
      const state = patchedUpstream();
      const dependents = new Map<string, readonly string[]>([
        ["animatic:shot.12.last", ["animatic:shot.12.first"]],
      ]);
      expect(collectStaleDependents(state, "animatic:shot.12.last", dependents)).toEqual([
        "animatic:shot.12.first",
      ]);
    });

    // A fingerprint recorded under an older definition can name an address already being resolved.
    // The guard has to end that recursion without letting the answer depend on where it started:
    // staleness must compare against the very take the render path picks.
    it("resolves a self-referencing fingerprint to the same take the render path picks", () => {
      const ADDR = "animatic:shot.01.first";
      const state = makeState({
        [ADDR]: {
          variants: {
            "v-old": variant({
              file: "old.png",
              outputHash: "old",
              createdAt: "2026-01-01T00:00:01.000Z",
            }),
            "v-new": variant({
              file: "new.png",
              outputHash: "new",
              createdAt: "2026-01-01T00:00:02.000Z",
              inputFingerprints: { [ADDR]: "old" },
            }),
          },
        },
        "animatic:shot.02.first": {
          variants: {
            "v-d": variant({ file: "d.png", inputFingerprints: { [ADDR]: "old" } }),
          },
        },
      });
      const resolved = selectResolvedVariant(state, ADDR);
      const downstream = state.assets["animatic:shot.02.first"]!.variants!["v-d"]!;
      const s = computeVariantStaleness(state, "animatic:shot.02.first", downstream, null);
      const comparedAgainst = s.changedInputs[0]?.current ?? "old";
      expect(comparedAgainst).toBe(state.assets[ADDR]!.variants![resolved!.variantId]!.outputHash);
    });
  });

  // A patch script is the authored definition of the variants it produced, so editing it ages
  // them out exactly as editing animatic.tsx ages out a generated take.
  describe("the patch axis", () => {
    const ADDR = "animatic:shot.01.first";
    const patched = () =>
      makeState({
        [ADDR]: {
          variants: {
            "v-src": variant({ file: "src.png", definitionHash: "def1" }),
            "v-fix": variant({
              file: "fix.png",
              definitionHash: "def1",
              derivedFrom: "v-src",
              patchHash: "patch1",
            }),
          },
        },
      });
    const fixOf = (s: KonteState) => s.assets[ADDR]!.variants!["v-fix"]!;

    it("marks the output definition-stale once the script's hash moves", () => {
      const state = patched();
      const hashes = new Map([["v-src", "patch2"]]);
      expect(
        computeVariantStaleness(state, ADDR, fixOf(state), "def1", hashes).definitionStale,
      ).toBe(true);
    });

    it("leaves it fresh while the script is unchanged", () => {
      const state = patched();
      const hashes = new Map([["v-src", "patch1"]]);
      expect(
        computeVariantStaleness(state, ADDR, fixOf(state), "def1", hashes).definitionStale,
      ).toBe(false);
    });

    // Callers without the patch catalog (the render/ref path) must not see phantom staleness.
    it("is inert when no hashes are supplied", () => {
      const state = patched();
      expect(computeVariantStaleness(state, ADDR, fixOf(state), "def1").definitionStale).toBe(
        false,
      );
    });

    // A script that is simply gone is an orphan for `prune` — not a reason to call its output stale.
    it("ignores a source with no current script", () => {
      const state = patched();
      expect(
        computeVariantStaleness(state, ADDR, fixOf(state), "def1", new Map()).definitionStale,
      ).toBe(false);
    });

    // The inherited definitionHash is what makes an asset edit stale source and correction alike.
    it("stales the whole lineage when the address's definition changes", () => {
      const state = patched();
      const hashes = new Map([["v-src", "patch1"]]);
      const src = state.assets[ADDR]!.variants!["v-src"]!;
      expect(isVariantStale(state, ADDR, src, "def2", hashes)).toBe(true);
      expect(isVariantStale(state, ADDR, fixOf(state), "def2", hashes)).toBe(true);
    });
  });
});

// A deterministic take is re-baked over ANY accept (`assetSkipReason`), so an accept on one protects
// nothing once stale: the animatic mix a reviewer signed off at the board, once the
// line under it is re-picked, must stop resolving — or the shot's composition is built over the
// voice take they dropped. The walk reads determinism off the definitions it is given.
describe("a deterministic take a human accepted", () => {
  const STEM = "animatic:shot.19#stem";
  const VO = "animatic:shot.19.vo";
  const deterministic = () =>
    createStalenessCache({
      definitionHash: () => null,
      isDeterministic: (address) => address === STEM,
    });

  function stateWithStem(stemOverrides: Partial<VariantState>): KonteState {
    return makeState({
      [VO]: {
        variants: {
          "v-vo": variant({ status: "accepted", file: "vo.mp3", outputHash: "vo-new" }),
        },
      },
      [STEM]: {
        variants: {
          "v-stem": variant({
            status: "accepted",
            file: "stem.wav",
            outputHash: "stem-old",
            inputFingerprints: { [VO]: "vo-old" },
            ...stemOverrides,
          }),
        },
      },
    });
  }

  it("does not resolve once the line under it has moved", () => {
    expect(selectResolvedVariant(stateWithStem({}), STEM, undefined, deterministic())).toBeNull();
  });

  it("is withheld from strict resolution too", () => {
    expect(
      selectResolvedVariant(stateWithStem({}), STEM, { requireAccepted: true }, deterministic()),
    ).toBeNull();
  });

  it("still resolves while it is fresh", () => {
    expect(
      selectResolvedVariant(
        stateWithStem({ inputFingerprints: { [VO]: "vo-new" } }),
        STEM,
        undefined,
        deterministic(),
      ),
    ).toEqual({ variantId: "v-stem", isAccepted: true });
  });

  it("stays available to the review surfaces through the stale fallback", () => {
    expect(
      selectResolvedVariant(stateWithStem({}), STEM, { includeStale: true }, deterministic()),
    ).toEqual({ variantId: "v-stem", isAccepted: false });
  });

  // A correction hung off a take at the address is refreshed by re-applying the patch — `generate`
  // leaves it `accepted-stale` — so its accept is a decision to protect, deterministic address or not.
  it("keeps resolving a patch output's accept, whose refresh is the patch pass's", () => {
    const state = stateWithStem({ derivedFrom: "v-source" });
    expect(selectResolvedVariant(state, STEM, undefined, deterministic())).toEqual({
      variantId: "v-stem",
      isAccepted: true,
    });
    expect(selectResolvedVariant(state, STEM, { requireAccepted: true }, deterministic())).toEqual({
      variantId: "v-stem",
      isAccepted: true,
    });
  });

  // Without definitions the walk cannot tell a mix from a picture, and an accept is a decision to
  // protect.
  it("keeps resolving for a walk given no definitions", () => {
    expect(selectResolvedVariant(stateWithStem({}), STEM)).toEqual({
      variantId: "v-stem",
      isAccepted: true,
    });
  });
});

describe("computeAcceptedStaleness", () => {
  it("returns null variantId when nothing is accepted", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: { "v-m": variant({ status: "none", file: "m.mp4" }) },
      },
    });
    const s = computeAcceptedStaleness(state, "video:shot.01.motion", null);
    expect(s.variantId).toBeNull();
    expect(s.inputStale).toBe(false);
    expect(s.definitionStale).toBe(false);
  });
});

describe("collectStaleVariants", () => {
  function stateWithUpstreamChange(): KonteState {
    return makeState({
      "video:shot.01.first": {
        variants: { "v-up": variant({ status: "accepted", file: "f.png", outputHash: "new" }) },
      },
      "video:shot.01.motion": {
        variants: {
          "v-acc": variant({
            status: "accepted",
            file: "m.mp4",
            inputFingerprints: { "video:shot.01.first": "old" },
          }),
          "v-none": variant({
            status: "none",
            file: "m2.mp4",
            inputFingerprints: { "video:shot.01.first": "old" },
          }),
          "v-none2": variant({
            status: "none",
            file: "m3.mp4",
            inputFingerprints: { "video:shot.01.first": "old" },
          }),
        },
      },
    });
  }

  it("returns only the accepted stale variant with its reason", () => {
    const state = stateWithUpstreamChange();
    const result = collectStaleVariants(state, "video:shot.01.motion", null);
    expect(result).toHaveLength(1);
    expect(result[0]!.variantId).toBe("v-acc");
    expect(result[0]!.inputStale).toBe(true);
    expect(result[0]!.changedInputs).toEqual([
      { assetPath: "video:shot.01.first", recorded: "old", current: "new" },
    ]);
  });

  it("returns empty when the accepted variant is fresh", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: { "v-acc": variant({ status: "accepted", file: "m.mp4" }) },
      },
    });
    expect(collectStaleVariants(state, "video:shot.01.motion", null)).toEqual([]);
  });
});

describe("resolvedStaleness", () => {
  it("reports the resolved take's staleness", () => {
    const state = makeState({
      "video:shot.01.first": {
        variants: { "v-up": variant({ status: "accepted", file: "f.png", outputHash: "new" }) },
      },
      "video:shot.01.motion": {
        variants: {
          "v-none": variant({
            status: "none",
            file: "m.mp4",
            inputFingerprints: { "video:shot.01.first": "old" },
          }),
        },
      },
    });
    expect(resolvedStaleness(state, "video:shot.01.motion", null)).toMatchObject({
      variantId: "v-none",
      inputStale: true,
    });
  });

  it("ignores a stale take that does not resolve", () => {
    const state = makeState({
      "video:shot.01.first": {
        variants: { "v-up": variant({ status: "accepted", file: "f.png", outputHash: "new" }) },
      },
      "video:shot.01.motion": {
        variants: {
          "v-old": variant({
            status: "dismissed",
            file: "old.mp4",
            inputFingerprints: { "video:shot.01.first": "old" },
          }),
          "v-acc": variant({
            status: "accepted",
            file: "m.mp4",
            inputFingerprints: { "video:shot.01.first": "new" },
          }),
        },
      },
    });
    expect(resolvedStaleness(state, "video:shot.01.motion", null)).toMatchObject({
      variantId: "v-acc",
      inputStale: false,
      definitionStale: false,
    });
  });

  it("is null when nothing resolves", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: { "v-d": variant({ status: "dismissed", file: "m.mp4" }) },
      },
    });
    expect(resolvedStaleness(state, "video:shot.01.motion", null)).toBeNull();
  });
});

describe("formatStaleReason", () => {
  it("lists changed input asset paths for input-stale", () => {
    expect(
      formatStaleReason({
        inputStale: true,
        definitionStale: false,
        patchStale: false,
        changedInputs: [
          { assetPath: "animatic:shot.01.first", recorded: "a", current: "b" },
          { assetPath: "animatic:timeline.character", recorded: "c", current: "d" },
        ],
      }),
    ).toBe("stale (input-stale: animatic:shot.01.first, animatic:timeline.character)");
  });

  it("combines input-stale and definition-stale", () => {
    expect(
      formatStaleReason({
        inputStale: true,
        definitionStale: true,
        patchStale: false,
        changedInputs: [{ assetPath: "video:shot.01.first", recorded: "a", current: "b" }],
      }),
    ).toBe("stale (input-stale: video:shot.01.first; definition-stale)");
  });

  it("falls back to bare stale when no reason flags are set", () => {
    expect(
      formatStaleReason({
        inputStale: false,
        definitionStale: false,
        patchStale: false,
        changedInputs: [],
      }),
    ).toBe("stale");
  });
});

describe("a dismissed take", () => {
  const ADDR = "animatic:shot.02.frame";

  function withDismissedNewest(): KonteState {
    return makeState({
      [ADDR]: {
        variants: {
          "v-old": variant({ file: "old.png", createdAt: "2026-01-01T00:00:01.000Z" }),
          "v-new": variant({
            status: "dismissed",
            file: "new.png",
            createdAt: "2026-01-01T00:00:02.000Z",
          }),
        },
      },
    });
  }

  // Resolution falls back past it: feeding a downstream generate the take the reviewer refused is
  // the one thing dismissing has to prevent.
  it("does not resolve, leaving the take beneath it", () => {
    expect(selectResolvedVariant(withDismissedNewest(), ADDR)).toEqual({
      variantId: "v-old",
      isAccepted: false,
    });
  });

  it("leaves the address unresolvable when it is the only take", () => {
    const state = withDismissedNewest();
    delete state.assets[ADDR]!.variants!["v-old"];
    expect(selectResolvedVariant(state, ADDR)).toBeNull();
    expect(selectResolvedVariant(state, ADDR, { includeStale: true })).toBeNull();
  });
});

// The candidate set an accept decides among — and so exactly the set it dismisses the rest of.
describe("readyUndecidedTakes", () => {
  const ADDR = "animatic:shot.02.frame";

  function pool(): KonteState {
    return makeState({
      [ADDR]: {
        variants: {
          "v-accepted": variant({ status: "accepted", file: "a.png", definitionHash: "d1" }),
          "v-open": variant({ file: "b.png", definitionHash: "d1" }),
          "v-settled": variant({ status: "dismissed", file: "c.png", definitionHash: "d1" }),
          "v-nofile": variant({ definitionHash: "d1" }),
        },
      },
    });
  }

  it("lists the undecided takes holding a file, and nothing else", () => {
    expect(readyUndecidedTakes(pool(), ADDR, "d1")).toEqual(["v-open"]);
  });

  it("drops a take the current definition has aged out", () => {
    expect(readyUndecidedTakes(pool(), ADDR, "d2")).toEqual([]);
  });

  // A correction whose script was edited is work to re-apply, so an accept elsewhere at the
  // address must not decide it. The patch axis only reads with the hashes in hand.
  it("drops a patch output whose script has since changed", () => {
    const state = pool();
    state.assets[ADDR]!.variants!["v-open"] = variant({
      file: "b.png",
      definitionHash: "d1",
      derivedFrom: "v-accepted",
      patchHash: "p1",
    });
    expect(readyUndecidedTakes(state, ADDR, "d1")).toEqual(["v-open"]);
    expect(
      readyUndecidedTakes(state, ADDR, "d1", undefined, new Map([["v-accepted", "p2"]])),
    ).toEqual([]);
  });

  it("drops a take that has itself been patched", () => {
    const state = pool();
    state.assets[ADDR]!.variants!["v-fix"] = variant({
      file: "fix.png",
      definitionHash: "d1",
      derivedFrom: "v-open",
    });
    expect(readyUndecidedTakes(state, ADDR, "d1")).toEqual(["v-fix"]);
  });
});

describe("undecidedTakeBesideAccepted", () => {
  function frameWithReroll(): KonteState {
    return makeState({
      "animatic:shot.02.frame": {
        variants: {
          "v-old": variant({
            status: "accepted",
            file: "old.png",
            readyAt: "2026-01-01T00:00:01.000Z",
            decidedAt: "2026-01-01T00:00:01.000Z",
          }),
          "v-new": variant({
            status: "none",
            file: "new.png",
            readyAt: "2026-01-01T00:00:02.000Z",
          }),
        },
      },
    });
  }

  it("returns the ready sibling awaiting a verdict", () => {
    expect(undecidedTakeBesideAccepted(frameWithReroll(), "animatic:shot.02.frame")).toBe("v-new");
  });

  it("returns null when nothing is accepted", () => {
    const state = makeState({
      "animatic:shot.02.frame": {
        variants: { "v-a": variant({ file: "a.png", readyAt: "2026-01-01T00:00:02.000Z" }) },
      },
    });
    expect(undecidedTakeBesideAccepted(state, "animatic:shot.02.frame")).toBeNull();
  });

  // A patched take is a "before", not a rival of the correction that replaced it.
  it("skips a sibling that has since been patched, offering its correction instead", () => {
    const state = frameWithReroll();
    state.assets["animatic:shot.02.frame"]!.variants!["v-fix"] = variant({
      file: "fix.png",
      derivedFrom: "v-new",
      readyAt: "2026-01-01T00:00:03.000Z",
    });
    expect(undecidedTakeBesideAccepted(state, "animatic:shot.02.frame")).toBe("v-fix");
  });

  // A correction of the ACCEPTED take is a candidate like any other: its verdict is carried by
  // its own status, so it needs no lineage exclusion to stay apart from "not looked at yet".
  it("offers a correction of the accepted variant itself", () => {
    const state = frameWithReroll();
    delete state.assets["animatic:shot.02.frame"]!.variants!["v-new"];
    state.assets["animatic:shot.02.frame"]!.variants!["v-fix"] = variant({
      file: "fix.png",
      derivedFrom: "v-old",
      readyAt: "2026-01-01T00:00:03.000Z",
    });
    expect(undecidedTakeBesideAccepted(state, "animatic:shot.02.frame")).toBe("v-fix");
  });

  it("returns null once the sibling was dismissed", () => {
    const state = frameWithReroll();
    state.assets["animatic:shot.02.frame"]!.variants!["v-new"]!.status = "dismissed";
    expect(undecidedTakeBesideAccepted(state, "animatic:shot.02.frame")).toBeNull();
  });

  // Nothing compares when a take landed against when the accept was made.
  it("offers a ready sibling that landed before the accept", () => {
    const state = frameWithReroll();
    state.assets["animatic:shot.02.frame"]!.variants!["v-new"]!.readyAt =
      "2026-01-01T00:00:00.000Z";
    expect(undecidedTakeBesideAccepted(state, "animatic:shot.02.frame")).toBe("v-new");
  });

  it("ignores a newer sibling excluded by id (e.g. a dead composition leftover)", () => {
    expect(
      undecidedTakeBesideAccepted(
        frameWithReroll(),
        "animatic:shot.02.frame",
        null,
        new Set(["v-new"]),
      ),
    ).toBeNull();
  });
});

describe("collectUndecidedUpstreamTakes", () => {
  // The WORK.md scenario: an animatic frame was rerolled (new take unreviewed) while the
  // old take stays accepted; a video motion depends on it, so this run resolves the old one.
  it("flags an upstream frame with a newer unreviewed take for a cross-stage video dep", () => {
    const state = makeState({
      "animatic:shot.02.frame": {
        variants: {
          "v-old": variant({
            status: "accepted",
            file: "old.png",
            readyAt: "2026-01-01T00:00:01.000Z",
            decidedAt: "2026-01-01T00:00:01.000Z",
          }),
          "v-new": variant({
            status: "none",
            file: "new.png",
            readyAt: "2026-01-01T00:00:02.000Z",
          }),
        },
      },
    });
    expect(collectUndecidedUpstreamTakes(state, ["animatic:shot.02.frame"])).toEqual([
      {
        depPath: "animatic:shot.02.frame",
        address: "animatic:shot.02.frame",
        acceptedVariantId: "v-old",
        undecidedVariantId: "v-new",
      },
    ]);
  });

  it("is empty when the accepted upstream take is already the newest", () => {
    const state = makeState({
      "animatic:shot.02.frame": {
        variants: {
          "v-old": variant({
            status: "accepted",
            file: "old.png",
            readyAt: "2026-01-01T00:00:02.000Z",
            decidedAt: "2026-01-01T00:00:02.000Z",
          }),
        },
      },
    });
    expect(collectUndecidedUpstreamTakes(state, ["animatic:shot.02.frame"])).toEqual([]);
  });
});

describe("staleness memoization", () => {
  // A cross-shot chain: every shot's takes fingerprint the previous shot's address and nothing
  // is accepted, so resolving the last shot walks the whole chain. Each level scans a stale take
  // (newest) and then a fresh one, both recursing — exponential without the per-call memo.
  // Completing at all is the assertion.
  it("terminates on a long unaccepted dependency chain", () => {
    const assets: KonteState["assets"] = {};
    const N = 120;
    const addrOf = (i: number) => `video:shot.${i}.motion`;
    // The chain anchor has a single fresh take; every later level pairs a stale newest take
    // (checked first, recursing) with the fresh one behind it (recursing again).
    assets[addrOf(0)] = {
      variants: {
        "v-0-fresh": variant({
          file: "fresh.mp4",
          outputHash: "h0",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      },
    };
    for (let i = 1; i < N; i++) {
      assets[addrOf(i)] = {
        variants: {
          [`v-${i}-fresh`]: variant({
            file: "fresh.mp4",
            outputHash: `h${i}`,
            createdAt: "2026-01-01T00:00:01.000Z",
            inputFingerprints: { [addrOf(i - 1)]: `h${i - 1}` },
          }),
          [`v-${i}-stale`]: variant({
            file: "stale.mp4",
            outputHash: `x${i}`,
            createdAt: "2026-01-01T00:00:02.000Z",
            inputFingerprints: { [addrOf(i - 1)]: "old" },
          }),
        },
      };
    }
    const state = makeState(assets);
    const last = addrOf(N - 1);
    expect(selectResolvedVariant(state, last)).toEqual({
      variantId: `v-${N - 1}-fresh`,
      isAccepted: false,
    });
    expect(resolvedStaleness(state, last, null)).toMatchObject({ inputStale: false });
  });

  // Cyclic fingerprints (recorded under older definitions) make inner resolutions
  // path-dependent; those must not be served from a shared cache. Every cached answer has to
  // match the answer a fresh computation gives, whichever address is queried first.
  it("gives the same answers through a shared cache in a cyclic state", () => {
    const A = "animatic:shot.01.first";
    const B = "animatic:shot.02.first";
    const cyclic = () =>
      makeState({
        [A]: {
          variants: {
            "v-a": variant({
              file: "a.png",
              outputHash: "ha",
              inputFingerprints: { [B]: "hb-old" },
            }),
          },
        },
        [B]: {
          variants: {
            "v-b": variant({
              file: "b.png",
              outputHash: "hb",
              inputFingerprints: { [A]: "ha-old" },
            }),
          },
        },
      });

    for (const order of [
      [A, B],
      [B, A],
    ]) {
      const state = cyclic();
      const cache = createStalenessCache();
      for (const addr of order) {
        expect(selectResolvedVariant(state, addr, undefined, cache)).toEqual(
          selectResolvedVariant(state, addr),
        );
        expect(selectResolvedVariant(state, addr, { includeStale: true }, cache)).toEqual(
          selectResolvedVariant(state, addr, { includeStale: true }),
        );
      }
    }
  });

  // An accepted upstream short-circuits resolution, so its core is cacheable; reusing the cache
  // across queries must keep agreeing with fresh computations.
  it("agrees with fresh computation when a cache is reused across queries", () => {
    const state = makeState({
      "video:shot.01.first": {
        variants: {
          "v-up": variant({ status: "accepted", file: "f.png", outputHash: "new" }),
        },
      },
      "video:shot.01.motion": {
        variants: {
          "v-m": variant({
            status: "accepted",
            file: "m.mp4",
            inputFingerprints: { "video:shot.01.first": "old" },
          }),
        },
      },
    });
    const cache = createStalenessCache();
    const v = state.assets["video:shot.01.motion"]!.variants!["v-m"]!;
    expect(isVariantStale(state, "video:shot.01.motion", v, null, undefined, cache)).toBe(true);
    expect(
      collectStaleVariants(state, "video:shot.01.motion", null, undefined, cache),
    ).toHaveLength(1);
    expect(resolvedStaleness(state, "video:shot.01.motion", null, undefined, cache)).toMatchObject({
      variantId: "v-m",
      inputStale: true,
    });
    expect(selectResolvedVariant(state, "video:shot.01.first", undefined, cache)).toEqual({
      variantId: "v-up",
      isAccepted: true,
    });
  });
});

describe("collectStaleDependents (composition / UC1)", () => {
  it("marks a shot's composition stale when an upstream asset's accepted output changes", () => {
    // audio's accepted output is now audio-2, but the composition was rendered
    // against audio-1 — so the composition is input-stale and must surface.
    const state = makeState({
      "video:shot.01.audio": {
        variants: {
          "v-audio": variant({ status: "accepted", file: "a.mp3", outputHash: "audio-2" }),
        },
      },
      "video:shot.01#composition": {
        variants: {
          "v-comp": variant({
            status: "accepted",
            file: "composition.html",
            inputFingerprints: { "video:shot.01.audio": "audio-1" },
          }),
        },
      },
    });
    const dependents = new Map<string, readonly string[]>([
      ["video:shot.01.audio", ["video:shot.01#composition"]],
    ]);

    expect(collectStaleDependents(state, "video:shot.01.audio", dependents)).toEqual([
      "video:shot.01#composition",
    ]);
  });

  it("does not mark the composition stale when the upstream output is unchanged", () => {
    const state = makeState({
      "video:shot.01.audio": {
        variants: {
          "v-audio": variant({ status: "accepted", file: "a.mp3", outputHash: "audio-1" }),
        },
      },
      "video:shot.01#composition": {
        variants: {
          "v-comp": variant({
            status: "accepted",
            file: "composition.html",
            inputFingerprints: { "video:shot.01.audio": "audio-1" },
          }),
        },
      },
    });
    const dependents = new Map<string, readonly string[]>([
      ["video:shot.01.audio", ["video:shot.01#composition"]],
    ]);

    expect(collectStaleDependents(state, "video:shot.01.audio", dependents)).toEqual([]);
  });

  it("propagates across stages to a video motion that builds on an animatic frame", () => {
    // animatic:shot.01.first is re-accepted to kf-2, but the video motion was generated
    // against kf-1 — the video goes input-stale.
    const state = makeState({
      "animatic:shot.01.first": {
        variants: { "v-kf": variant({ status: "accepted", file: "kf.png", outputHash: "kf-2" }) },
      },
      "video:shot.01.motion": {
        variants: {
          "v-d": variant({
            status: "accepted",
            file: "m.mp4",
            inputFingerprints: { "animatic:shot.01.first": "kf-1" },
          }),
        },
      },
    });
    const dependents = new Map<string, readonly string[]>([
      ["animatic:shot.01.first", ["video:shot.01.motion"]],
    ]);

    expect(collectStaleDependents(state, "animatic:shot.01.first", dependents)).toEqual([
      "video:shot.01.motion",
    ]);
  });
});

describe("resolution against the current definition", () => {
  const ADDR = "animatic:shot.08.first";

  // Two takes at one address, made under different definitions. `CURRENT` is what the definition
  // says now: the older take's, the edit behind the newer one having been reverted.
  function stateWithTwoTakes(overrides: Partial<VariantState> = {}): KonteState {
    return makeState({
      [ADDR]: {
        variants: {
          "v-old": variant({
            file: "old.png",
            outputHash: "old",
            definitionHash: "CURRENT",
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
          "v-new": variant({
            file: "new.png",
            outputHash: "new",
            definitionHash: "EDITED",
            createdAt: "2026-01-01T00:00:02.000Z",
            ...overrides,
          }),
        },
      },
    });
  }

  const definitions = {
    definitionHash: () => "CURRENT",
    isDeterministic: () => false,
  };

  it("resolves to the newest take when the walk is given no definitions", () => {
    // The state layer holds no definition hash of its own, so without one supplied the newest
    // take wins.
    expect(selectResolvedVariant(stateWithTwoTakes(), ADDR)?.variantId).toBe("v-new");
  });

  it("hands the address back to the older take whose definition still matches", () => {
    const resolved = selectResolvedVariant(
      stateWithTwoTakes(),
      ADDR,
      undefined,
      createStalenessCache(definitions),
    );
    expect(resolved).toEqual({ variantId: "v-old", isAccepted: false });
  });

  it("keeps an accepted take resolving even once its definition has moved", () => {
    // An accept is a decision to protect, on this axis as on the input one — the way back to the
    // matching take is a new accept.
    const resolved = selectResolvedVariant(
      stateWithTwoTakes({ status: "accepted" }),
      ADDR,
      undefined,
      createStalenessCache(definitions),
    );
    expect(resolved).toEqual({ variantId: "v-new", isAccepted: true });
  });

  it("offers the matching take as the no-spend way out of a stale one", () => {
    const state = stateWithTwoTakes({ status: "accepted" });
    expect(newestReadyUndecidedTake(state, ADDR, "CURRENT", new Set(["v-new"]))).toBe("v-old");
  });

  it("offers nothing when no take at the address matches the current definition", () => {
    const state = stateWithTwoTakes({ status: "accepted" });
    expect(newestReadyUndecidedTake(state, ADDR, "REWRITTEN", new Set(["v-new"]))).toBeNull();
  });

  it("never offers a take the reviewer decided against", () => {
    const state = stateWithTwoTakes({ status: "accepted" });
    state.assets[ADDR]!.variants!["v-old"]!.status = "dismissed";
    expect(newestReadyUndecidedTake(state, ADDR, "CURRENT", new Set(["v-new"]))).toBeNull();
  });
});

describe("keptInputs", () => {
  const upstream = (outputHash: string) => ({
    "animatic:shot.01.first": {
      variants: { "v-up": variant({ status: "accepted", file: "f.png", outputHash }) },
    },
  });
  const consumer = (status: VariantState["status"], keptInputs?: Record<string, string>) =>
    variant({
      status,
      file: "l.png",
      inputFingerprints: { "animatic:shot.01.first": "made" },
      ...(keptInputs ? { keptInputs } : {}),
    });

  it("reads an accepted take as current against the upstream it was kept against", () => {
    const state = makeState(upstream("newer"));
    const s = computeVariantStaleness(
      state,
      "animatic:shot.01.last",
      consumer("accepted", { "animatic:shot.01.first": "newer" }),
      null,
    );
    expect(s.inputStale).toBe(false);
  });

  it("reads an accepted kept take as current once the upstream is back to what it was made from", () => {
    const state = makeState(upstream("made"));
    const s = computeVariantStaleness(
      state,
      "animatic:shot.01.last",
      consumer("accepted", { "animatic:shot.01.first": "newer" }),
      null,
    );
    expect(s.inputStale).toBe(false);
  });

  it("reports a kept take stale once the upstream moves past the kept one", () => {
    const state = makeState(upstream("newest"));
    const s = computeVariantStaleness(
      state,
      "animatic:shot.01.last",
      consumer("accepted", { "animatic:shot.01.first": "newer" }),
      null,
    );
    expect(s.changedInputs).toEqual([
      { assetPath: "animatic:shot.01.first", recorded: "newer", current: "newest" },
    ]);
  });

  it("ignores the keep once the take is no longer accepted", () => {
    const state = makeState(upstream("newer"));
    const s = computeVariantStaleness(
      state,
      "animatic:shot.01.last",
      consumer("none", { "animatic:shot.01.first": "newer" }),
      null,
    );
    expect(s.inputStale).toBe(true);
  });
});

describe("keptInputs through a re-made intermediate", () => {
  // Board frame → a deterministic resize → the motion. The motion was kept against the frame's new
  // take before the resize was re-baked from it.
  const FRAME = "animatic:shot.01.first";
  const RESIZE = "animatic:shot.01.small";
  const state = (resizeMadeFrom: string) =>
    makeState({
      [FRAME]: {
        variants: { f2: variant({ status: "accepted", file: "f.png", outputHash: "frame-new" }) },
      },
      [RESIZE]: {
        variants: {
          r2: variant({
            status: "accepted",
            file: "r.png",
            outputHash: "resize-new",
            inputFingerprints: { [FRAME]: resizeMadeFrom },
          }),
        },
      },
    });
  const motion = variant({
    status: "accepted",
    file: "m.mp4",
    inputFingerprints: { [RESIZE]: "resize-old" },
    keptInputs: { [RESIZE]: keptViaMarker({ [FRAME]: "frame-new" }) },
  });

  it("reads current once the intermediate is re-made from the kept upstream take", () => {
    expect(
      computeVariantStaleness(state("frame-new"), "video:shot.01.motion", motion, null).inputStale,
    ).toBe(false);
  });

  it("reads stale when the intermediate was made from another upstream take", () => {
    expect(
      computeVariantStaleness(state("frame-other"), "video:shot.01.motion", motion, null)
        .inputStale,
    ).toBe(true);
  });
});
