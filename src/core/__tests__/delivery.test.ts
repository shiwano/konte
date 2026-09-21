import { describe, expect, it } from "vitest";
import { computeDefinitionHash } from "../definition-hash.js";
import {
  computeDeliveryTarget,
  deliveryCoverSize,
  deliveryNeedsUpscaler,
  type DeliveryTarget,
  deliveryAddressIsValid,
  deliveryMode,
  deliveryPromptSubject,
  findFreshDeliveryVariant,
  synthesizeDeliveryAssetDefinition,
} from "../delivery.js";
import type { AssetAdapter } from "../dsl/adapter.js";
import { upscale } from "../dsl/delivery-upscale.js";
import { assertPinGate, pinWaiverKey } from "../pin-check.js";
import { assertPromptGate, promptWaiverKey } from "../prompt-check.js";
import type { DeliveryUpscaleFn, KonteState, VideoDefinition } from "../types/index.js";

// A minimal upscale adapter that records the injected source + scale + target dims.
const fakeUpscale: AssetAdapter<Record<string, unknown>, "video"> = {
  type: "video",
  meta: {
    backend: "fal",
    mediaType: "video",
    description: "test upscaler",
    ref: "fake/upscale",
    inputs: {},
  },
  createDefinition(inputs) {
    const video = inputs.video as { src: string };
    return {
      kind: "fal",
      endpointId: "fake/upscale",
      mediaType: "video",
      inputs: {
        video_url: video.src,
        scale: inputs.scale,
        width: inputs.width,
        height: inputs.height,
      },
    };
  },
};

// Default: a scale-based upscale fn. working 1280×720 → delivery 1920×1080 → auto scale 1.5.
function videoWithDelivery(videoFn?: DeliveryUpscaleFn): VideoDefinition {
  const fn: DeliveryUpscaleFn =
    videoFn ?? (({ video, scale }) => upscale(fakeUpscale, { video, scale }));
  return {
    stage: "video" as const,
    format: { size: { width: 1280, height: 720 }, fps: 24 },
    typography: { lang: "en" as const },
    export: { delivery: { size: { width: 1920, height: 1080 }, upscale: { video: fn } } },
    shots: [{ id: "01", duration: 3, assets: {} }],
  } as unknown as VideoDefinition;
}

// A video that upscales the whole frame (preset/absolute-style adapter).
function videoWithFrameDelivery(): VideoDefinition {
  const fn: DeliveryUpscaleFn = ({ video, width, height }) =>
    upscale(fakeUpscale, { video, width, height });
  return {
    stage: "video" as const,
    format: { size: { width: 1280, height: 720 }, fps: 24 },
    typography: { lang: "en" as const },
    export: { delivery: { size: { width: 1920, height: 1080 }, upscale: { frame: fn } } },
    shots: [{ id: "01", duration: 3, assets: {} }],
  } as unknown as VideoDefinition;
}

// A video with no delivery config at all.
function videoNoDelivery(): VideoDefinition {
  return {
    stage: "video" as const,
    format: { size: { width: 1280, height: 720 }, fps: 24 },
    typography: { lang: "en" as const },
    shots: [{ id: "01", duration: 3, assets: {} }],
  } as unknown as VideoDefinition;
}

const TARGET: DeliveryTarget = { scale: 1.5, width: 192, height: 192 };

