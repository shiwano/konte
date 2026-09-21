import { describe, expect, it } from "vitest";
import { type PatchCatalog, findPendingPatches, patchHashesOf } from "../patch.js";
import type { AssetDefinition, KonteState, VariantState } from "../types/index.js";

const ADDR = "animatic:shot.01.first";
const SOURCE = "v-src";

function variant(overrides: Partial<VariantState> = {}): VariantState {
  return {
    status: "none",
    file: null,
    definitionHash: "def1",
    outputHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    inputFingerprints: {},
    metadata: {},
    ...overrides,
  };
}

const ASSET_DEF: AssetDefinition = {
  kind: "local",
  operation: "resize",
  mediaType: "image",
  inputs: { image: `__konte:${ADDR}__`, width: 32, height: 32 },
};

function catalog(patchHash: string): PatchCatalog {
  return {
    patches: new Map([
      [
        SOURCE,
        {
          sourceVariantId: SOURCE,
          sourceAddress: ADDR,
          filePath: `/p/patches/${SOURCE}.ts`,
          assets: { patched: ASSET_DEF },
          outputName: "patched",
          patchHash,
        },
      ],
    ]),
    orphans: [],
    absent: [],
    errors: [],
  };
}

const STEP_ADDR = `animatic:patch.${SOURCE}.patched`;
const UPSTREAM = "animatic:shot.01.plate";

function stateWith(
  variants: Record<string, VariantState>,
  // The chain's own takes, at the step's address — where an apply in flight is visible.
  stepVariants: Record<string, VariantState> = {},
): KonteState {
  return {
    schemaVersion: 5,
    assets: { [ADDR]: { variants }, [STEP_ADDR]: { variants: stepVariants } },
  };
}

