import { describe, expect, it } from "vitest";
import {
  formatReferenceAddress,
  formatReferenceAssetPath,
  listExposedReferenceAssetPaths,
  listReferenceAddresses,
  listReferenceAssetPaths,
  listReviewableAssetPaths,
  parseAddress,
} from "../address.js";
import { matchesAddressScope } from "../address.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { audioFile, imageFile, videoFile } from "../dsl/adapters/index.js";
import { asset, defineReference, defineVideo } from "../dsl/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection, directionDefaults } from "./helpers/direction.js";
import { defineDirection } from "../dsl/direction.js";
import { KonteError } from "../errors.js";
import { buildDependencyGraph } from "../graph.js";
import { JobIndex } from "../job-index.js";
import { describePendingJob } from "../pending-jobs.js";
import type { GenerationJob } from "../types/index.js";
import type { KonteState } from "../types/index.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const imageGen = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const compose = defineComfyAsset({
  workflow: "compose.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
    image: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const animate = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
    background: { nodeId: "1", field: "bg", type: "video" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// A reference definition mixing a file asset (bgm) with a generative one (character).
const reference = defineReference(plainDirection, () => {
  const bgm = asset("bgm", audioFile, { path: "assets/files/bgm.mp3" });
  const character = asset("character", imageGen, { prompt: "a girl" });
  return { bgm, character };
});

describe("defineReference(plainDirection, ) builder", () => {
  it("declares assets under the reference stage as topLevelAssets", () => {
    expect(reference.topLevelAssets!.bgm!.kind).toBe("file");
    expect(reference.topLevelAssets!.character!.kind).toBe("comfy");
    expect(reference.shots).toEqual([]);
  });

  it("exposes each returned name as a reference placeholder MediaAsset", () => {
    expect(reference.bgm.src).toContain("reference:bgm");
    expect(reference.character.src).toContain("reference:character");
  });

  it("rejects an asset returned under a reserved name", () => {
    expect(() =>
      defineReference(plainDirection, () => {
        const shots = asset("shots", imageGen, { prompt: "x" });
        return { shots };
      }),
    ).toThrow("reserved name");
  });

  it("rejects a returned name that was not declared via asset()", () => {
    expect(() =>
      defineReference(plainDirection, () => {
        const a = asset("a", imageGen, { prompt: "x" });
        return { a, b: a };
      }),
    ).toThrow();
  });

  it("allows a declared asset consumed as an input without returning it", () => {
    const ref = defineReference(plainDirection, () => {
      const latent = asset("latent", imageGen, { prompt: "blank" });
      const key = asset("key", compose, { prompt: "scene", image: latent });
      return { key };
    });

    // `latent` is generatable (in topLevelAssets) and consumed by `key`, but not exposed on
    // the ref surface (no `reference.latent`). `exposedAssetNames` records only what was
    // returned — the usage roots `generate`/`doctor` resolve against.
    expect(ref.topLevelAssets?.latent).toBeDefined();
    expect(ref.topLevelAssets?.key).toBeDefined();
    expect((ref as unknown as Record<string, unknown>).latent).toBeUndefined();
    expect(ref.key.src).toContain("reference:key");
    expect(ref.exposedAssetNames).toEqual(["key"]);
  });

  // A declared-but-orphaned asset no longer fails the load; it is reported as unused by
  // `generate`/`doctor` instead (covered by the CLI E2E suite), mirroring video/animatic.
  it("does not throw for a declared asset that is neither returned nor consumed", () => {
    const ref = defineReference(plainDirection, () => {
      const key = asset("key", imageGen, { prompt: "scene" });
      asset("orphan", imageGen, { prompt: "unused" });
      return { key };
    });
    expect(ref.topLevelAssets?.orphan).toBeDefined();
    expect(ref.exposedAssetNames).toEqual(["key"]);
  });
});

describe("reference address helpers", () => {
  it("formats a reference asset path and address", () => {
    expect(formatReferenceAssetPath("bgm")).toBe("reference:bgm");
    expect(formatReferenceAddress("bgm")).toBe("reference:bgm");
  });

  it("lists a reference definition's asset paths and addresses", () => {
    expect(new Set(listReferenceAssetPaths(reference))).toEqual(
      new Set(["reference:bgm", "reference:character"]),
    );
    expect(new Set(listReferenceAddresses(reference))).toEqual(
      new Set(["reference:bgm", "reference:character"]),
    );
  });

  // An intermediate (declared, never returned) is generated and tracked, but is not review work:
  // the review surfaces list the exposed pool only.
  it("lists only the exposed assets as review targets", () => {
    const ref = defineReference(plainDirection, () => {
      const latent = asset("latent", imageGen, { prompt: "blank" });
      const key = asset("key", compose, { prompt: "scene", image: latent });
      return { key };
    });

    expect(listReferenceAssetPaths(ref)).toEqual(["reference:latent", "reference:key"]);
    expect(listExposedReferenceAssetPaths(ref)).toEqual(["reference:key"]);
    expect(listReviewableAssetPaths(ref, "reference")).toEqual(["reference:key"]);
  });

  it("keeps an exposed deterministic asset in the review listing", () => {
    expect(listExposedReferenceAssetPaths(reference)).toEqual([
      "reference:bgm",
      "reference:character",
    ]);
    expect(listReviewableAssetPaths(reference, "reference")).toEqual([
      "reference:bgm",
      "reference:character",
    ]);
  });

  it("parseAddress round-trips a reference address", () => {
    expect(parseAddress("reference:bgm")).toEqual({
      stage: "reference",
      kind: "reference",
      assetName: "bgm",
      delivery: false,
    });
  });
});

describe("matchesAddressScope (reference)", () => {
  it("matches a reference asset against its stage and asset scopes", () => {
    expect(matchesAddressScope("reference:bgm", "reference")).toBe(true);
    expect(matchesAddressScope("reference:bgm", "reference:bgm")).toBe(true);
  });

  it("does not match a different asset or stage", () => {
    expect(matchesAddressScope("reference:bgm", "reference:other")).toBe(false);
    expect(matchesAddressScope("reference:bgm", "video")).toBe(false);
  });
});

describe("buildDependencyGraph (reference purity)", () => {
  it("rejects a reference asset that depends on a per-profile (video) asset", () => {
    const v = defineVideo(
      testDirection({
        fps: 16,
        size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } },
      }),
      {
        timeline: () => {
          asset("base", imageGen, { prompt: "x" }); // per-profile video timeline asset
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("m", imageGen, { prompt: "z" });
                return el();
              },
            }),
          ]);
        },
      },
    );
    const ref = defineReference(plainDirection, () => {
      const bad = asset("bad", imageGen, { prompt: "y" });
      return { bad };
    });
    // A reference asset reaching a video asset is illegal — references are an upstream root.
    (ref.topLevelAssets!.bad as { inputs: Record<string, unknown> }).inputs.image =
      "__konte:video:timeline.base__";

    let code: string | undefined;
    expect(() => {
      try {
        buildDependencyGraph(v, undefined, ref);
      } catch (e) {
        code = e instanceof KonteError ? e.code : undefined;
        throw e;
      }
    }).toThrow();
    expect(code).toBe("INVALID_REFERENCE_DEPENDENCY");
  });

  it("allows a video asset to depend on a reference asset", () => {
    const ref = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });
    const v = defineVideo(
      testDirection({
        fps: 16,
        size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("m", animate, { prompt: "z", background: ref.bg });
                return el();
              },
            }),
          ]),
      },
    );
    expect(() => buildDependencyGraph(v, undefined, ref)).not.toThrow();
  });

  it("allows a reference asset to depend on another reference asset", () => {
    const ref = defineReference(plainDirection, () => {
      const plate = asset("plate", imageFile, { path: "assets/files/plate.png" }); // file
      const gen = asset("gen", compose, { prompt: "a", image: plate }); // reference → reference file
      return { plate, gen };
    });
    const v = defineVideo(
      testDirection({
        fps: 16,
        size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("m", imageGen, { prompt: "z" });
                return el();
              },
            }),
          ]),
      },
    );
    expect(() => buildDependencyGraph(v, undefined, ref)).not.toThrow();
  });
});

