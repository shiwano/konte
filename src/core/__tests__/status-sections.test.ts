import { describe, expect, it } from "vitest";
import {
  type AddressInfo,
  buildAddressInfo,
  computeExportReadiness,
  computeLastExports,
  computeStatusSections,
  detectOrphans,
} from "../status-sections.js";
import { JobIndex } from "../job-index.js";
import { selectResolvedVariant } from "../staleness.js";
import type { JobRecord, KonteState } from "../types/index.js";

function makeState(assets: KonteState["assets"]): KonteState {
  return { schemaVersion: 1, assets };
}

function makeJob(overrides: Partial<JobRecord> & { variantId: string }): JobRecord {
  return {
    kind: "generation",
    address: "video:shot.01.motion",
    status: "running",
    dependsOnAssets: [],
    dependsOnJobs: [],
    lease: null,
    backendKind: "fal",
    backendJobId: null,
    progress: null,
    error: null,
    outputFiles: [],
    metadata: {},
    provenance: { workflowHash: null, inputHash: null, resolvedDependencies: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  } as JobRecord;
}

function makeInfo(overrides: Partial<AddressInfo> & { address: string }): AddressInfo {
  return {
    assetKind: "fal",
    reviewTarget: true,
    reviewUnreachable: false,
    hasAccepted: false,
    hasOutputFile: false,
    undecidedTakeVariantId: null,
    patchedAwaitingReview: null,
    readyVariantIds: [],
    readyCount: 0,
    leafReadyForReview: false,
    generatingJobs: [],
    blockedJobs: [],
    failedJobs: [],
    staleVariants: [],
    staleUnacceptedVariants: [],
    staleAcceptStands: false,
    problemVariants: [],
    dismissedCount: 0,
    missingFilePath: null,
    ...overrides,
  };
}

describe("buildAddressInfo", () => {
  it("builds info for an address with variants and jobs", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-abc12345": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
          "v-def67890": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: null,
            definitionHash: null,
            metadata: { error: "generation failed" },
          },
        },
      },
    });
    const jobs = new Map<string, JobRecord>();

    const info = buildAddressInfo("video:shot.01.motion", state, jobs, "fal");
    expect(info.address).toBe("video:shot.01.motion");
    expect(info.assetKind).toBe("fal");
    expect(info.hasAccepted).toBe(false);
    expect(info.readyCount).toBe(1);
    // A no-file variant carrying an error marker is an accounted-for failure,
    // not a "problem" needing cleanup.
    expect(info.problemVariants).toEqual([]);
  });

  describe("a patched accepted take", () => {
    const ADDR = "video:shot.01.motion";
    const base = {
      outputHash: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      inputFingerprints: {},
      metadata: {},
    };
    const patched = (fixPatchHash: string) =>
      makeState({
        [ADDR]: {
          variants: {
            "v-src": {
              ...base,
              status: "accepted" as const,
              file: "src.mp4",
              definitionHash: "d1",
            },
            "v-fix": {
              ...base,
              status: "none" as const,
              file: "fix.mp4",
              definitionHash: "d1",
              derivedFrom: "v-src",
              patchHash: fixPatchHash,
            },
          },
        },
      });

    it("reports the correction as awaiting review, and drops the source from the ready count", () => {
      const info = buildAddressInfo(ADDR, patched("h1"), new Map(), "fal", "d1");
      expect(info.patchedAwaitingReview).not.toBeNull();
      expect(info.readyCount).toBe(1);
    });

    // A correction is a rival like any other now, reported under its own wording. Only its own
    // verdict clears it, so "I decided against this patch" stays apart from "I have not looked".
    it("clears once the correction is dismissed", () => {
      const state = patched("h1");
      state.assets[ADDR]!.variants!["v-fix"]!.status = "dismissed";
      const info = buildAddressInfo(ADDR, state, new Map(), "fal", "d1");
      expect(info.patchedAwaitingReview).toBeNull();
      expect(info.undecidedTakeVariantId).toBeNull();
      expect(info.readyCount).toBe(0);
    });

    // A correction whose input moved is re-applied, not judged — and reporting it would be
    // unclearable: an accept of the take beside it dismisses only non-stale rivals.
    it("does not report an output whose input has since moved", () => {
      const state = patched("h1");
      state.assets[ADDR]!.variants!["v-fix"]!.inputFingerprints = { "reference:bgm": "old" };
      state.assets["reference:bgm"] = {
        variants: {
          "v-bgm": {
            ...base,
            status: "accepted" as const,
            file: "bgm.mp3",
            definitionHash: "d1",
            outputHash: "new",
          },
        },
      };
      const info = buildAddressInfo(ADDR, state, new Map(), "fal", "d1");
      expect(info.patchedAwaitingReview).toBeNull();
    });

    // With the script hand-deleted, "Pending patches" cannot see the take at all, so dropping it
    // here too would leave it in no section — invisible work with a file on disk.
    it("keeps a stale output whose patch script is gone, routed to prune", () => {
      const state = patched("h1");
      state.assets[ADDR]!.variants!["v-fix"]!.inputFingerprints = { "reference:bgm": "old" };
      state.assets["reference:bgm"] = {
        variants: {
          "v-bgm": {
            ...base,
            status: "accepted" as const,
            file: "bgm.mp3",
            definitionHash: "d1",
            outputHash: "new",
          },
        },
      };
      const info = buildAddressInfo(
        ADDR,
        state,
        new Map(),
        "fal",
        "d1",
        new JobIndex(),
        false,
        new Set(),
        false,
        null,
        new Map(),
      );
      expect(info.patchedAwaitingReview).toEqual({
        variantId: "v-fix",
        sourceVariantId: "v-src",
        hasScript: false,
      });
      const items = computeStatusSections([info]).find((s) => s.title === "Needs review")?.items;
      expect(items?.[0]?.detail).toContain("konte prune");
    });

    // An output built by a since-edited script is work to redo, not work to review — it belongs
    // to "Pending patches" alone.
    it("does not report an output whose patch script has since changed", () => {
      const info = buildAddressInfo(
        ADDR,
        patched("h1"),
        new Map(),
        "fal",
        "d1",
        new JobIndex(),
        false,
        new Set(),
        false,
        null,
        new Map([["v-src", "h2"]]),
      );
      expect(info.patchedAwaitingReview).toBeNull();
    });
  });

  it("detects accepted variant", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-abc12345": {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal");
    expect(info.hasAccepted).toBe(true);
  });

  // A parallel reroll can land its file after a later-reserved take was already written, so
  // readyAt and createdAt disagree. Resolution goes by createdAt, and anything that SHOWS the
  // outstanding take (the needs-review contact sheet) must land on the same one — else a reviewer
  // judges one picture and the accept protects another.
  it("orders ready takes the way canonical resolution does, not by when the file landed", () => {
    const base = { outputHash: null, inputFingerprints: {}, definitionHash: null, metadata: {} };
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-reserved-first": {
            ...base,
            status: "none",
            file: "a.mp4",
            createdAt: "2026-01-01T00:00:00.000Z",
            readyAt: "2026-01-01T09:00:00.000Z",
          },
          "v-reserved-second": {
            ...base,
            status: "none",
            file: "b.mp4",
            createdAt: "2026-01-02T00:00:00.000Z",
            readyAt: "2026-01-01T01:00:00.000Z",
          },
        },
      },
    });
    const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal");
    expect(info.readyVariantIds[0]).toBe(
      selectResolvedVariant(state, "video:shot.01.motion")?.variantId,
    );
    expect(info.readyVariantIds[0]).toBe("v-reserved-second");
  });

  it("flags a newer non-stale ready variant beside an accepted one", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-old00001": {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "old.mp4",
            definitionHash: null,
            metadata: {},
          },
          "v-new00002": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-02T00:00:00.000Z",
            inputFingerprints: {},
            file: "new.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal");
    expect(info.undecidedTakeVariantId).not.toBeNull();
  });

  it("does not flag a newer variant that is itself definition-stale", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-old00001": {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "old.mp4",
            definitionHash: "current-definition",
            metadata: {},
          },
          "v-new00002": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-02T00:00:00.000Z",
            inputFingerprints: {},
            file: "new.mp4",
            definitionHash: "old-definition",
            metadata: {},
          },
        },
      },
    });
    const info = buildAddressInfo(
      "video:shot.01.motion",
      state,
      new Map(),
      "fal",
      "current-definition",
    );
    expect(info.undecidedTakeVariantId).toBeNull();
  });

  it("stops reporting a rival take once it was dismissed", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-old00001": {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            readyAt: "2026-01-01T00:00:00.000Z",
            decidedAt: "2026-01-03T00:00:00.000Z",
            inputFingerprints: {},
            file: "old.mp4",
            definitionHash: null,
            metadata: {},
          },
          // The human saw the reroll and kept the old take.
          "v-new00002": {
            status: "dismissed",
            outputHash: null,
            createdAt: "2026-01-02T00:00:00.000Z",
            readyAt: "2026-01-02T00:00:00.000Z",
            inputFingerprints: {},
            file: "new.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal");
    expect(info.undecidedTakeVariantId).toBeNull();
  });

  it("detects generating jobs", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-abc12345": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: null,
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const jobs = new Map<string, JobRecord>([
      ["v-abc12345", makeJob({ variantId: "v-abc12345", status: "running", progress: 45 })],
    ]);

    const info = buildAddressInfo("video:shot.01.motion", state, jobs, "fal");
    expect(info.generatingJobs).toEqual([
      { variantId: "v-abc12345", status: "running", progress: 45 },
    ]);
  });

  it("detects blocked (pending) jobs", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-abc12345": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: null,
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const jobs = new Map<string, JobRecord>([
      [
        "v-abc12345",
        makeJob({
          variantId: "v-abc12345",
          status: "pending",
          dependsOnAssets: ["animatic:shot.01.first"],
        }),
      ],
    ]);

    const info = buildAddressInfo("video:shot.01.motion", state, jobs, "fal");
    // waitingOn now lists the resolved, still-unsatisfied dependency address
    // (the animatic panel has no file), consistent with `generate`'s output.
    expect(info.blockedJobs).toEqual([
      { variantId: "v-abc12345", waitingOn: ["animatic:shot.01.first"] },
    ]);
  });

  it("detects problem variants (no file, no active job)", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-abc12345": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: null,
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal");
    expect(info.problemVariants).toEqual(["v-abc12345"]);
  });

  it("routes a failed job to failedJobs, not problemVariants", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-abc12345": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: null,
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const jobs = new Map<string, JobRecord>([
      ["v-abc12345", makeJob({ variantId: "v-abc12345", status: "failed", error: "boom" })],
    ]);

    const info = buildAddressInfo("video:shot.01.motion", state, jobs, "fal");
    expect(info.failedJobs).toEqual([{ variantId: "v-abc12345", error: "boom" }]);
    expect(info.problemVariants).toEqual([]);
  });

  it("detects stale variants only for accepted status", () => {
    const state = makeState({
      "video:shot.01.bg": {
        variants: {
          "v-upstream1": {
            status: "accepted",
            outputHash: "current-hash",
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "bg.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
      "video:shot.01.motion": {
        variants: {
          "v-acc00000": {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: { "video:shot.01.bg": "old-hash" },
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
          "v-none0000": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: { "video:shot.01.bg": "old-hash" },
            file: "other.mp4",
            definitionHash: null,
            metadata: {},
          },
          "v-none1111": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: { "video:shot.01.bg": "old-hash" },
            file: "old.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal");
    expect(info.staleVariants).toHaveLength(1);
    expect(info.staleVariants[0]!.variantId).toBe("v-acc00000");
    expect(info.staleVariants[0]!.inputStale).toBe(true);
    // The unaccepted two land on the other axis instead of vanishing between the two.
    expect(info.staleUnacceptedVariants.map((v) => v.variantId).sort()).toEqual([
      "v-none0000",
      "v-none1111",
    ]);
  });

  it("reports changed inputs for an input-stale accepted variant", () => {
    const state = makeState({
      "video:shot.01.bg": {
        variants: {
          "v-upstream1": {
            status: "accepted",
            outputHash: "current-hash",
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "bg.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
      "video:shot.01.motion": {
        variants: {
          "v-acc00000": {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: { "video:shot.01.bg": "old-hash" },
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal");
    expect(info.staleVariants).toHaveLength(1);
    expect(info.staleVariants[0]!.changedInputs).toEqual([
      { assetPath: "video:shot.01.bg", recorded: "old-hash", current: "current-hash" },
    ]);
  });

  it("handles missing target gracefully", () => {
    const state = makeState({});
    const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal");
    expect(info.hasAccepted).toBe(false);
    expect(info.readyCount).toBe(0);
  });

  it("does not count a dead composition leftover variant as ready", () => {
    const state = makeState({
      "video:shot.03#composition": {
        variants: {
          "v-ghost123": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            // A leftover materialized under an earlier definition (empty fingerprints, so
            // never input-stale); its current upstream (motion) was never generated.
            inputFingerprints: {},
            file: "composition.mp4",
            definitionHash: "old-hash",
            metadata: {},
          },
        },
      },
    });

    const build = (
      deadVariantIds: Set<string>,
      leafReadyForReview = false,
      definitionHash = "old-hash",
    ) =>
      buildAddressInfo(
        "video:shot.03#composition",
        state,
        new Map(),
        "composition",
        definitionHash,
        new JobIndex(),
        false,
        deadVariantIds,
        leafReadyForReview,
      );

    const dead = build(new Set(["v-ghost123"]));
    expect(dead.readyCount).toBe(0);
    expect(computeStatusSections([dead])).toEqual([]);

    // Not dead, and matching the live definition: a real take.
    expect(build(new Set()).readyCount).toBe(1);

    // Not dead, but materialized under an earlier definition — `generate` replaces exactly this,
    // so it is not a take to review either.
    expect(build(new Set(), false, "live-hash").readyCount).toBe(0);

    // A composition is materialized only on accept, so its first-review need is the live
    // leafReadyForReview signal (renderable, refs resolvable), not a ready variant.
    const reviewable = build(new Set(), true);
    expect(computeStatusSections([reviewable])[0]?.title).toBe("Needs review");
  });
});

describe("computeStatusSections", () => {
  it("returns empty array when all assets are accepted", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        hasAccepted: true,
        readyCount: 1,
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections).toEqual([]);
  });

  it("includes Needs review for generation assets with ready variants and no accepted", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        readyCount: 2,
        hasAccepted: false,
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Needs review");
    expect(sections[0]!.items).toEqual([{ address: "video:shot.01.motion", detail: "" }]);
  });

  // A reference intermediate (declared, never returned) is on no review surface, so status must not
  // send anyone to review it — the asset that consumes it is what gets read.
  it("does not report a reference intermediate under Needs review", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "reference:latent",
        assetKind: "comfy",
        reviewTarget: false,
        readyCount: 1,
        hasAccepted: false,
      }),
    ];
    expect(computeStatusSections(infos)).toEqual([]);
  });

  it("surfaces an undecided take beside an accepted one under Needs review", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        hasAccepted: true,
        undecidedTakeVariantId: "v-undecided",
      }),
    ];
    const sections = computeStatusSections(infos);
    const review = sections.find((s) => s.title === "Needs review");
    expect(review?.items).toEqual([
      {
        address: "video:shot.01.motion",
        detail: "undecided take beside the accept",
        variantId: "v-undecided",
      },
    ]);
  });

  it("surfaces a correction of the accepted take as `patched`", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        hasAccepted: true,
        patchedAwaitingReview: { variantId: "v-patch", sourceVariantId: "v-src", hasScript: true },
      }),
    ];
    const review = computeStatusSections(infos).find((s) => s.title === "Needs review");
    expect(review?.items).toEqual([
      {
        address: "video:shot.01.motion",
        detail: "patched — accept it, or konte patch remove v-src to drop the fix",
        variantId: "v-patch",
      },
    ]);
  });

  // The reviewer's question differs ("did the fix land?" vs "is this alternative better?"), and the
  // reject route differs too (`patch remove`, which no other rival has), so it must not collapse
  // into the plain undecided-take wording.
  it("reports `patched` rather than the plain undecided wording when both signals are set", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        hasAccepted: true,
        undecidedTakeVariantId: "v-undecided",
        patchedAwaitingReview: { variantId: "v-patch", sourceVariantId: "v-src", hasScript: true },
      }),
    ];
    const review = computeStatusSections(infos).find((s) => s.title === "Needs review");
    expect(review?.items).toEqual([
      {
        address: "video:shot.01.motion",
        detail: "patched — accept it, or konte patch remove v-src to drop the fix",
        variantId: "v-patch",
      },
    ]);
  });

  it("does not surface a newer-ready composition under Needs review (its own section handles re-review)", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01#composition",
        assetKind: "composition",
        hasAccepted: true,
        undecidedTakeVariantId: "v-undecided",
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections.find((s) => s.title === "Needs review")).toBeUndefined();
  });

  it("surfaces a stale composition under 'Needs review', not 'Stale' — its refresh is a re-review", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01#composition",
        assetKind: "composition",
        hasAccepted: true,
        staleVariants: [
          {
            variantId: "v-comp1234",
            inputStale: true,
            definitionStale: false,
            patchStale: false,
            changedInputs: [
              { assetPath: "video:shot.01.audio", recorded: "audio-1", current: "audio-2" },
            ],
          },
        ],
      }),
    ];
    const sections = computeStatusSections(infos);
    const titles = sections.map((s) => s.title);
    expect(titles).toContain("Needs review");
    expect(titles).not.toContain("Stale");
    const review = sections.find((s) => s.title === "Needs review")!;
    expect(review.items[0]!.address).toBe("video:shot.01#composition");
    expect(review.items[0]!.detail).toBe(
      "accepted take is stale (input-stale: video:shot.01.audio)",
    );
  });

  it("surfaces a ready, unaccepted composition under Needs review but excludes it from export readiness", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01#composition",
        assetKind: "composition",
        // A leaf is materialized only on accept, so first-review need is the live signal, not a
        // ready variant.
        leafReadyForReview: true,
        hasAccepted: false,
      }),
    ];
    const sections = computeStatusSections(infos);
    const review = sections.find((s) => s.title === "Needs review");
    expect(review?.items[0]?.address).toBe("video:shot.01#composition");
    // A materialized-but-unaccepted composition is reviewable like any variant, yet still
    // does not count toward export readiness.
    expect(computeExportReadiness(infos)).toEqual([]);
  });

  it("labels a stem leaf under Needs review as an audio mix", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01#stem",
        assetKind: "stem",
        leafReadyForReview: true,
        hasAccepted: false,
      }),
    ];
    const review = computeStatusSections(infos).find((s) => s.title === "Needs review");
    expect(review?.items[0]).toEqual({
      address: "video:shot.01#stem",
      detail: "audio mix",
    });
  });

  it("excludes file assets from Needs review", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:timeline.bgm",
        assetKind: "file",
        readyCount: 1,
        hasAccepted: false,
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections).toEqual([]);
  });

  it("reports no section for in-flight jobs — nothing to act on; `konte job list` owns them", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.02.motion",
        generatingJobs: [{ variantId: "v-Xk8mP2qR", status: "running", progress: 45 }],
      }),
      makeInfo({
        address: "video:shot.04.motion",
        blockedJobs: [{ variantId: "v-Mn9pR4tU", waitingOn: ["animatic:shot.04.first"] }],
      }),
    ];
    expect(computeStatusSections(infos)).toEqual([]);
  });

  it("includes Stale section for input-stale variants", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.subtitle",
        staleVariants: [
          {
            variantId: "v-Pk2sT8vW",
            inputStale: true,
            definitionStale: false,
            patchStale: false,
            changedInputs: [{ assetPath: "video:shot.01.motion", recorded: "old", current: "new" }],
          },
        ],
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Stale");
    // The section title already says "stale" — only the cause is news here.
    expect(sections[0]!.items[0]!.detail).toBe("input-stale: video:shot.01.motion");
  });

  // The blind spot this section closes: an unaccepted take whose input moved counts as neither a
  // review candidate (nobody should judge a picture generate is about to discard) nor a stale
  // ACCEPT.
  describe("an address holding only stale unaccepted takes", () => {
    const staleTake = () => ({
      variantId: "v-T7gCDJht",
      inputStale: true,
      definitionStale: false,
      patchStale: false,
      changedInputs: [{ assetPath: "animatic:shot.01.first", recorded: "old", current: "new" }],
    });

    it("is reported under 'Needs regenerate' with what moved", () => {
      const sections = computeStatusSections([
        makeInfo({
          address: "video:shot.01.motion",
          hasOutputFile: true,
          staleUnacceptedVariants: [staleTake()],
        }),
      ]);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.title).toBe("Needs regenerate");
      expect(sections[0]!.items[0]).toEqual({
        address: "video:shot.01.motion",
        detail: "input-stale: animatic:shot.01.first",
      });
    });

    it("names the newest take when several have gone stale", () => {
      const sections = computeStatusSections([
        makeInfo({
          address: "video:shot.01.motion",
          hasOutputFile: true,
          staleUnacceptedVariants: [
            { ...staleTake(), variantId: "v-newest" },
            {
              variantId: "v-older",
              inputStale: false,
              definitionStale: true,
              patchStale: false,
              changedInputs: [],
            },
          ],
        }),
      ]);
      expect(sections[0]!.items).toHaveLength(1);
      expect(sections[0]!.items[0]!.detail).toBe("input-stale: animatic:shot.01.first");
    });

    // An edited definition puts the take here, not in "Needs review": `generate` replaces it, so
    // reviewing it would judge a picture the next run discards — and an accept made there would
    // then protect it from being replaced at all.
    it("claims a take whose definition changed, rather than sending it to review", () => {
      const sections = computeStatusSections([
        makeInfo({
          address: "video:shot.22.motion",
          hasOutputFile: true,
          staleUnacceptedVariants: [
            {
              variantId: "v-old",
              inputStale: false,
              definitionStale: true,
              patchStale: false,
              changedInputs: [],
            },
          ],
        }),
      ]);
      expect(sections.map((s) => s.title)).toEqual(["Needs regenerate"]);
      expect(sections[0]!.items[0]!.detail).toBe("definition-stale");
    });

    // A dismissed take is settled work whatever its staleness, so the reason reported is the
    // decision.
    it("reports a dismissed take as dismissed even once it is stale", () => {
      const state = makeState({
        "video:shot.01.motion": {
          variants: {
            "v-gone0001": {
              status: "dismissed",
              outputHash: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              inputFingerprints: {},
              file: "gone.mp4",
              definitionHash: "an-older-definition",
              metadata: {},
            },
          },
        },
      });
      const info = buildAddressInfo("video:shot.01.motion", state, new Map(), "fal", "live-hash");
      expect(info.staleUnacceptedVariants).toEqual([]);
      expect(info.dismissedCount).toBe(1);
      const sections = computeStatusSections([info]);
      expect(sections.find((s) => s.title === "Needs regenerate")?.items[0]?.detail).toContain(
        "dismissed",
      );
    });

    // Dismissing every take says the same thing as never generating one: there is nothing here to
    // review and nothing to consume, so the next generate must act.
    it("is reported when every take was dismissed instead of stale", () => {
      const sections = computeStatusSections([
        makeInfo({ address: "video:shot.01.motion", hasOutputFile: true, dismissedCount: 2 }),
      ]);
      expect(sections.map((s) => s.title)).toContain("Needs regenerate");
    });

    it("stays out of it while a reviewable take remains", () => {
      const sections = computeStatusSections([
        makeInfo({
          address: "video:shot.01.motion",
          hasOutputFile: true,
          readyCount: 1,
          staleUnacceptedVariants: [staleTake()],
        }),
      ]);
      expect(sections.map((s) => s.title)).not.toContain("Needs regenerate");
    });

    it("stays out of it once something is accepted", () => {
      const sections = computeStatusSections([
        makeInfo({
          address: "video:shot.01.motion",
          hasAccepted: true,
          hasOutputFile: true,
          staleUnacceptedVariants: [staleTake()],
        }),
      ]);
      expect(sections.map((s) => s.title)).not.toContain("Needs regenerate");
    });

    it("stays out of it while a job is already replacing it", () => {
      const sections = computeStatusSections([
        makeInfo({
          address: "video:shot.01.motion",
          hasOutputFile: true,
          staleUnacceptedVariants: [staleTake()],
          generatingJobs: [{ variantId: "v-run", status: "running", progress: 10 }],
        }),
      ]);
      expect(sections.map((s) => s.title)).not.toContain("Needs regenerate");
    });

    it("puts it in the stage's readiness work list so Next steps offers a generate", () => {
      const [readiness] = computeExportReadiness([
        makeInfo({
          address: "video:shot.01.motion",
          hasOutputFile: true,
          staleUnacceptedVariants: [staleTake()],
        }),
      ]);
      expect(readiness!.needsRegenerate).toEqual(["shot.01.motion"]);
      // It has an output, so it is generated — just not usable any more.
      expect(readiness!.generated).toBe(1);
      expect(readiness!.notGenerated).toEqual([]);
    });
  });

  it("formats definition-stale reason", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        staleVariants: [
          {
            variantId: "v-abc12345",
            inputStale: false,
            definitionStale: true,
            patchStale: false,
            changedInputs: [],
          },
        ],
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections[0]!.items[0]!.detail).toBe("definition-stale");
  });

  it("surfaces a declared file that is not on disk under Problems, named by its path", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.07.bgplate",
        assetKind: "file",
        hasAccepted: false,
        missingFilePath: "assets/plates/shot07.png",
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Problems");
    // The path, not the address: putting media there is the entire fix.
    expect(sections[0]!.items[0]).toEqual({
      address: "video:shot.07.bgplate",
      detail: "file not found: assets/plates/shot07.png",
    });
  });

  it("leaves a present file asset out of Problems", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "video:shot.07.bgplate", assetKind: "file", hasAccepted: true }),
    ];
    expect(computeStatusSections(infos)).toEqual([]);
  });

  it("includes Problems section", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.05.motion",
        problemVariants: ["v-Yz6uX1aB"],
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Problems");
    expect(sections[0]!.items[0]!.detail).toBe("v-Yz6uX1aB no file, no active job");
  });

  it("surfaces a failed job under Problems, distinct from a never-started variant", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.05.motion",
        failedJobs: [{ variantId: "v-Fa1l0001", error: "FAL_ERROR: upstream 500" }],
      }),
    ];
    const sections = computeStatusSections(infos);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Problems");
    expect(sections[0]!.items[0]!.detail).toBe(
      "v-Fa1l0001 generation job failed: FAL_ERROR: upstream 500",
    );
  });

  it("drops a superseded failed job when the address has an accepted variant", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:timeline.bgm",
        hasAccepted: true,
        failedJobs: [{ variantId: "v-Fa1l0001", error: "generation job failed" }],
      }),
    ];
    expect(computeStatusSections(infos)).toHaveLength(0);
  });

  it("drops a superseded no-file variant when the address has a ready variant", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:timeline.bgm",
        readyCount: 1,
        hasAccepted: false,
        problemVariants: ["v-Yz6uX1aB"],
      }),
    ];
    const titles = computeStatusSections(infos).map((s) => s.title);
    expect(titles).not.toContain("Problems");
  });

  it("peeks at a long error and caps the width", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.05.motion",
        failedJobs: [{ variantId: "v-Fa1l0001", error: `boom ${"x".repeat(200)}` }],
      }),
    ];
    const detail = computeStatusSections(infos)[0]!.items[0]!.detail;
    expect(detail.startsWith("v-Fa1l0001 generation job failed: boom xxxx")).toBe(true);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("surfaces a failed model-download job in Problems by its filename", () => {
    const sections = computeStatusSections([], undefined, [
      { jobId: "model-wan21", label: "wan2.1_t2v_14B.safetensors", error: "HTTP 403 Forbidden" },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Problems");
    expect(sections[0]!.items[0]).toEqual({
      address: "wan2.1_t2v_14B.safetensors",
      detail: "model download job failed: HTTP 403 Forbidden",
    });
  });

  it("formats a failed job with no error message", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.05.motion",
        failedJobs: [{ variantId: "v-Fa1l0001", error: null }],
      }),
    ];
    expect(computeStatusSections(infos)[0]!.items[0]!.detail).toBe(
      "v-Fa1l0001 generation job failed",
    );
  });

  it("allows an asset to appear in multiple sections", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        readyCount: 1,
        hasAccepted: false,
        staleVariants: [
          {
            variantId: "v-stale001",
            inputStale: true,
            definitionStale: false,
            patchStale: false,
            changedInputs: [],
          },
        ],
      }),
    ];
    const sections = computeStatusSections(infos);
    const titles = sections.map((s) => s.title);
    expect(titles).toContain("Needs review");
    expect(titles).toContain("Stale");
  });

  it("omits empty sections", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        hasAccepted: true,
        readyCount: 1,
      }),
    ];
    const sections = computeStatusSections(infos);
    for (const section of sections) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it("orders sections: Needs review, Problems, Stale", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        readyCount: 1,
        hasAccepted: false,
        generatingJobs: [{ variantId: "v-gen00001", status: "running", progress: null }],
        blockedJobs: [{ variantId: "v-blk00001", waitingOn: [] }],
        staleVariants: [
          {
            variantId: "v-stl00001",
            inputStale: true,
            definitionStale: false,
            patchStale: false,
            changedInputs: [],
          },
        ],
      }),
      makeInfo({
        address: "video:shot.02.motion",
        assetKind: "fal",
        problemVariants: ["v-prb00001"],
      }),
    ];
    const sections = computeStatusSections(infos);
    const titles = sections.map((s) => s.title);
    expect(titles).toEqual(["Needs review", "Problems", "Stale"]);
  });
});

