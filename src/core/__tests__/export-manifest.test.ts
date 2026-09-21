import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  type DeliverySubstitution,
  type ResolvedForManifest,
} from "../render-video.js";
import type { RenderPlan, ShotRenderPlan } from "../render-plan.js";
import { ExportManifestSchema } from "../types/index.js";

const VIDEO_ROOT = "/tmp/konte-manifest";
const FORMAT = { size: { width: 1920, height: 1080 }, fps: 30 };

function variantFile(address: string, variantId: string, name: string): string {
  const suffix = address.slice("video:".length);
  return path.join(VIDEO_ROOT, "assets", "video", suffix, variantId, name);
}

function shot(overrides: Partial<ShotRenderPlan> = {}): ShotRenderPlan {
  return {
    stage: "video",
    shotId: "01",
    duration: 4,
    shotFn: null,
    showStandIn: false,
    pending: false,
    aside: false,
    action: "the hand opens",
    resolvedFiles: {},
    resolvedVariants: {},
    fallbackFile: null,
    fallbackType: null,
    warnings: [],
    unacceptedAssets: [],
    notReadyAssets: [],
    unacceptedRefs: [],
    unresolvedRefs: [],
    ...overrides,
  };
}

function plan(shots: ShotRenderPlan[], overrides: Partial<RenderPlan> = {}): RenderPlan {
  return {
    stage: "video",
    standInPlan: null,
    bedLevels: {},
    fps: 30,
    typography: { lang: "ja" },
    size: FORMAT.size,
    format: FORMAT,
    shots,
    outputDir: path.join(VIDEO_ROOT, "dist", "video", "20260716T000000000"),
    timelineResolvedFiles: {},
    timelineResolvedVariants: {},
    timelineFn: null,
    unacceptedTimelineAssets: [],
    timelineNotReadyAssets: [],
    ...overrides,
  };
}

function build(p: RenderPlan, overrides: Partial<Parameters<typeof buildManifest>[1]> = {}) {
  return buildManifest(p, {
    resolved: new Map<string, ResolvedForManifest>(),
    derivedFromOf: () => null,
    allWarnings: [],
    allowUnaccepted: false,
    exportSignature: "sig-abc123",
    deliveryUpscale: null,
    deliverySubstitutions: new Map<string, Record<string, DeliverySubstitution>>(),
    frameDeliveryVariants: new Map<string, { address: string; variantId: string }>(),
    ...overrides,
  });
}

