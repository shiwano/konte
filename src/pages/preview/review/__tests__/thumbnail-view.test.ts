import { describe, expect, it } from "vitest";
import type { VideoPreviewState } from "../../types.js";
import { thumbnailShownAccepted, thumbnailSwitched } from "../thumbnail-view.js";

type Thumbnail = NonNullable<VideoPreviewState["thumbnail"]>;

const thumbnail = (over: Partial<Thumbnail> = {}): Thumbnail => ({
  target: "video:thumbnail",
  cover: {
    address: "video:thumbnail#still",
    variantId: "v-t",
    variantStatus: "accepted",
  } as unknown as Thumbnail["cover"],
  frame: { at: 1, shotId: "01", shotTime: 1 },
  imageUrl: "/api/assets/still.png",
  sources: { "video:thumbnail.cover": "v-a" },
  needsReview: false,
  assets: [
    { address: "video:thumbnail.cover", variantId: "v-a" },
  ] as unknown as Thumbnail["assets"],
  feedback: [],
  ...over,
});

describe("thumbnailSwitched", () => {
  it("names an own asset whose take on screen the still was not made from", () => {
    expect(thumbnailSwitched(thumbnail(), {})).toEqual([]);
    expect(thumbnailSwitched(thumbnail(), { "video:thumbnail.cover": "v-a" })).toEqual([]);
    expect(thumbnailSwitched(thumbnail(), { "video:thumbnail.cover": "v-b" })).toEqual([
      "video:thumbnail.cover",
    ]);
  });

  it("leaves out an asset the still was made from no known take of", () => {
    expect(
      thumbnailSwitched(thumbnail({ sources: {} }), { "video:thumbnail.cover": "v-b" }),
    ).toEqual([]);
  });
});

describe("thumbnailShownAccepted", () => {
  it("stands while the still is accepted and its own takes are the ones it was made from", () => {
    expect(thumbnailShownAccepted(thumbnail(), {})).toBe(true);
    expect(thumbnailShownAccepted(thumbnail(), { "video:thumbnail.cover": "v-b" })).toBe(false);
  });

  it("falls when the still is not accepted or a take awaits a verdict", () => {
    const pending = thumbnail({
      cover: { ...thumbnail().cover, variantStatus: "none" },
    });
    expect(thumbnailShownAccepted(pending, {})).toBe(false);
    expect(thumbnailShownAccepted(thumbnail({ needsReview: true }), {})).toBe(false);
    expect(thumbnailShownAccepted(undefined, {})).toBe(false);
  });
});