describe("computeExportReadiness", () => {
  it("counts an in-flight asset as in flight, never as `notGenerated`", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        generatingJobs: [{ variantId: "v-gen00001", status: "running", progress: 10 }],
      }),
      makeInfo({
        address: "video:shot.02.motion",
        assetKind: "fal",
        blockedJobs: [{ variantId: "v-blk00001", waitingOn: ["animatic:shot.02.first"] }],
      }),
      makeInfo({ address: "video:shot.03.motion", assetKind: "fal" }),
    ];
    const readiness = computeExportReadiness(infos);
    // Only shot.03 has no job at all — it alone is what a `generate` would act on. Listing the two
    // in-flight ones as "not generated" would invite a redundant generate.
    expect(readiness[0]!.inFlight).toBe(2);
    expect(readiness[0]!.notGenerated).toEqual(["shot.03.motion"]);
    expect(readiness[0]!.generated).toBe(0);
  });

  // Nobody accepts an intermediate and nobody generates one on its own — `generate` reaches it
  // through the asset that consumes it, so neither ratio may move for it.
  it("keeps an intermediate out of both the accept and the generation count", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "reference:key",
        assetKind: "comfy",
        hasAccepted: true,
        hasOutputFile: true,
      }),
      makeInfo({ address: "reference:latent", assetKind: "comfy", reviewTarget: false }),
      makeInfo({
        address: "animatic:plate.master",
        assetKind: "comfy",
        reviewTarget: false,
        hasOutputFile: true,
      }),
    ];
    const readiness = computeExportReadiness(infos);
    const reference = readiness.find((r) => r.label === "reference")!;
    expect(reference.total).toBe(1);
    expect(reference.accepted).toBe(1);
    expect(reference.missing).toEqual([]);
    expect(reference.generated).toBe(1);
    expect(reference.notGenerated).toEqual([]);
    expect(readiness.find((r) => r.label === "animatic")?.generated ?? 0).toBe(0);
  });

  // A plate is baked while every shot on it may still be pending, so it is `generate` work of its
  // own — but never an accept.
  it("counts an unbaked plate as generate work, not toward either ratio", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "animatic:plate.master", assetKind: "comfy", reviewTarget: false }),
    ];
    const animatic = computeExportReadiness(infos).find((r) => r.label === "animatic")!;
    expect(animatic.total).toBe(0);
    expect(animatic.missing).toEqual([]);
    expect(animatic.notGenerated).toEqual(["plate.master"]);
  });

  it("reports all accepted when every generation asset is accepted", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "video:shot.01.motion", assetKind: "fal", hasAccepted: true }),
      makeInfo({ address: "video:shot.02.motion", assetKind: "comfy", hasAccepted: true }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.label).toBe("video");
    expect(readiness[0]!.total).toBe(2);
    expect(readiness[0]!.accepted).toBe(2);
    expect(readiness[0]!.missing).toEqual([]);
    // pendingShots (undeveloped shots) carry no address, so readiness itself can't see
    // them — it always reports 0; the status builder folds the per-profile count in afterward.
    expect(readiness[0]!.pendingShots).toBe(0);
  });

  it("flags a fully-accepted profile with a stale accepted variant as not export-ready", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "video:shot.01.motion", assetKind: "fal", hasAccepted: true }),
      makeInfo({
        address: "video:shot.02.motion",
        assetKind: "comfy",
        hasAccepted: true,
        staleVariants: [
          {
            variantId: "v-PRWl2g1h",
            inputStale: false,
            definitionStale: true,
            patchStale: false,
            changedInputs: [],
          },
        ],
      }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.accepted).toBe(2);
    expect(readiness[0]!.total).toBe(2);
    expect(readiness[0]!.missing).toEqual([]);
    expect(readiness[0]!.staleAwaitingReroll).toEqual(["shot.02.motion"]);
    expect(readiness[0]!.staleAwaitingAccept).toEqual([]);
  });

  it("routes a stale accepted variant with a fresh take waiting to accept, not reroll", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "comfy",
        hasAccepted: true,
        undecidedTakeVariantId: "v-undecided",
        staleVariants: [
          {
            variantId: "v-PRWl2g1h",
            inputStale: false,
            definitionStale: true,
            patchStale: false,
            changedInputs: [],
          },
        ],
      }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness[0]!.staleAwaitingAccept).toEqual(["shot.01.motion"]);
    expect(readiness[0]!.staleAwaitingReroll).toEqual([]);
  });

  it("reports missing assets", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "video:shot.01.motion", assetKind: "fal", hasAccepted: true }),
      makeInfo({ address: "video:shot.02.motion", assetKind: "fal", hasAccepted: false }),
      makeInfo({ address: "video:shot.03.motion", assetKind: "comfy", hasAccepted: false }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.accepted).toBe(1);
    expect(readiness[0]!.total).toBe(3);
    expect(readiness[0]!.missing).toEqual(["shot.02.motion", "shot.03.motion"]);
  });

  it("reports file assets separately from the generation accept ratio", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "video:shot.01.motion", assetKind: "fal", hasAccepted: true }),
      makeInfo({ address: "reference:bgm", assetKind: "file", hasAccepted: true }),
    ];
    const readiness = computeExportReadiness(infos);
    const video = readiness.find((r) => r.label === "video")!;
    expect(video.total).toBe(1);
    expect(video.accepted).toBe(1);
    expect(video.filesReady).toBe(0);

    const reference = readiness.find((r) => r.label === "reference")!;
    expect(reference.total).toBe(0);
    expect(reference.filesReady).toBe(1);
    expect(reference.filesMissing).toEqual([]);
  });

  it("emits a reference-only stage on its own line", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "reference:character", assetKind: "file", hasAccepted: true }),
      makeInfo({ address: "reference:bgm", assetKind: "file", hasAccepted: true }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.label).toBe("reference");
    expect(readiness[0]!.total).toBe(0);
    expect(readiness[0]!.accepted).toBe(0);
    expect(readiness[0]!.filesReady).toBe(2);
    expect(readiness[0]!.filesMissing).toEqual([]);
  });

  it("folds a stage's file assets into its stage line", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "video:shot.01.motion", assetKind: "fal", hasAccepted: true }),
      makeInfo({ address: "video:timeline.bgm", assetKind: "file", hasAccepted: true }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.label).toBe("video");
    expect(readiness[0]!.total).toBe(1);
    expect(readiness[0]!.filesReady).toBe(1);
  });

  it("groups by stage", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "animatic:shot.01.first",
        assetKind: "fal",
        hasAccepted: true,
      }),
      makeInfo({
        address: "animatic:shot.02.first",
        assetKind: "fal",
        hasAccepted: true,
      }),
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        hasAccepted: false,
      }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness).toHaveLength(2);

    const animatic = readiness.find((r) => r.label === "animatic");
    expect(animatic).toBeDefined();
    expect(animatic!.accepted).toBe(2);
    expect(animatic!.total).toBe(2);
    expect(animatic!.missing).toEqual([]);

    const video = readiness.find((r) => r.label === "video");
    expect(video).toBeDefined();
    expect(video!.accepted).toBe(0);
    expect(video!.total).toBe(1);
    expect(video!.missing).toEqual(["shot.01.motion"]);
  });

  it("handles timeline assets in missing list", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:timeline.bgm",
        assetKind: "fal",
        hasAccepted: false,
      }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness[0]!.missing).toEqual(["timeline.bgm"]);
  });

  it("reports a file with no file on disk as missing, not in the accept ratio", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "reference:bgm", assetKind: "file", hasAccepted: false }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]!.total).toBe(0);
    expect(readiness[0]!.accepted).toBe(0);
    expect(readiness[0]!.filesReady).toBe(0);
    expect(readiness[0]!.filesMissing).toEqual(["bgm"]);
  });

  it("separates never-generated from generated-but-unaccepted", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        assetKind: "fal",
        hasAccepted: true,
        hasOutputFile: true,
      }),
      makeInfo({
        address: "video:shot.02.motion",
        assetKind: "fal",
        hasAccepted: false,
        hasOutputFile: true,
      }),
      makeInfo({
        address: "video:shot.03.motion",
        assetKind: "fal",
        hasAccepted: false,
        hasOutputFile: false,
      }),
    ];
    const readiness = computeExportReadiness(infos);
    expect(readiness[0]!.accepted).toBe(1);
    expect(readiness[0]!.generated).toBe(2);
    expect(readiness[0]!.total).toBe(3);
    expect(readiness[0]!.missing).toEqual(["shot.02.motion", "shot.03.motion"]);
    expect(readiness[0]!.notGenerated).toEqual(["shot.03.motion"]);
  });

  it("excludes null assetKind from readiness", () => {
    const infos: AddressInfo[] = [makeInfo({ address: "video:shot.01", assetKind: null })];
    const readiness = computeExportReadiness(infos);
    expect(readiness).toEqual([]);
  });

  it("seeds a stage line for a stage whose shots are all undeveloped (no address)", () => {
    // Reference has an asset; animatic and video are addressless (every shot pending). Without
    // the seed those two stages would vanish from Progress entirely.
    const infos: AddressInfo[] = [makeInfo({ address: "reference:bgm", assetKind: "file" })];
    const readiness = computeExportReadiness(infos, { animatic: 7, video: 3 });

    const byLabel = Object.fromEntries(readiness.map((r) => [r.label, r]));
    expect(byLabel.animatic).toMatchObject({ total: 0, pendingShots: 7 });
    expect(byLabel.video).toMatchObject({ total: 0, pendingShots: 3 });
    // Ordered reference → animatic → video.
    expect(readiness.map((r) => r.label)).toEqual(["reference", "animatic", "video"]);
  });

  it("carries an undeveloped count onto an existing stage entry", () => {
    const infos: AddressInfo[] = [
      makeInfo({ address: "video:shot.01.motion", assetKind: "fal", hasAccepted: true }),
    ];
    const readiness = computeExportReadiness(infos, { video: 2 });
    expect(readiness).toHaveLength(1);
    expect(readiness[0]).toMatchObject({ label: "video", total: 1, accepted: 1, pendingShots: 2 });
  });

  it("does not seed a stage whose undeveloped count is zero", () => {
    const infos: AddressInfo[] = [makeInfo({ address: "reference:bgm", assetKind: "file" })];
    const readiness = computeExportReadiness(infos, { animatic: 0, video: 0 });
    expect(readiness.map((r) => r.label)).toEqual(["reference"]);
  });
});

