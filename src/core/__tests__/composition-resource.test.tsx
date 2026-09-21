import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectDeadCompositionVariants,
  compositionCacheKey,
  compositionDefinitionHash,
  compositionDefinitionHashForAddress,
  compositionInputFingerprints,
  materializeCompositionVariant,
  unresolvedPictureRefs,
} from "../composition-resource.js";
import { compositionStructureHtml } from "../composition-builder.js";
import { Audio, Composition, Video } from "../dsl/composition/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineVideo, asset } from "../dsl/index.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { testDirection } from "./helpers/direction.js";
import { isAcceptedStale } from "../staleness.js";
import { StateManager } from "../state/index.js";
import type { ShotDefinition, VideoDefinition } from "../types/index.js";

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const audioComfy = defineComfyAsset({
  workflow: "audio.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const testVideo = defineVideo(
  testDirection({
    fps: 30,
    size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
  }),
  {
    timeline: () =>
      videoTimeline([
        shot("01", {
          duration: 5,
          build: () => {
            const motion = asset("motion", animateComfy, { prompt: "a cat" });
            return (
              <Composition>
                <Video src={motion} />
              </Composition>
            );
          },
        }),
      ]),
  },
);

// A shot whose definition carries no shotFn (fallback shot).
const fallbackVideo = (() => {
  const v = defineVideo(
    testDirection({
      fps: 30,
      size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
    }),
    {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const motion = asset("motion", animateComfy, { prompt: "a cat" });
              return (
                <Composition>
                  <Video src={motion} />
                </Composition>
              );
            },
          }),
        ]),
    },
  );
  (v.shots as ShotDefinition[]).push({
    id: "02",
    duration: 3,
    action: "test shot",
    assets: { bg: { kind: "comfy", workflow: "bg.json", inputs: {} } },
    compositionRefs: [],
  });
  return v;
})();

// A one-shot video whose picture (className), duration, size, and audio presence can each be
// varied independently — for asserting what the structural composition hash does and does not
// depend on.
function makeVideo(opts: {
  duration?: number;
  size?: { width: number; height: number };
  className?: string;
  withAudio?: boolean;
}): VideoDefinition {
  const { duration = 5, size = { width: 1024, height: 576 }, className, withAudio = false } = opts;
  return defineVideo(
    testDirection({
      fps: 30,
      size: { megapixels: (size.width * size.height) / 1e6, delivery: size },
    }),
    {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration,
            build: () => {
              const motion = asset("motion", animateComfy, { prompt: "a cat" });
              return (
                <Composition>
                  <Video src={motion} className={className} />
                  {withAudio ? (
                    <Audio
                      src={asset("bgm", audioComfy, { prompt: "music" })}
                      start={1}
                      volume={0.5}
                    />
                  ) : null}
                </Composition>
              );
            },
          }),
        ]),
    },
  );
}

let tmpDir: string;
let manager: StateManager;

function setupAccepted(address: string, file: string, outputHash?: string): string {
  const variantId = manager.reserveVariantId(address);
  const v = manager.getAssetState(address).variants![variantId]!;
  v.file = file;
  if (outputHash) v.outputHash = outputHash;
  manager.setAccepted(address, variantId);
  return variantId;
}

