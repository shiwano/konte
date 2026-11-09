import { describe, expect, it } from "vitest";
import type { ShotInfo, VideoPreviewState } from "../../types.js";
import { buildReelSubmitPayload } from "../reel-submit-payload.js";
import { NO_REEL_MARKS } from "../use-reel-decisions.js";

const asset = (address: string, variantId: string | null, variants: string[]) => ({
  address,
  variantId,
  variants: variants.map((v) => ({ variantId: v })),
});

const shot = (shotId: string, o: Partial<Record<string, unknown>> = {}) =>
  ({
    shotId,
    assets: [asset(`video:shot.${shotId}.motion`, "v-a", ["v-a", "v-b"])],
    stems: [],
    showingStandIn: false,
    ...o,
  }) as unknown as ShotInfo;

const input = { addedFeedback: [], feedbackPatches: [], overallComment: "" };

describe("buildReelSubmitPayload", () => {
  it("snapshots the shown take, a gallery pick over the resolved one and the composite's refs", () => {
    const body = buildReelSubmitPayload({
      state: {
        shots: [shot("01")],
        audioAssets: [
          asset("video:timeline.bed", "v-s", [
            "v-s",
          ]) as unknown as VideoPreviewState["audioAssets"][number],
        ],
        compositionRefVariants: { "reference:hero": "v-r", "video:shot.01.motion": "v-a" },
      },
      marks: NO_REEL_MARKS,
      keepChoices: [],
      effectiveVariants: { "video:shot.01.motion": "v-b" },
      input,
    });
    expect(body.displayedVariants).toEqual({
      "reference:hero": "v-r",
      "video:shot.01.motion": "v-b",
      "video:timeline.bed": "v-s",
    });
    expect(body.displayedCandidates).toEqual({
      "video:shot.01.motion": ["v-a", "v-b"],
      "video:timeline.bed": ["v-s"],
    });
    expect(body.notes).toBeUndefined();
    expect(body).not.toHaveProperty("timelineStemDecision");
    expect(body).not.toHaveProperty("keep");
  });

  it("carries the marks, the stand-ins and each draft as a note", () => {
    const body = buildReelSubmitPayload({
      state: {
        shots: [shot("01", { showingStandIn: true }), shot("02")],
        audioAssets: [],
        compositionRefVariants: {},
      },
      marks: {
        shots: { "02": "accepted" },
        stem: "none",
        overlay: undefined,
        thumbnail: undefined,
      },
      keepChoices: [],
      effectiveVariants: {},
      input: {
        ...input,
        addedFeedback: [
          {
            id: "p1",
            address: "video:shot.02",
            text: "too dark",
            annotation: { kind: "pin", x: 0.5, y: 0.25 },
            time: 3,
            shotId: "02",
          },
        ],
      },
    });
    expect(body.decisions).toEqual({ "02": "accepted" });
    expect(body.timelineStemDecision).toBe("none");
    expect(body).not.toHaveProperty("overlayDecision");
    expect(body.displayedStandInShotIds).toEqual(["01"]);
    expect(body.notes).toEqual([
      { time: 3, shotId: "02", address: "video:shot.02", text: "too dark", x: 0.5, y: 0.25 },
    ]);
  });

  it("snapshots the cover and the thumbnail's own takes, a gallery pick winning", () => {
    const body = buildReelSubmitPayload({
      state: {
        shots: [shot("01")],
        audioAssets: [],
        compositionRefVariants: { "animatic:shot.01.first": "v-p" },
        thumbnail: {
          target: "video:thumbnail",
          cover: asset("video:thumbnail#still", "v-t2", ["v-t2", "v-t1"]),
          imageUrl: "/api/assets/still.png",
          sources: { "video:thumbnail.cover": "v-c1" },
          needsReview: true,
          assets: [asset("video:thumbnail.cover", "v-c1", ["v-c1", "v-c2"])],
          feedback: [],
        } as unknown as NonNullable<VideoPreviewState["thumbnail"]>,
      },
      marks: { ...NO_REEL_MARKS, thumbnail: "accepted" },
      keepChoices: [],
      effectiveVariants: { "video:thumbnail.cover": "v-c2" },
      input,
    });
    expect(body.thumbnailDecision).toBe("accepted");
    expect(body.displayedVariants).toMatchObject({
      "video:thumbnail#still": "v-t2",
      "video:thumbnail.cover": "v-c2",
      "animatic:shot.01.first": "v-p",
    });
    expect(body.displayedCandidates?.["video:thumbnail#still"]).toEqual(["v-t2", "v-t1"]);
    expect(body.displayedCandidates?.["video:thumbnail.cover"]).toEqual(["v-c1", "v-c2"]);
  });
});