describe("detectOrphans", () => {
  it("detects active jobs with no matching variant in state", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-abc12345": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: null,
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const allJobs = [
      makeJob({ variantId: "v-abc12345", status: "running" }),
      makeJob({ variantId: "v-orphan01", status: "running" }),
      makeJob({ variantId: "v-orphan02", status: "pending" }),
    ];

    const result = detectOrphans(state, allJobs);
    expect(result.orphanJobs).toHaveLength(2);
    expect(result.orphanJobs.map((o) => o.variantId).sort()).toEqual(["v-orphan01", "v-orphan02"]);
  });

  it("ignores terminal-state orphan jobs (ready, failed, cancelled)", () => {
    const state = makeState({});
    const allJobs = [
      makeJob({ variantId: "v-ready001", status: "completed" }),
      makeJob({ variantId: "v-fail0001", status: "failed" }),
      makeJob({ variantId: "v-cancel01", status: "cancelled" }),
    ];

    const result = detectOrphans(state, allJobs);
    expect(result.orphanJobs).toEqual([]);
  });

  it("returns empty when all jobs have matching variants", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          "v-abc12345": {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: null,
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const allJobs = [makeJob({ variantId: "v-abc12345", status: "running" })];

    const result = detectOrphans(state, allJobs);
    expect(result.orphanJobs).toEqual([]);
  });

  it("returns empty when there are no jobs", () => {
    const state = makeState({});
    const result = detectOrphans(state, []);
    expect(result.orphanJobs).toEqual([]);
  });
});