describe("describePendingJob (reference dependency)", () => {
  const pendingJob = (dependsOnAssets: string[], profile: string): GenerationJob =>
    ({ dependsOnAssets, profile, dependsOnJobs: [], metadata: {} }) as unknown as GenerationJob;

  it("treats a reference dependency as satisfied via its address", () => {
    const state: KonteState = {
      schemaVersion: 3,
      assets: {
        "reference:bgm": {
          variants: {
            v: {
              status: "accepted",
              file: "b.mp3",
              definitionHash: null,
              outputHash: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              inputFingerprints: {},
              metadata: {},
            },
          },
        },
      },
    };
    expect(
      describePendingJob(pendingJob(["reference:bgm"], "main"), state, new JobIndex([])),
    ).toEqual({
      submittable: true,
    });
  });

  it("waits on the address when the reference dep has no file", () => {
    const state: KonteState = {
      schemaVersion: 3,
      assets: { "reference:bgm": { variants: {} } },
    };
    expect(
      describePendingJob(pendingJob(["reference:bgm"], "main"), state, new JobIndex([])),
    ).toEqual({
      submittable: false,
      waitingOn: ["reference:bgm"],
    });
  });
});

// The canvas every sheet is sized off: `plainDirection`'s 0.589824 MP at 16:9 derives a 1024×576
// base, so its long edge is 1024.
describe("reference canvas", () => {
  const sized = defineComfyAsset({
    workflow: "sized.json",
    description: "test adapter",
    inputs: {
      prompt: { nodeId: "3", field: "text", type: "string" },
      width: { nodeId: "5", field: "width", type: "width", default: 512 },
      height: { nodeId: "5", field: "height", type: "height", default: 512 },
    },
    outputs: { result: { nodeId: "9", type: "image" } },
  });

  const rostered = defineDirection({
    ...directionDefaults,
    characters: { hana: { name: "Hana", description: "the traveller", promptDepiction: "hana" } },
    props: { katana: { name: "the katana", description: "a plain blade" } },
    sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
  });

  const sizesOf = (assets: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(assets).map(([name, def]) => {
        const inputs = (def as { inputs: Record<string, number> }).inputs;
        return [name, [inputs["5.width"], inputs["5.height"]]];
      }),
    );

  it("stands a character sheet up, widens a location into a master, squares everything else", () => {
    const def = defineReference(rostered, () => {
      const hana = asset("hana", sized, { prompt: "the traveller" });
      const katana = asset("katana", sized, { prompt: "a plain blade" });
      const studio = asset("studio", sized, { prompt: "the room" });
      const look = asset("look", sized, { prompt: "the world under this light" });
      return { hana, katana, studio, look };
    });

    expect(sizesOf(def.topLevelAssets ?? {})).toEqual({
      hana: [672, 1024],
      katana: [1024, 1024],
      // A location is the master a plate is cut out of: 2:1, twice the canvas' long edge.
      studio: [2048, 1024],
      // Outside every roster — a look proof, a shared bed — squares like a prop.
      look: [1024, 1024],
    });
  });

  // The base derivation transposes, so the long edge — and every sheet off it — is the same number
  // whichever way the piece is turned.
  it("sizes off the long edge, so a turned canvas resolves the same", () => {
    const portrait = defineDirection({
      ...directionDefaults,
      characters: { hana: { name: "Hana", description: "the traveller", promptDepiction: "hana" } },
      policy: {
        ...directionDefaults.policy,
        format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 576, height: 1024 } } },
      },
      sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
    });

    const def = defineReference(portrait, () => {
      const hana = asset("hana", sized, { prompt: "the traveller" });
      return { hana };
    });

    expect(sizesOf(def.topLevelAssets ?? {})).toEqual({ hana: [672, 1024] });
  });

  // The master is the one shape that follows the canvas' orientation: a window cut for a vertical
  // frame needs the headroom on the vertical axis.
  it("turns the master with the canvas", () => {
    const portrait = defineDirection({
      ...directionDefaults,
      policy: {
        ...directionDefaults.policy,
        format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 576, height: 1024 } } },
      },
      sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
    });

    const def = defineReference(portrait, () => {
      const studio = asset("studio", sized, { prompt: "the room" });
      return { studio };
    });

    expect(sizesOf(def.topLevelAssets ?? {})).toEqual({ studio: [1024, 2048] });
  });

  it("takes a declared size over the derived one", () => {
    const def = defineReference(rostered, () => {
      const hana = asset("hana", sized, { prompt: "the traveller", width: 768, height: 768 });
      return { hana };
    });

    expect(sizesOf(def.topLevelAssets ?? {})).toEqual({ hana: [768, 768] });
  });
});