describe("synthesizeDeliveryAssetDefinition", () => {
  it("calls the upscale fn with the injected source + scale, and marks it deterministic", () => {
    const def = synthesizeDeliveryAssetDefinition(
      videoWithDelivery(),
      "video:shot.01.motion#delivery",
      TARGET,
    );
    expect(def.kind).toBe("fal");
    if (def.kind !== "fal") throw new Error("unreachable");
    expect(def.inputs.video_url).toBe("__konte:video:shot.01.motion__");
    expect(def.inputs.scale).toBe(1.5);
    expect(def.deterministic).toBe(true);
  });

  it("passes the absolute target width/height to an absolute-dim upscaler", () => {
    const absFn: DeliveryUpscaleFn = ({ video, width, height }) =>
      upscale(fakeUpscale, { video, width, height });
    const def = synthesizeDeliveryAssetDefinition(
      videoWithDelivery(absFn),
      "video:shot.01.motion#delivery",
      TARGET,
    );
    if (def.kind !== "fal") throw new Error("unreachable");
    expect(def.inputs.width).toBe(192);
    expect(def.inputs.height).toBe(192);
  });

  it("throws when the address has no delivery suffix", () => {
    expect(() =>
      synthesizeDeliveryAssetDefinition(videoWithDelivery(), "video:shot.01.motion", TARGET),
    ).toThrow();
  });

  it("throws when there is no delivery.upscale.video configured", () => {
    expect(() =>
      synthesizeDeliveryAssetDefinition(
        videoWithFrameDelivery(),
        "video:shot.01.motion#delivery",
        TARGET,
      ),
    ).toThrow();
  });
});

describe("frame delivery mode", () => {
  it("detects frame mode from a composition delivery address, video mode otherwise", () => {
    expect(deliveryMode("video:shot.01#composition#delivery")).toBe("frame");
    expect(deliveryMode("video:shot.01.motion#delivery")).toBe("video");
  });

  it("synthesizes the frame upscale from the composition source at delivery dims", () => {
    const def = synthesizeDeliveryAssetDefinition(
      videoWithFrameDelivery(),
      "video:shot.01#composition#delivery",
      { scale: 1.5, width: 1920, height: 1080 },
    );
    if (def.kind !== "fal") throw new Error("unreachable");
    expect(def.inputs.video_url).toBe("__konte:video:shot.01#composition__");
    expect(def.inputs.width).toBe(1920);
    expect(def.inputs.height).toBe(1080);
  });

  it("validates a frame delivery whose composition source is valid", () => {
    const valid = new Set(["video:shot.01#composition"]);
    expect(
      deliveryAddressIsValid(videoWithFrameDelivery(), "video:shot.01#composition#delivery", valid),
    ).toBe(true);
  });

  it("rejects a frame delivery whose video has no upscale.frame", () => {
    const valid = new Set(["video:shot.01#composition"]);
    // videoWithDelivery() declares only upscale.video, not .frame
    expect(
      deliveryAddressIsValid(videoWithDelivery(), "video:shot.01#composition#delivery", valid),
    ).toBe(false);
  });
});

describe("computeDeliveryTarget", () => {
  const video = videoWithDelivery();

  it("per-layer: width/height = source size × scale (AR-preserving)", () => {
    const t = computeDeliveryTarget(video, "video", { width: 100, height: 100 });
    expect(t.scale).toBe(1.5);
    expect(t.width).toBe(150);
    expect(t.height).toBe(150);
  });

  it("frame: width/height = delivery size", () => {
    const t = computeDeliveryTarget(video, "frame", { width: 1280, height: 720 });
    expect(t.scale).toBe(1.5);
    expect(t.width).toBe(1920);
    expect(t.height).toBe(1080);
  });
});

describe("deliveryAddressIsValid", () => {
  const video = videoWithDelivery();
  const valid = new Set(["video:shot.01.motion"]);

  it("accepts a delivery address whose source is valid and the video declares delivery", () => {
    expect(deliveryAddressIsValid(video, "video:shot.01.motion#delivery", valid)).toBe(true);
  });

  it("rejects a delivery address whose video has no delivery config", () => {
    expect(deliveryAddressIsValid(videoNoDelivery(), "video:shot.01.motion#delivery", valid)).toBe(
      false,
    );
  });

  it("rejects a delivery address whose source is not a valid address", () => {
    expect(deliveryAddressIsValid(video, "video:shot.99.gone#delivery", valid)).toBe(false);
  });

  it("rejects a non-delivery address", () => {
    expect(deliveryAddressIsValid(video, "video:shot.01.motion", valid)).toBe(false);
  });
});

