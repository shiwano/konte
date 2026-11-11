import { describe, expect, it } from "vitest";
import type { ShotInfo, VideoPreviewState } from "../../types.js";
import { marksStillShown } from "../reel-marks-shown.js";
import { NO_REEL_MARKS, type ReelMarks } from "../use-reel-decisions.js";

const shot = (shotId: string, variantId: string, variants: string[], o: Partial<ShotInfo> = {}) =>
  ({
    shotId,
    assets: [
      {
        address: `video:shot.${shotId}.motion`,
        variantId,
        hasUndecidedBesideAccepted: false,
        variants: variants.map((v) => ({ variantId: v })),
      },
    ],
    verdictAddresses: [`video:shot.${shotId}.motion`],
    compositionVariantId: null,
    compositionDefinitionHash: "h1",
    stems: [],
    waivers: [],
    showingStandIn: false,
    ...o,
  }) as unknown as ShotInfo;

const reel = (shots: ShotInfo[], o: Partial<VideoPreviewState> = {}) =>
  ({ shots, audioAssets: [], compositionRefVariants: {}, ...o }) as unknown as VideoPreviewState;

const marked: ReelMarks = { ...NO_REEL_MARKS, shots: { "01": "accepted", "02": "accepted" } };

describe("marksStillShown", () => {
  it("drops the mark of a shot whose resolved take moved, and keeps the rest", () => {
    const before = reel([shot("01", "v-a", ["v-a"]), shot("02", "v-c", ["v-c"])]);
    const after = reel([shot("01", "v-b", ["v-a", "v-b"]), shot("02", "v-c", ["v-c"])]);
    const still = marksStillShown(marked, before, after, {});
    expect(still.marks.shots).toEqual({ "02": "accepted" });
    expect(still.movedShots).toEqual(["01"]);
  });

  it("keeps a mark whose take a gallery pick holds on screen", () => {
    const before = reel([shot("01", "v-a", ["v-a"]), shot("02", "v-c", ["v-c"])]);
    const after = reel([shot("01", "v-b", ["v-a", "v-b"]), shot("02", "v-c", ["v-c"])]);
    const still = marksStillShown(marked, before, after, { "video:shot.01.motion": "v-a" });
    expect(still.marks).toBe(marked);
  });

  it("drops the mark of a shot whose composition definition moved", () => {
    const before = reel([shot("01", "v-a", ["v-a"]), shot("02", "v-c", ["v-c"])]);
    const after = reel([
      shot("01", "v-a", ["v-a"], { compositionDefinitionHash: "h2" }),
      shot("02", "v-c", ["v-c"]),
    ]);
    expect(marksStillShown(marked, before, after, {}).marks.shots).toEqual({ "02": "accepted" });
  });

  it("drops the mark of a shot the reload removed", () => {
    const before = reel([shot("01", "v-a", ["v-a"]), shot("02", "v-c", ["v-c"])]);
    const after = reel([shot("02", "v-c", ["v-c"])]);
    expect(marksStillShown(marked, before, after, {}).movedShots).toEqual(["01"]);
  });

  it("drops the timeline stem mark when its definition moved", () => {
    const stem = (definitionHash: string) =>
      ({
        address: "video:timeline#stem",
        variantId: null,
        definitionHash,
        needsReview: true,
        verdictAddresses: [],
        feedback: [],
      }) as VideoPreviewState["timelineStem"];
    const marks: ReelMarks = { ...NO_REEL_MARKS, stem: "accepted" };
    const before = reel([], { timelineStem: stem("h1") });
    expect(marksStillShown(marks, before, reel([], { timelineStem: stem("h1") }), {}).marks).toBe(
      marks,
    );
    expect(
      marksStillShown(marks, before, reel([], { timelineStem: stem("h2") }), {}).marks.stem,
    ).toBeUndefined();
  });

  it("keeps a mark across a re-materialized leaf whose definition and inputs held", () => {
    const stem = (variantId: string) =>
      ({
        address: "video:timeline#stem",
        variantId,
        definitionHash: "h1",
        needsReview: false,
        verdictAddresses: [],
        feedback: [],
      }) as VideoPreviewState["timelineStem"];
    const marks: ReelMarks = {
      ...NO_REEL_MARKS,
      shots: { "01": "none" },
      stem: "none",
    };
    const before = reel([shot("01", "v-a", ["v-a"], { compositionVariantId: "v-c1" })], {
      timelineStem: stem("v-s1"),
    });
    const after = reel([shot("01", "v-a", ["v-a"], { compositionVariantId: "v-c2" })], {
      timelineStem: stem("v-s2"),
    });
    expect(marksStillShown(marks, before, after, {}).marks).toBe(marks);
  });

  it("drops the overlay mark when a take it shows from its timeline moved", () => {
    const overlay = {
      address: "video:timeline#overlay",
      duration: 10,
      variantId: null,
      definitionHash: "h1",
      needsReview: true,
      offered: true,
      verdictAddresses: ["video:timeline.logo"],
      feedback: [],
    } as VideoPreviewState["overlay"];
    const marks: ReelMarks = { ...NO_REEL_MARKS, overlay: "accepted" };
    const at = (variantId: string) =>
      reel([], { overlay, compositionRefVariants: { "video:timeline.logo": variantId } });
    expect(marksStillShown(marks, at("v-a"), at("v-a"), {}).marks).toBe(marks);
    expect(marksStillShown(marks, at("v-a"), at("v-b"), {}).marks.overlay).toBeUndefined();
  });
});
