import { describe, expect, it } from "vitest";
import type { ShotInfo, VideoPreviewState } from "../../types.js";
import {
  auditioning,
  leafShownAccepted,
  reelTakes,
  servedTakes,
  type ReelTakesState,
} from "../reel-takes.js";

type AudioAsset = VideoPreviewState["audioAssets"][number];

const shot = { shotId: "01", assets: [{ address: "video:shot.01.motion", variantId: "v-m" }] };
const bed = { address: "video:timeline.bgm", kind: "soundtrack", variantId: "v-old" };
const state: ReelTakesState = {
  shots: [shot] as unknown as ShotInfo[],
  audioAssets: [bed] as unknown as AudioAsset[],
  compositionRefVariants: {
    "video:timeline.logo": "v-logo",
    "video:shot.01.motion": "v-drawn",
  },
};
const served = servedTakes(state);

const leaf = (over: Partial<Parameters<typeof leafShownAccepted>[0] & object> = {}) => ({
  variantId: "v-stem",
  needsReview: false,
  verdictAddresses: ["video:timeline.bgm", "video:timeline.logo"],
  ...over,
});

describe("reelTakes", () => {
  it("shows a gallery pick over the resolved take, and a drawn take where nothing is galleried", () => {
    const takes = reelTakes(served, { "video:timeline.bgm": "v-new" });
    expect(takes.shown("video:timeline.bgm")).toBe("v-new");
    expect(takes.resolved("video:timeline.bgm")).toBe("v-old");
    expect(takes.shown("video:timeline.logo")).toBe("v-logo");
    expect(takes.galleried("video:timeline.logo")).toBe(false);
    expect(takes.shown("video:shot.01.unknown")).toBeNull();
  });

  it("displays every address on screen, a galleried take winning over the drawn one", () => {
    expect(reelTakes(served, { "video:timeline.bgm": "v-new" }).displayed).toEqual({
      "video:shot.01.motion": "v-m",
      "video:timeline.bgm": "v-new",
      "video:timeline.logo": "v-logo",
    });
  });
});

describe("auditioning", () => {
  it("reads a verdict address playing a take other than the one it resolves to", () => {
    expect(auditioning(["video:timeline.bgm"], reelTakes(served, {}))).toBe(false);
    expect(
      auditioning(["video:timeline.bgm"], reelTakes(served, { "video:timeline.bgm": "v-old" })),
    ).toBe(false);
    expect(
      auditioning(["video:timeline.bgm"], reelTakes(served, { "video:timeline.bgm": "v-new" })),
    ).toBe(true);
  });

  it("ignores a pick at an address outside the unit", () => {
    const takes = reelTakes(served, { "video:shot.01.motion": "v-n" });
    expect(auditioning(["video:timeline.bgm", "video:timeline.logo"], takes)).toBe(false);
  });
});

describe("leafShownAccepted", () => {
  it("stands while its accept stands and its takes play as resolved", () => {
    expect(leafShownAccepted(leaf(), reelTakes(served, {}))).toBe(true);
  });

  it("falls while a take beside the accepted bed plays", () => {
    expect(leafShownAccepted(leaf(), reelTakes(served, { "video:timeline.bgm": "v-new" }))).toBe(
      false,
    );
  });

  it("falls when unaccepted, awaiting review, or absent", () => {
    const takes = reelTakes(served, {});
    expect(leafShownAccepted(leaf({ variantId: null }), takes)).toBe(false);
    expect(leafShownAccepted(leaf({ needsReview: true }), takes)).toBe(false);
    expect(leafShownAccepted(undefined, takes)).toBe(false);
  });
});