describe("findFreshDeliveryVariant", () => {
  const video = videoWithDelivery();
  const deliveryAddress = "video:shot.01.motion#delivery";
  const sourceAddress = "video:shot.01.motion";
  const defHash = computeDefinitionHash(
    synthesizeDeliveryAssetDefinition(video, deliveryAddress, TARGET),
  );

  function state(variant: Record<string, unknown>): KonteState {
    return {
      schemaVersion: 3,
      assets: {
        [deliveryAddress]: {
          variants: { "v-del1": variant },
          feedback: [],
        },
      },
    } as unknown as KonteState;
  }

  it("returns the variant when definition and source fingerprint both match", () => {
    const s = state({
      status: "accepted",
      file: "assets/x.mp4",
      definitionHash: defHash,
      deliveryTarget: TARGET,
      inputFingerprints: { "video:shot.01.motion": "srchash" },
    });
    expect(findFreshDeliveryVariant(s, video, deliveryAddress, sourceAddress, "srchash")).toEqual({
      variantId: "v-del1",
      file: "assets/x.mp4",
    });
  });

  it("returns null when the source fingerprint changed (input-stale)", () => {
    const s = state({
      status: "accepted",
      file: "assets/x.mp4",
      definitionHash: defHash,
      deliveryTarget: TARGET,
      inputFingerprints: { "video:shot.01.motion": "oldhash" },
    });
    expect(
      findFreshDeliveryVariant(s, video, deliveryAddress, sourceAddress, "srchash"),
    ).toBeNull();
  });

  it("returns null when the definition changed (definition-stale)", () => {
    const s = state({
      status: "accepted",
      file: "assets/x.mp4",
      definitionHash: "different",
      deliveryTarget: TARGET,
      inputFingerprints: { "video:shot.01.motion": "srchash" },
    });
    expect(
      findFreshDeliveryVariant(s, video, deliveryAddress, sourceAddress, "srchash"),
    ).toBeNull();
  });

  it("stays fresh using the variant's snapshotted target, not a re-derived one", () => {
    // An absolute-dim upscaler bakes the injected width/height into its definition, so the hash depends
    // on the target dims. The stored definitionHash was computed against an UNUSUAL target (an odd
    // source size × scale). A fresh probe at export would yield different dims, but the snapshot is
    // authoritative, so the variant must remain fresh — the regression guard for the export deadlock.
    const absVideo = videoWithDelivery(({ video: v, width, height }) =>
      upscale(fakeUpscale, { video: v, width, height }),
    );
    const oddTarget: DeliveryTarget = { scale: 1.5, width: 1337, height: 751 };
    const oddHash = computeDefinitionHash(
      synthesizeDeliveryAssetDefinition(absVideo, deliveryAddress, oddTarget),
    );
    const probedHash = computeDefinitionHash(
      synthesizeDeliveryAssetDefinition(absVideo, deliveryAddress, TARGET),
    );
    expect(oddHash).not.toBe(probedHash);
    const s = state({
      status: "accepted",
      file: "assets/x.mp4",
      definitionHash: oddHash,
      deliveryTarget: oddTarget,
      inputFingerprints: { "video:shot.01.motion": "srchash" },
    });
    expect(
      findFreshDeliveryVariant(s, absVideo, deliveryAddress, sourceAddress, "srchash"),
    ).toEqual({
      variantId: "v-del1",
      file: "assets/x.mp4",
    });
  });

  it("returns null when the variant has no snapshotted target (forces a rebuild)", () => {
    const s = state({
      status: "accepted",
      file: "assets/x.mp4",
      definitionHash: defHash,
      deliveryTarget: null,
      inputFingerprints: { "video:shot.01.motion": "srchash" },
    });
    expect(
      findFreshDeliveryVariant(s, video, deliveryAddress, sourceAddress, "srchash"),
    ).toBeNull();
  });
});

