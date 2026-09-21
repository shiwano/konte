import { describe, expect, it } from "vitest";
import { shotChangedSinceAccept } from "../changed-since-accept.js";

type Shot = Parameters<typeof shotChangedSinceAccept>[0];

const shot = (o: Partial<Shot> = {}): Shot => ({
  assets: [],
  compositionVariantId: null,
  compositionNeedsReview: false,
  stems: [],
  ...o,
});

describe("shotChangedSinceAccept", () => {
  it("flags an accepted shot that gained its first stem", () => {
    // Adding the first <Audio> to an accepted shot mints its stem unaccepted: there is no
    // stem variant to compare against, but the shot moved since sign-off all the same.
    expect(
      shotChangedSinceAccept(
        shot({ compositionVariantId: "v-1", stems: [{ variantId: null, needsReview: true }] }),
      ),
    ).toBe(true);
  });

  it("flags an accepted composition gone stale", () => {
    expect(
      shotChangedSinceAccept(shot({ compositionVariantId: "v-1", compositionNeedsReview: true })),
    ).toBe(true);
  });

  it("flags an accepted stem gone stale", () => {
    expect(
      shotChangedSinceAccept(
        shot({ compositionVariantId: "v-1", stems: [{ variantId: "v-2", needsReview: true }] }),
      ),
    ).toBe(true);
  });

  it("flags a stem-only accept gone stale, with the composition never accepted", () => {
    // Reachable only out-of-band: `konte accept video:shot.X#stem` signs off one leaf.
    expect(shotChangedSinceAccept(shot({ stems: [{ variantId: "v-2", needsReview: true }] }))).toBe(
      true,
    );
  });

  it("flags a newer take beside the accepted one", () => {
    expect(shotChangedSinceAccept(shot({ assets: [{ hasNewerVariant: true }] }))).toBe(true);
  });

  it("stays quiet on an accepted silent shot", () => {
    // A shot with no audio has no stem, so the server sends no stems.
    expect(shotChangedSinceAccept(shot({ compositionVariantId: "v-1" }))).toBe(false);
  });

  it("stays quiet on a never-accepted shot", () => {
    // Nothing was signed off, so nothing moved since: the unchecked accept box already reads
    // as not-done, and "Changed" would claim a baseline that never existed.
    expect(
      shotChangedSinceAccept(
        shot({ compositionNeedsReview: true, stems: [{ variantId: null, needsReview: true }] }),
      ),
    ).toBe(false);
  });

  it("stays quiet when no asset has a newer take", () => {
    expect(shotChangedSinceAccept(shot({ assets: [{ hasNewerVariant: false }] }))).toBe(false);
  });
});