describe("computeStatusSections with orphans", () => {
  it("includes orphan jobs in Problems section", () => {
    const infos: AddressInfo[] = [];
    const orphans = {
      orphanJobs: [
        { variantId: "v-orphan01", address: "video:shot.01.motion", jobStatus: "running" },
      ],
    };
    const sections = computeStatusSections(infos, orphans);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Problems");
    expect(sections[0]!.items[0]).toEqual({
      address: "video:shot.01.motion",
      detail: "v-orphan01 orphan job (running), no variant in state",
    });
  });

  it("merges orphan jobs with regular problem variants", () => {
    const infos: AddressInfo[] = [
      makeInfo({
        address: "video:shot.01.motion",
        problemVariants: ["v-problem1"],
      }),
    ];
    const orphans = {
      orphanJobs: [
        { variantId: "v-orphan01", address: "video:shot.02.motion", jobStatus: "pending" },
      ],
    };
    const sections = computeStatusSections(infos, orphans);
    const problemSection = sections.find((s) => s.title === "Problems");
    expect(problemSection).toBeDefined();
    expect(problemSection!.items).toHaveLength(2);
  });
});

describe("computeLastExports", () => {
  function makeExportJob(
    overrides: { completedAt: string | null } & Partial<JobRecord>,
  ): JobRecord {
    const { completedAt, ...rest } = overrides;
    return {
      kind: "export",
      id: `exp-${completedAt ?? "x"}`,
      status: "completed",
      dependsOnAssets: [],
      dependsOnJobs: [],
      lease: null,
      backendKind: "local",
      progress: null,
      error: null,
      outputDir: `dist/20260101T000000000`,
      outputFile: `dist/20260101T000000000/video.mp4`,
      allowUnaccepted: false,
      noDelivery: false,
      metadata: {},
      createdAt: completedAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: completedAt ?? "2026-01-01T00:00:00.000Z",
      completedAt,
      ...rest,
    } as JobRecord;
  }

  it("returns the latest successful export within scope", () => {
    const jobs = [
      makeExportJob({ completedAt: "2026-06-19T08:00:00.000Z" }),
      makeExportJob({ completedAt: "2026-06-19T09:30:00.000Z" }),
    ];
    const result = computeLastExports(true, jobs);
    expect(result).toEqual([
      {
        label: "video",
        noDelivery: false,
        outputFile: "dist/20260101T000000000/video.mp4",
        completedAt: "2026-06-19T09:30:00.000Z",
        outOfDate: false,
      },
    ]);
  });

  it("flags an export whose signature no longer matches the current one", () => {
    const jobs = [
      makeExportJob({
        completedAt: "2026-06-19T09:30:00.000Z",
        exportSignature: "abc123",
      } as Partial<JobRecord> & { completedAt: string | null }),
    ];
    const result = computeLastExports(true, jobs, () => "different");
    expect(result.map((e) => e.outOfDate)).toEqual([true]);
  });

  it("does not flag when the signature matches", () => {
    const stamped = makeExportJob({
      completedAt: "2026-06-19T09:30:00.000Z",
      exportSignature: "abc123",
    } as Partial<JobRecord> & { completedAt: string | null });
    const result = computeLastExports(true, [stamped], () => "abc123");
    expect(result[0]!.outOfDate).toBe(false);
  });

  it("does not flag a legacy export with no stamped signature", () => {
    const legacy = makeExportJob({ completedAt: "2026-06-19T10:00:00.000Z" });
    const result = computeLastExports(true, [legacy], () => "whatever");
    expect(result[0]!.outOfDate).toBe(false);
  });

  it("ignores non-ready and fileless export jobs", () => {
    const jobs = [
      makeExportJob({
        completedAt: "2026-06-19T08:00:00.000Z",
        status: "failed",
      }),
      makeExportJob({
        completedAt: "2026-06-19T09:00:00.000Z",
        outputFile: null,
      }),
    ];
    expect(computeLastExports(true, jobs)).toEqual([]);
  });

  it("recognizes no-delivery working-size checks", () => {
    const jobs = [
      makeExportJob({
        completedAt: "2026-06-19T09:00:00.000Z",
        noDelivery: true,
      } as Partial<JobRecord> & { completedAt: string | null }),
    ];
    expect(computeLastExports(true, jobs)).toMatchObject([{ noDelivery: true }]);
  });

  it("returns nothing when the video stage is not in scope", () => {
    const jobs = [makeExportJob({ completedAt: "2026-06-19T10:00:00.000Z" })];
    expect(computeLastExports(false, jobs)).toEqual([]);
  });

  it("ignores generation jobs", () => {
    const jobs = [makeJob({ variantId: "v-abc12345", status: "completed" })];
    expect(computeLastExports(true, jobs)).toEqual([]);
  });
});