// A delivery upscale is the one generated asset declared outside `asset()`, so the stage's own
// collection never sees it.
describe("deliveryPromptSubject", () => {
  const promptUpscale: AssetAdapter<Record<string, unknown>, "video"> = {
    ...fakeUpscale,
    meta: {
      ...fakeUpscale.meta,
      inputs: { prompt: { type: "prompt", required: false } },
    },
  };

  function videoWithPromptUpscale(prompt: string, waivers?: Record<string, string>) {
    return {
      ...videoWithDelivery(({ video, scale }) => upscale(promptUpscale, { video, scale, prompt })),
      waivers,
    } as VideoDefinition;
  }

  it("collects the upscaler's prompt under the delivery address it is spent at", () => {
    const subject = deliveryPromptSubject(
      videoWithPromptUpscale("restore fine grain"),
      "video:shot.01.motion#delivery",
      TARGET,
    );
    expect(subject.prompts).toEqual([
      {
        address: "video:shot.01.motion#delivery",
        input: "prompt",
        value: "restore fine grain",
      },
    ]);
  });

  it("hands the gate a finding an export would otherwise spend on", () => {
    const subject = deliveryPromptSubject(
      videoWithPromptUpscale("sharpen, no artifacts"),
      "video:shot.01.motion#delivery",
      TARGET,
    );
    expect(() => assertPromptGate(subject, "video.tsx")).toThrow(/no artifacts/);
  });

  it("folds against the video stage's own waivers", () => {
    const key = promptWaiverKey("prompt-negation", "no artifacts");
    const subject = deliveryPromptSubject(
      videoWithPromptUpscale("sharpen, no artifacts", { [key]: "the upscaler's own vocabulary" }),
      "video:shot.01.motion#delivery",
      TARGET,
    );
    expect(() => assertPromptGate(subject, "video.tsx")).not.toThrow();
  });

  // The pin half of the same seam: an upscaler that pins a frame is spent on at export like any
  // other take, so the wiring is collected and gated here too.
  const pinUpscale: AssetAdapter<Record<string, unknown>, "video"> = {
    ...fakeUpscale,
    meta: {
      ...fakeUpscale.meta,
      inputs: { startImage: { type: "image", required: false, pin: "start" } },
    },
  };

  function videoWithPinUpscale(source: string, waivers?: Record<string, string>) {
    return {
      ...videoWithDelivery(({ video, scale }) =>
        upscale(pinUpscale, { video, scale, startImage: { src: `__konte:${source}__` } }),
      ),
      waivers,
    } as VideoDefinition;
  }

  it("collects the upscaler's pin under the delivery address it is spent at", () => {
    const subject = deliveryPromptSubject(
      videoWithPinUpscale("animatic:shot.01.first"),
      "video:shot.01.motion#delivery",
      TARGET,
    );
    expect(subject.pins).toEqual([
      {
        address: "video:shot.01.motion#delivery",
        input: "startImage",
        pin: "start",
        source: "animatic:shot.01.first",
      },
    ]);
  });

  it("hands the pin gate a finding an export would otherwise spend on", () => {
    const subject = deliveryPromptSubject(
      videoWithPinUpscale("reference:hero"),
      "video:shot.01.motion#delivery",
      TARGET,
    );
    expect(() => assertPinGate(subject, "video.tsx")).toThrow(/reference:hero/);
  });

  it("folds a pin finding against the video stage's own waivers", () => {
    const key = pinWaiverKey("pin-unanchored", "reference:hero");
    const subject = deliveryPromptSubject(
      videoWithPinUpscale("reference:hero", { [key]: "the delivery opens on the sheet" }),
      "video:shot.01.motion#delivery",
      TARGET,
    );
    expect(() => assertPinGate(subject, "video.tsx")).not.toThrow();
  });
});