// A ready-but-unaccepted variant: has a file/output but was never accepted.
function setupReady(address: string, file: string, outputHash?: string): string {
  const variantId = manager.reserveVariantId(address);
  const v = manager.getAssetState(address).variants![variantId]!;
  v.file = file;
  if (outputHash) v.outputHash = outputHash;
  return variantId;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-comp-res-test-"));
  manager = await StateManager.init(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The composition hash is structural (rendered picture HTML), so it depends on the picture,
// duration and dimensions — and, deliberately, NOT on audio (which is muxed, never baked).
describe("compositionDefinitionHash", () => {
  const v = makeVideo({});

  it("is stable for identical inputs", () => {
    expect(compositionDefinitionHash(v, "01")).toBe(compositionDefinitionHash(v, "01"));
  });

  it("changes with duration and dimensions", () => {
    const h = compositionDefinitionHash(v, "01");
    expect(compositionDefinitionHash(makeVideo({ duration: 6 }), "01")).not.toBe(h);
    expect(
      compositionDefinitionHash(makeVideo({ size: { width: 1280, height: 576 } }), "01"),
    ).not.toBe(h);
    expect(
      compositionDefinitionHash(makeVideo({ size: { width: 1024, height: 640 } }), "01"),
    ).not.toBe(h);
  });

  it("changes with the shot's picture", () => {
    expect(compositionDefinitionHash(makeVideo({ className: "hero" }), "01")).not.toBe(
      compositionDefinitionHash(v, "01"),
    );
  });

  it("changes with the typography", () => {
    const h = compositionDefinitionHash(v, "01");
    expect(compositionDefinitionHash({ ...v, typography: { lang: "ja" } }, "01")).not.toBe(h);
    expect(
      compositionDefinitionHash({ ...v, typography: { ...v.typography, fonts: ["Nunito"] } }, "01"),
    ).not.toBe(h);
  });

  it("hashes the body only, not konte's document head", () => {
    const html = compositionStructureHtml(v, "01");
    expect(html).not.toContain("<head");
    expect(html).not.toContain("<script");
  });

  it("ignores audio — adding an <Audio> does not change the hash", () => {
    expect(compositionDefinitionHash(makeVideo({ withAudio: true }), "01")).toBe(
      compositionDefinitionHash(v, "01"),
    );
  });

  it("returns '' for an unknown shot", () => {
    expect(compositionDefinitionHash(v, "99")).toBe("");
  });
});

describe("per-definition discovery caching", () => {
  // Uncached, every per-shot hash re-ran the whole timeline callback (all N shots) to pick out
  // one, so an all-shots sweep was O(N²) timeline executions. One run per loaded definition
  // serves every shot's hash, and repeat hashes hit the per-definition memo.
  it("runs the timeline callback once across per-shot hash computations", () => {
    let runs = 0;
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          runs++;
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Video src={asset("motion", animateComfy, { prompt: "a" })} />
                </Composition>
              ),
            }),
            shot("02", {
              duration: 3,
              build: () => (
                <Composition>
                  <Video src={asset("motion", animateComfy, { prompt: "b" })} />
                </Composition>
              ),
            }),
          ]);
        },
      },
    );
    const baseline = runs;
    const h1 = compositionDefinitionHash(video, "01");
    const h2 = compositionDefinitionHash(video, "02");
    expect(h1).not.toBe("");
    expect(h2).not.toBe("");
    expect(h2).not.toBe(h1);
    expect(compositionDefinitionHash(video, "01")).toBe(h1);
    expect(runs).toBe(baseline + 1);
  });
});

describe("compositionInputFingerprints", () => {
  it("records each ref's resolved variant outputHash", () => {
    setupAccepted("video:shot.01.motion", "f.mp4", "hash-motion");
    expect(compositionInputFingerprints(manager, ["video:shot.01.motion"])).toEqual({
      "video:shot.01.motion": "hash-motion",
    });
  });

  it("records a ready-but-unaccepted variant's outputHash (resolved bar)", () => {
    setupReady("video:shot.01.motion", "f.mp4", "ready-hash");
    expect(compositionInputFingerprints(manager, ["video:shot.01.motion"])).toEqual({
      "video:shot.01.motion": "ready-hash",
    });
  });

  it("skips refs with no ready variant or no outputHash", () => {
    setupAccepted("video:shot.01.motion", "f.mp4"); // accepted but no outputHash
    expect(
      compositionInputFingerprints(manager, ["video:shot.01.motion", "video:shot.99.missing"]),
    ).toEqual({});
  });
});