describe("findPendingPatches", () => {
  it("reports a script that has never produced anything", () => {
    const state = stateWith({ [SOURCE]: variant({ file: "src.png" }) });
    const pending = findPendingPatches(state, catalog("h1"));
    expect(pending.map((p) => p.sourceVariantId)).toEqual([SOURCE]);
    expect(pending[0]!.reason).toBe("never-applied");
  });

  it("reports nothing once a current output exists", () => {
    const state = stateWith({
      [SOURCE]: variant({ file: "src.png" }),
      "v-fix": variant({ file: "fix.png", derivedFrom: SOURCE, patchHash: "h1" }),
    });
    expect(findPendingPatches(state, catalog("h1"))).toEqual([]);
  });

  // "Never applied" and "applied, then the script was edited" are the same situation to
  // `generate`: the correction the file now describes does not exist yet.
  it("reports the patch again after the script is edited, keyed as script-changed", () => {
    const state = stateWith({
      [SOURCE]: variant({ file: "src.png" }),
      "v-fix": variant({ file: "fix.png", derivedFrom: SOURCE, patchHash: "h1" }),
    });
    const pending = findPendingPatches(state, catalog("h2"));
    expect(pending.map((p) => p.sourceVariantId)).toEqual([SOURCE]);
    expect(pending[0]!.reason).toBe("script-changed");
  });

  // The third way an output stops being current: the script is untouched and an input it consumed
  // moved. `status` names which, so nobody is sent to re-read a file that did not change.
  it("reports the patch again when an input it consumed moved, keyed as inputs-changed", () => {
    const state = stateWith(
      {
        [SOURCE]: variant({ file: "src.png" }),
        "v-fix": variant({
          file: "fix.png",
          derivedFrom: SOURCE,
          patchHash: "h1",
          inputFingerprints: { [STEP_ADDR]: "old" },
        }),
      },
      { "v-step": variant({ file: "step.png", status: "accepted", outputHash: "new" }) },
    );
    const pending = findPendingPatches(state, catalog("h1"));
    expect(pending.map((p) => p.reason)).toEqual(["inputs-changed"]);
  });

  // A correction inherits its source's fingerprints, so re-applying against a stale source yields
  // another take stale from birth — and `generate` would pay for one every run.
  it("leaves the patch alone when the staleness is the source's own", () => {
    const state = stateWith({
      [SOURCE]: variant({ file: "src.png", inputFingerprints: { [UPSTREAM]: "old" } }),
      "v-fix": variant({
        file: "fix.png",
        derivedFrom: SOURCE,
        patchHash: "h1",
        inputFingerprints: { [UPSTREAM]: "old" },
      }),
    });
    state.assets[UPSTREAM] = {
      variants: { "v-up": variant({ status: "accepted", file: "up.png", outputHash: "new" }) },
    };
    expect(findPendingPatches(state, catalog("h1"))).toEqual([]);
  });

  // The reason is read off the takes the CURRENT script produced — an older attempt from a
  // since-replaced script must not label a fresh one "script changed".
  it("keys the reason on the current script's own output", () => {
    const state = stateWith({
      [SOURCE]: variant({ file: "src.png" }),
      "v-old": variant({ file: "old.png", derivedFrom: SOURCE, patchHash: "h1" }),
      "v-fix": variant({
        file: "fix.png",
        derivedFrom: SOURCE,
        patchHash: "h2",
        inputFingerprints: { [STEP_ADDR]: "old" },
      }),
    });
    state.assets[STEP_ADDR]!.variants = {
      "v-step": variant({ status: "accepted", file: "step.png", outputHash: "new" }),
    };
    const pending = findPendingPatches(state, catalog("h2"));
    expect(pending.map((p) => p.reason)).toEqual(["inputs-changed"]);
  });

  // A chain already in flight must not be re-submitted — that would double-spend. Seen at the
  // step's address: the patched variant is registered only once the chain lands, so until then
  // there is nothing at the source's address to see it by.
  it("does not re-apply while the chain is still generating", () => {
    const state = stateWith(
      { [SOURCE]: variant({ file: "src.png" }) },
      { "v-step": variant({ file: null }) },
    );
    expect(findPendingPatches(state, catalog("h1"))).toEqual([]);
    expect(findPendingPatches(state, catalog("h1"), new Set(["v-step"]))).toEqual([]);
  });

  // A job that completed but downloaded nothing leaves a fileless variant carrying NO terminal
  // marker, so the metadata heuristic cannot tell it from a live one. The job list can.
  it("re-reports the patch when a finished attempt produced no file", () => {
    const state = stateWith(
      { [SOURCE]: variant({ file: "src.png" }) },
      { "v-step": variant({ file: null }) },
    );
    expect(
      findPendingPatches(state, catalog("h1"), new Set()).map((p) => p.sourceVariantId),
    ).toEqual([SOURCE]);
  });

  // `error` and `cancelledAt` land on different metadata keys, so a cancelled attempt must be
  // recognized as terminal too — otherwise it would block its patch forever.
  it("re-reports the patch when its only attempt was cancelled", () => {
    const state = stateWith({
      [SOURCE]: variant({ file: "src.png" }),
      "v-fix": variant({
        file: null,
        derivedFrom: SOURCE,
        patchHash: "h1",
        metadata: { cancelledAt: "2026-01-02T00:00:00.000Z" },
      }),
    });
    expect(findPendingPatches(state, catalog("h1")).map((p) => p.sourceVariantId)).toEqual([
      SOURCE,
    ]);
  });

  it("re-reports the patch when its only attempt failed", () => {
    const state = stateWith({
      [SOURCE]: variant({ file: "src.png" }),
      "v-fix": variant({
        file: null,
        derivedFrom: SOURCE,
        patchHash: "h1",
        metadata: { error: "backend exploded" },
      }),
    });
    expect(findPendingPatches(state, catalog("h1")).map((p) => p.sourceVariantId)).toEqual([
      SOURCE,
    ]);
  });

  it("skips a source with no output file to feed the adapter", () => {
    const state = stateWith({ [SOURCE]: variant({ file: null }) });
    expect(findPendingPatches(state, catalog("h1"))).toEqual([]);
  });

  it("skips a source that is no longer in state", () => {
    expect(findPendingPatches(stateWith({}), catalog("h1"))).toEqual([]);
  });

  // An input-stale output is not a realized correction either — the take it built on has moved.
  it("reports the patch again when its output went input-stale", () => {
    const state: KonteState = {
      schemaVersion: 5,
      assets: {
        "reference:hero": {
          variants: { "v-hero": variant({ status: "accepted", file: "h.png", outputHash: "new" }) },
        },
        [ADDR]: {
          variants: {
            [SOURCE]: variant({ file: "src.png" }),
            "v-fix": variant({
              file: "fix.png",
              derivedFrom: SOURCE,
              patchHash: "h1",
              inputFingerprints: { "reference:hero": "old" },
            }),
          },
        },
      },
    };
    expect(findPendingPatches(state, catalog("h1")).map((p) => p.sourceVariantId)).toEqual([
      SOURCE,
    ]);
  });
});

describe("patchHashesOf", () => {
  it("keys the current hash by source variant id, which is how staleness looks it up", () => {
    expect(patchHashesOf(catalog("h9"))).toEqual(new Map([[SOURCE, "h9"]]));
  });
});
