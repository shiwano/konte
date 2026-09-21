import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assetsGitTracking, renderAssetsGitignore } from "../assets-gitignore.js";
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

function state(assets: KonteState["assets"]): KonteState {
  return { schemaVersion: 5, assets };
}

function keptLines(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("!/") && !line.includes("*"));
}

const MOTION = "video:shot.01.motion";
const PATCH_STEP = "animatic:patch.v-src.fix";
const FIRST = "animatic:shot.01.first";

describe("renderAssetsGitignore", () => {
  it("ignores every variant directory by shape, re-including each stage's patch chains", () => {
    const content = renderAssetsGitignore(state({}));
    expect(content.split("\n").slice(1, 4)).toEqual([
      "/reference/*/v-*/",
      "!/reference/patch/v-*/",
      "/reference/patch/v-*/*/v-*/",
    ]);
    expect(keptLines(content)).toEqual([]);
  });

  it("re-includes only the directory of an accepted take", () => {
    const content = renderAssetsGitignore(
      state({
        [MOTION]: {
          variants: {
            "v-a": variant({ status: "accepted", file: "assets/video/shot.01.motion/v-a/out.mp4" }),
            "v-b": variant({ file: "assets/video/shot.01.motion/v-b/out.mp4" }),
            "v-c": variant({
              status: "dismissed",
              file: "assets/video/shot.01.motion/v-c/out.mp4",
            }),
          },
        },
      }),
    );
    expect(keptLines(content)).toEqual(["!/video/shot.01.motion/v-a/"]);
  });

  it("keeps an accepted patch's source and the step directory its file lives in", () => {
    const content = renderAssetsGitignore(
      state({
        [FIRST]: {
          variants: {
            "v-src": variant({ file: "assets/animatic/shot.01.first/v-src/out.png" }),
            "v-out": variant({
              status: "accepted",
              derivedFrom: "v-src",
              file: "assets/animatic/patch/v-src/fix/v-step/out.png",
            }),
          },
        },
        [PATCH_STEP]: {
          variants: {
            "v-step": variant({ file: "assets/animatic/patch/v-src/fix/v-step/out.png" }),
            "v-old": variant({ file: "assets/animatic/patch/v-src/fix/v-old/out.png" }),
          },
        },
      }),
    );
    expect(keptLines(content)).toEqual([
      "!/animatic/patch/v-src/fix/v-step/",
      "!/animatic/shot.01.first/v-src/",
    ]);
  });

  it("leaves a file outside every variant directory, and a directory state does not own, alone", () => {
    const content = renderAssetsGitignore(
      state({
        "reference:photo": {
          variants: { "v-f": variant({ status: "accepted", file: "assets/files/photo.png" }) },
        },
        [MOTION]: {
          variants: {
            "v-a": variant({
              status: "accepted",
              file: "assets/video/shot.01.motion/v-gone/x.mp4",
            }),
          },
        },
      }),
    );
    expect(keptLines(content)).toEqual([]);
  });
});

describe("assetsGitTracking", () => {
  it("ignores an unprotected take's file, not a protected one's or one outside the variant dirs", () => {
    const tracking = assetsGitTracking(
      state({
        [MOTION]: {
          variants: {
            "v-a": variant({ status: "accepted", file: "assets/video/shot.01.motion/v-a/out.mp4" }),
            "v-b": variant({ file: "assets/video/shot.01.motion/v-b/out.mp4" }),
          },
        },
      }),
    );
    expect(tracking.ignores(path.join("assets/video/shot.01.motion/v-b/out.mp4"))).toBe(true);
    expect(tracking.ignores(path.join("assets/video/shot.01.motion/v-a/out.mp4"))).toBe(false);
    expect(tracking.ignores(path.join("assets/files/clip.mp4"))).toBe(false);
  });
});