describe("buildManifest", () => {
  it("records an entry as an address/variant pointer, with no path to its own variant dir", () => {
    const manifest = build(
      plan([
        shot({
          resolvedVariants: { motion: "v-aaa" },
          resolvedFiles: {
            motion: variantFile("video:shot.01.motion", "v-aaa", "out.mp4"),
          },
        }),
      ]),
    );

    expect(ExportManifestSchema.parse(manifest)).toBeTruthy();
    // Fresh per render, not per job — a reclaimed export job renders into its own directory.
    expect(manifest.id).toMatch(/^mf-[0-9A-Za-z]{8}$/);
    expect(manifest.variants).toEqual({
      "video:shot.01.motion": { variantId: "v-aaa", accepted: true },
    });
  });

  it("names the patch a corrected variant came from — its script is `patches/<derivedFrom>.ts`", () => {
    const manifest = build(
      plan([shot({ resolvedVariants: { still: "v-bbb", patched: "v-ccc" } })]),
      { derivedFromOf: (_a, variantId) => (variantId === "v-ccc" ? "v-src" : null) },
    );

    expect(manifest.variants).toEqual({
      "video:shot.01.still": { variantId: "v-bbb", accepted: true },
      "video:shot.01.patched": { variantId: "v-ccc", accepted: true, derivedFrom: "v-src" },
    });
  });

  it("records konte's own leaves too — the shot's composition and its stem", () => {
    const manifest = build(
      plan([
        shot({
          resolvedVariants: { vo: "v-aaa", "#stem": "v-bbb", "#composition": "v-ccc" },
          resolvedFiles: { vo: variantFile("video:shot.01.vo", "v-aaa", "vo.mp3") },
        }),
      ]),
    );

    expect(Object.keys(manifest.variants)).toEqual([
      "video:shot.01#composition",
      "video:shot.01#stem",
      "video:shot.01.vo",
    ]);
  });

  it("records both halves of a substituted layer — its picture upscaled, its audio not", () => {
    const substitution: DeliverySubstitution = {
      absFile: variantFile("video:shot.01.motion#delivery", "v-up", "4k.mp4"),
      address: "video:shot.01.motion#delivery",
      variantId: "v-up",
    };
    const manifest = build(
      plan([
        shot({
          resolvedVariants: { motion: "v-aaa" },
          resolvedFiles: { motion: substitution.absFile },
        }),
      ]),
      {
        deliveryUpscale: "video",
        deliverySubstitutions: new Map([["01", { motion: substitution }]]),
      },
    );

    expect(manifest.deliveryUpscale).toBe("video");
    // The upscale has no place in the definition graph, so it is recorded beside its source.
    expect(manifest.variants).toEqual({
      "video:shot.01.motion": { variantId: "v-aaa", accepted: true },
      "video:shot.01.motion#delivery": { variantId: "v-up", accepted: true },
    });
  });

  it("adds the upscaled composite under frame delivery, over the layers it was made from", () => {
    const manifest = build(
      plan([
        shot({
          resolvedVariants: { motion: "v-aaa" },
          resolvedFiles: {
            motion: variantFile("video:shot.01.motion", "v-aaa", "out.mp4"),
          },
        }),
      ]),
      {
        deliveryUpscale: "frame",
        frameDeliveryVariants: new Map([
          ["01", { address: "video:shot.01#composition#delivery", variantId: "v-frame" }],
        ]),
      },
    );

    expect(Object.keys(manifest.variants)).toEqual([
      "video:shot.01#composition#delivery",
      "video:shot.01.motion",
    ]);
  });

  it("marks a variant that was not accepted at render time", () => {
    const manifest = build(
      plan([
        shot({
          resolvedVariants: { motion: "v-aaa" },
          resolvedFiles: {
            motion: variantFile("video:shot.01.motion", "v-aaa", "out.mp4"),
          },
          unacceptedAssets: ["video:shot.01.motion"],
        }),
      ]),
      { allowUnaccepted: true },
    );

    expect(manifest.allowUnaccepted).toBe(true);
    expect(manifest.variants["video:shot.01.motion"]!.accepted).toBe(false);
  });

  it("falls back to the plan's own timeline resolutions when the graph lists none", () => {
    const manifest = build(
      plan([shot()], {
        timelineResolvedVariants: { bgm: "v-bgm" },
        timelineResolvedFiles: { bgm: variantFile("video:timeline.bgm", "v-bgm", "bed.mp3") },
      }),
    );

    expect(manifest.variants).toEqual({
      "video:timeline.bgm": { variantId: "v-bgm", accepted: true },
    });
  });

  it("carries the render's warnings, which are appended up to the moment it is written", () => {
    const allWarnings: string[] = [];
    const manifest = build(plan([shot()]), { allWarnings });
    // Both delivery paths push the rough-cut line before committing, into the same array the
    // manifest holds.
    allWarnings.push("non-accepted: video:shot.01.motion");

    expect(manifest.warnings).toEqual(["non-accepted: video:shot.01.motion"]);
  });

  it("records what the graph resolved, across every stage", () => {
    const manifest = build(plan([shot()]), {
      resolved: new Map<string, ResolvedForManifest>([
        ["reference:bgm", { variantId: "v-bgm", accepted: true }],
        ["animatic:shot.01.first", { variantId: "v-board", accepted: true }],
      ]),
    });

    expect(manifest.variants).toEqual({
      "reference:bgm": { variantId: "v-bgm", accepted: true },
      "animatic:shot.01.first": { variantId: "v-board", accepted: true },
    });
  });
});