describe("materializeCompositionVariant", () => {
  it("mints a variant, writes the html artifact, and records hashes", async () => {
    setupAccepted("video:shot.01.motion", "assets/m/output.mp4", "hash-motion");

    const variantId = await materializeCompositionVariant({
      manager,
      video: testVideo,
      shotId: "01",
    });
    expect(variantId).toBeTruthy();

    const comp = manager.getAssetState("video:shot.01#composition");
    const v = comp.variants![variantId!]!;
    expect(v.file).toMatch(/composition\.html$/);
    expect(v.definitionHash).toBeTruthy();
    expect(v.outputHash).toBeTruthy();
    expect(v.inputFingerprints).toEqual({ "video:shot.01.motion": "hash-motion" });

    const html = await fs.readFile(path.join(tmpDir, v.file!), "utf-8");
    expect(html).toContain("konte://asset");
    expect(html).not.toMatch(/https?:\/\/localhost/);
  });

  // The live variant is the one the current definition + resolved inputs would keep; every other
  // unaccepted one is a leftover `clean`/`prune` may drop.
  it("collects an unaccepted variant the current inputs no longer keep", async () => {
    setupAccepted("video:shot.01.motion", "assets/m/output.mp4", "hash-motion");
    const stale = await materializeCompositionVariant({ manager, video: testVideo, shotId: "01" });
    setupAccepted("video:shot.01.motion", "assets/m/output2.mp4", "hash-motion-2");
    const live = await materializeCompositionVariant({ manager, video: testVideo, shotId: "01" });

    expect(collectDeadCompositionVariants(manager, testVideo)).toEqual([
      { address: "video:shot.01#composition", variantId: stale },
    ]);

    // An accepted one is the signed-off baseline, kept for re-review — so with the older take
    // accepted, neither is collectable: one is the baseline, the other is what the definition keeps.
    manager.setAccepted("video:shot.01#composition", stale!);
    expect(collectDeadCompositionVariants(manager, testVideo)).toEqual([]);
    expect(live).not.toBe(stale);
  });

  it("is idempotent when definition and inputs are unchanged", async () => {
    setupAccepted("video:shot.01.motion", "assets/m/output.mp4", "hash-motion");

    const id1 = await materializeCompositionVariant({
      manager,
      video: testVideo,
      shotId: "01",
    });
    const id2 = await materializeCompositionVariant({
      manager,
      video: testVideo,
      shotId: "01",
    });

    expect(id2).toBe(id1);
    const comp = manager.getAssetState("video:shot.01#composition");
    expect(Object.keys(comp.variants!)).toHaveLength(1);
  });

  it("mints a new variant when an upstream accepted output changes", async () => {
    setupAccepted("video:shot.01.motion", "assets/m/v1.mp4", "hash-motion-1");
    const id1 = await materializeCompositionVariant({
      manager,
      video: testVideo,
      shotId: "01",
    });

    // A new motion variant is accepted with a different output.
    setupAccepted("video:shot.01.motion", "assets/m/v2.mp4", "hash-motion-2");
    const id2 = await materializeCompositionVariant({
      manager,
      video: testVideo,
      shotId: "01",
    });

    expect(id2).not.toBe(id1);
    const comp = manager.getAssetState("video:shot.01#composition");
    expect(Object.keys(comp.variants!)).toHaveLength(2);
    expect(comp.variants![id2!]!.inputFingerprints).toEqual({
      "video:shot.01.motion": "hash-motion-2",
    });
  });

  it("returns null for a shot without a composition (no shotFn)", async () => {
    const id = await materializeCompositionVariant({
      manager,
      video: fallbackVideo,
      shotId: "02",
    });
    expect(id).toBeNull();
  });
});

describe("composition accept end-to-end (UC1)", () => {
  const compAddress = "video:shot.01#composition";

  it("an accepted composition goes stale when an upstream asset is re-accepted", async () => {
    // Accept: motion accepted, then composition materialized + accepted.
    setupAccepted("video:shot.01.motion", "assets/m/v1.mp4", "motion-1");
    const compId = await materializeCompositionVariant({
      manager,
      video: testVideo,
      shotId: "01",
    });
    manager.setAccepted(compAddress, compId!);

    const defHash = compositionDefinitionHashForAddress(testVideo, compAddress);
    // Freshly accepted: not stale.
    expect(isAcceptedStale(manager, compAddress, defHash)).toBe(false);

    // motion is regenerated and a new variant accepted with a different output.
    setupAccepted("video:shot.01.motion", "assets/m/v2.mp4", "motion-2");

    // The accepted composition is now stale → it needs re-review (UC1).
    expect(isAcceptedStale(manager, compAddress, defHash)).toBe(true);

    // Re-accepting mints a fresh composition variant against motion-2.
    const compId2 = await materializeCompositionVariant({
      manager,
      video: testVideo,
      shotId: "01",
    });
    expect(compId2).not.toBe(compId);
    manager.setAccepted(compAddress, compId2!);
    expect(isAcceptedStale(manager, compAddress, defHash)).toBe(false);
  });
});