// The two halves of closing the gap between the derived canvas and the delivery: scale to COVER the
// delivery, then cut the delivery frame from the centre of what covers it.
describe("delivery cover and crop", () => {
  // 1248×704 is what a 0.9 Mpx budget derives to against a 1920×1080 delivery.
  function videoAt(base: { width: number; height: number }): VideoDefinition {
    return {
      stage: "video" as const,
      format: { size: base, fps: 24 },
      typography: { lang: "en" as const },
      export: {
        delivery: {
          size: { width: 1920, height: 1080 },
          upscale: {
            video: (({ video, scale }) =>
              upscale(fakeUpscale, { video, scale })) as DeliveryUpscaleFn,
          },
        },
      },
      shots: [{ id: "01", duration: 3, assets: {} }],
    } as unknown as VideoDefinition;
  }

  it("covers the delivery on both axes, whichever one the canvas is short on", () => {
    // Narrower than 16:9 — height is the binding axis.
    const tall = deliveryCoverSize(videoAt({ width: 1248, height: 704 }));
    expect(tall.width).toBeGreaterThanOrEqual(1920);
    expect(tall.height).toBeGreaterThanOrEqual(1080);
    // Wider than 16:9 — width is the binding axis. Scaling by width alone would leave a gap.
    const wide = deliveryCoverSize(videoAt({ width: 1216, height: 672 }));
    expect(wide.width).toBeGreaterThanOrEqual(1920);
    expect(wide.height).toBeGreaterThanOrEqual(1080);
  });

  it("keeps the cover frame even — it is encoded before it is cropped", () => {
    for (const base of [
      { width: 1248, height: 704 },
      { width: 1216, height: 672 },
      { width: 1152, height: 640 },
    ]) {
      const cover = deliveryCoverSize(videoAt(base));
      expect(cover.width % 2).toBe(0);
      expect(cover.height % 2).toBe(0);
    }
  });

  it("overshoots by a sliver, not a reframe — the crop stays inside title-safe", () => {
    for (const base of [
      { width: 1248, height: 704 },
      { width: 1216, height: 672 },
      { width: 1152, height: 640 },
      { width: 1312, height: 736 },
    ]) {
      const cover = deliveryCoverSize(videoAt(base));
      expect(cover.width / 1920 - 1).toBeLessThan(0.03);
      expect(cover.height / 1080 - 1).toBeLessThan(0.03);
    }
  });

  // Frame delivery hands the whole composite to the upscaler and never re-composites, so its target
  // has to be the cover frame; the crop happens when the composites are stitched.
  it("targets the cover frame in frame mode, not the delivery frame", () => {
    const video = videoAt({ width: 1248, height: 704 });
    const cover = deliveryCoverSize(video);
    const target = computeDeliveryTarget(video, "frame", { width: 1248, height: 704 });
    expect({ width: target.width, height: target.height }).toEqual(cover);
  });

  // A layer that fills the canvas must land exactly on the frame it fills. Rounding each axis on its
  // own leaves it a pixel short of the stage, and on a dimension yuv420p cannot encode.
  it("targets the cover frame exactly in per-layer mode, on an even dimension", () => {
    const video = videoAt({ width: 1248, height: 704 });
    const target = computeDeliveryTarget(video, "video", { width: 1248, height: 704 });
    expect({ width: target.width, height: target.height }).toEqual(deliveryCoverSize(video));
    const half = computeDeliveryTarget(video, "video", { width: 624, height: 352 });
    expect(half.width % 2).toBe(0);
    expect(half.height % 2).toBe(0);
  });

  it("owes an upscaler for a real resolution increase, not for the grid gap", () => {
    expect(deliveryNeedsUpscaler(videoAt({ width: 1248, height: 704 }))).toBe(true);
    // A canvas already at the delivery's own resolution is short only by the grid step it rounded to.
    expect(deliveryNeedsUpscaler(videoAt({ width: 1888, height: 1056 }))).toBe(false);
  });
});
