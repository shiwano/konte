import { describe, expect, it } from "vitest";
import { parseAssetUrlPath } from "../server.js";

describe("parseAssetUrlPath", () => {
  it("splits an address, variant id, and filename", () => {
    expect(parseAssetUrlPath("video/shot.01.motion/v-abc/output.mp4")).toEqual({
      address: "video:shot.01.motion",
      variantId: "v-abc",
      filename: "output.mp4",
    });
  });

  it("decodes each segment exactly once, so a literal % in a filename survives", () => {
    expect(parseAssetUrlPath("video/shot.01.motion/v-abc/100%25.png")?.filename).toBe("100%.png");
    expect(parseAssetUrlPath("video/shot.01.motion/v-abc/%2541.png")?.filename).toBe("%41.png");
  });

  it("returns null on a malformed escape rather than throwing", () => {
    expect(parseAssetUrlPath("video/shot.01.motion/v-abc/%zz.png")).toBeNull();
  });

  it("returns null when the path has too few segments", () => {
    expect(parseAssetUrlPath("video/shot.01.motion/v-abc")).toBeNull();
  });
});