describe("compositionCacheKey", () => {
  it("returns null for a fallback shot with no resolvable source", () => {
    // shot "02"'s only asset (bg) has no ready variant, so nothing renders.
    expect(compositionCacheKey(manager, fallbackVideo, "02")).toBeNull();
  });

  it("is stable, and changes when an upstream input changes", () => {
    setupAccepted("video:shot.01.motion", "f.mp4", "hash-1");
    const k1 = compositionCacheKey(manager, testVideo, "01");
    expect(k1).not.toBeNull();
    expect(compositionCacheKey(manager, testVideo, "01")).toBe(k1);

    // A change to the consumed layer's accepted output flips the cache key.
    setupAccepted("video:shot.01.motion", "f2.mp4", "hash-2");
    expect(compositionCacheKey(manager, testVideo, "01")).not.toBe(k1);
  });

  it("reflects a timelineFn override only when it changes the shot's picture", () => {
    setupAccepted("video:shot.01.motion", "f.mp4", "hash-1");
    const base = compositionCacheKey(manager, testVideo, "01");

    // An override that re-renders shot 01 with a different picture flips the key (the structural
    // definition hash captures the override's effect on the picture).
    const withOverride = {
      ...testVideo,
      timelineFn: (() => ({
        shots: [
          {
            id: "01",
            fn: () => (
              <Composition>
                <Video src={{ src: "__konte:video:shot.01.motion__" }} className="hero" />
              </Composition>
            ),
          },
        ],
        soundtracks: [],
      })) as VideoDefinition["timelineFn"],
    };
    const kOverride = compositionCacheKey(manager, withOverride, "01");
    expect(kOverride).not.toBe(base);
    expect(compositionCacheKey(manager, withOverride, "01")).toBe(kOverride);

    // An override that renders the same picture (differing only in audio/soundtracks) does not.
    const samePicture = {
      ...testVideo,
      timelineFn: (() => ({
        shots: [{ id: "01", fn: testVideo.shots[0]!.shotFn! }],
        soundtracks: [
          { __soundtrackEntry: true, id: "bed", src: { src: "x" }, options: { duck: false } },
        ],
      })) as VideoDefinition["timelineFn"],
    };
    expect(compositionCacheKey(manager, samePicture, "01")).toBe(base);
  });

  it("keys a fallback shot on its resolved source, stable and source-sensitive", () => {
    setupAccepted("video:shot.02.bg", "bg.mp4", "bg-1");
    const k1 = compositionCacheKey(manager, fallbackVideo, "02");
    expect(k1).not.toBeNull();
    expect(compositionCacheKey(manager, fallbackVideo, "02")).toBe(k1);

    // A different shotFn-vs-fallback shot never collides on key shape.
    expect(k1).not.toBe(compositionCacheKey(manager, testVideo, "01"));

    // A change to the fallback source flips the key.
    setupAccepted("video:shot.02.bg", "bg2.mp4", "bg-2");
    expect(compositionCacheKey(manager, fallbackVideo, "02")).not.toBe(k1);
  });

  it("falls back to compositionRefs when a shotFn shot lacks pictureRefs (no recursion)", () => {
    setupAccepted("video:shot.01.motion", "f.mp4", "hash-1");
    // A raw-literal shape carries no discovery-time ref partition; pictureRefsOf must fall back
    // to compositionRefs rather than recurse into itself.
    const rawLiteral = {
      ...testVideo,
      shots: testVideo.shots.map((s) => ({ ...s, pictureRefs: undefined, stemRefs: undefined })),
    } as VideoDefinition;
    expect(() => compositionCacheKey(manager, rawLiteral, "01")).not.toThrow();
    expect(compositionCacheKey(manager, rawLiteral, "01")).not.toBeNull();
  });
});

// The layers a read surface leaves blank, which `probe contact-sheet` names beside the sheet. Audio
// is never one of them.
describe("unresolvedPictureRefs", () => {
  const withAudio = makeVideo({ withAudio: true });
  const shotOf = (v: VideoDefinition) => v.shots[0]!;

  it("ignores an audio take that resolves to nothing", () => {
    setupAccepted("video:shot.01.motion", "assets/motion.mp4", "motion-1");

    expect(unresolvedPictureRefs(manager, shotOf(withAudio))).toEqual([]);
  });

  it("names the picture layer that resolves to nothing", () => {
    expect(unresolvedPictureRefs(manager, shotOf(withAudio))).toEqual(["video:shot.01.motion"]);
  });
});