describe("unreachable review work", () => {
  it("reports it as a konte bug instead of asking for a review no page can take", () => {
    const sections = computeStatusSections(
      [makeInfo({ address: "video:shot.01#mystery", readyCount: 1, reviewUnreachable: true })],
      { orphanJobs: [] },
    );
    expect(sections.find((s) => s.title === "Needs review")).toBeUndefined();
    expect(sections.find((s) => s.title === "Problems")?.items).toEqual([
      {
        address: "video:shot.01#mystery",
        detail: "needs a verdict but no review surface offers one — konte bug",
      },
    ]);
  });

  it("says nothing about an address that owes no verdict yet", () => {
    const sections = computeStatusSections(
      [makeInfo({ address: "video:shot.01#mystery", readyCount: 0, reviewUnreachable: true })],
      { orphanJobs: [] },
    );
    expect(sections.find((s) => s.title === "Problems")).toBeUndefined();
  });
});

describe("an accepted take whose upstream alone changed", () => {
  const info = () =>
    makeInfo({
      address: "animatic:shot.14.first",
      hasAccepted: true,
      staleVariants: [
        {
          variantId: "v-K3epT4ke",
          inputStale: true,
          definitionStale: false,
          patchStale: false,
          changedInputs: [{ assetPath: "animatic:shot.12.first", recorded: "old", current: "new" }],
        },
      ],
      staleAcceptStands: true,
    });

  it("stands: named in no section and no stale count", () => {
    expect(computeStatusSections([info()])).toEqual([]);
    const [animatic] = computeExportReadiness([info()]);
    expect(animatic!.staleAwaitingReroll).toEqual([]);
    expect(animatic!.staleAwaitingAccept).toEqual([]);
  });

  it("is built only for a human's verdict on its inputs", () => {
    const state = makeState({
      "animatic:shot.12.first": {
        variants: {
          "v-up": {
            status: "accepted",
            outputHash: "new",
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "up.png",
            definitionHash: null,
            metadata: {},
          },
        },
      },
      "animatic:shot.14.first": {
        variants: {
          "v-K3epT4ke": {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: { "animatic:shot.12.first": "old" },
            file: "down.png",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const build = (deterministic: boolean) =>
      buildAddressInfo(
        "animatic:shot.14.first",
        state,
        new Map(),
        "fal",
        null,
        new JobIndex([]),
        false,
        undefined,
        false,
        null,
        undefined,
        undefined,
        true,
        false,
        deterministic,
      );
    expect(build(false).staleAcceptStands).toBe(true);
    expect(build(true).staleAcceptStands).toBe(false);
  });
});
