import { describe, expect, it } from "vitest";
import type { ReelPreviewState, ShotInfo } from "../../../../core/types/review-state.js";
import { focusTargetOf } from "../focus-target.js";

type FocusState = Pick<ReelPreviewState, "timelineStem" | "overlay" | "thumbnail">;

const shot = { shotId: "01" } as ShotInfo;
const full = {
  timelineStem: { address: "video:timeline#stem" },
  overlay: { address: "video:timeline#overlay", offered: true },
  thumbnail: { target: "video:thumbnail" },
} as unknown as FocusState;

describe("focusTargetOf", () => {
  it("points at the picked span target while the state offers it", () => {
    expect(focusTargetOf("soundtrack", full, shot)).toMatchObject({
      kind: "soundtrack",
      address: "video:timeline#stem",
      label: "Soundtrack",
    });
    expect(focusTargetOf("overlay", full, shot)).toMatchObject({
      kind: "overlay",
      address: "video:timeline#overlay",
    });
    expect(focusTargetOf("thumbnail", full, shot)).toMatchObject({
      kind: "thumbnail",
      address: "video:thumbnail",
    });
  });

  it("falls back to the shot when the picked target is gone or not offered", () => {
    const bare = {
      overlay: { address: "video:timeline#overlay", offered: false },
    } as unknown as FocusState;
    for (const pick of ["soundtrack", "overlay", "thumbnail"] as const) {
      expect(focusTargetOf(pick, bare, shot)).toEqual({ kind: "shot", shot });
    }
  });
});
