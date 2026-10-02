import { describe, expect, it } from "vitest";
import { defineFalAsset } from "../dsl/fal-asset.js";
import { asset } from "../dsl/adapter.js";
import { Composition } from "../dsl/composition/composition.js";
import { runInDiscoveryMode } from "../dsl/shot-context.js";
import type { FalAssetDefinition } from "../types/index.js";

const candidates = defineFalAsset({
  endpointId: "fal-ai/candidates",
  description: "test adapter",
  mediaType: "video",
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    duration: {
      field: "duration",
      type: "seconds",
      default: "auto",
      values: ["auto", "4", "5", "6"],
    },
  },
});

const whole = defineFalAsset({
  endpointId: "fal-ai/whole",
  description: "test adapter",
  mediaType: "video",
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    duration: { field: "duration", type: "seconds", default: 5, min: 5, max: 15 },
  },
});

// The definition an adapter builds inside a shot of `duration` seconds.
function inShot(duration: number, build: () => void): FalAssetDefinition {
  const { assets } = runInDiscoveryMode(
    "video",
    "01",
    () => {
      build();
      return <Composition />;
    },
    { size: { width: 1024, height: 576 }, fps: 24, duration },
  );
  return Object.values(assets)[0] as FalAssetDefinition;
}

describe("a seconds input", () => {
  it("raises the shot to the shortest candidate that holds it", () => {
    const def = inShot(4.5, () => asset("take", candidates, { prompt: "a walk" }));
    expect(def.inputs.duration).toBe("5");
  });

  it("takes a candidate a frame-aligned span sits a hair under", () => {
    const def = inShot(95 / 24 + 1 / 240, () => asset("take", candidates, { prompt: "a walk" }));
    expect(def.inputs.duration).toBe("4");
  });

  it("refuses a shot longer than every candidate", () => {
    expect(() => inShot(6.5, () => asset("take", candidates, { prompt: "a walk" }))).toThrow(
      /no length that holds the 6.5s shot — the longest this model takes is 6s/,
    );
  });

  it("is whole seconds without candidates, raised to the floor", () => {
    expect(inShot(2, () => asset("take", whole, { prompt: "a walk" })).inputs.duration).toBe(5);
    expect(inShot(7.25, () => asset("take", whole, { prompt: "a walk" })).inputs.duration).toBe(8);
  });

  it("refuses a length past the ceiling", () => {
    expect(() => inShot(15.5, () => asset("take", whole, { prompt: "a walk" }))).toThrow(
      /resolves to 16s for the 15.5s shot, past this model's maximum of 15s/,
    );
  });

  it("keeps what the caller passes", () => {
    const def = inShot(4.5, () => asset("take", candidates, { prompt: "a walk", duration: "6" }));
    expect(def.inputs.duration).toBe("6");
  });

  it("falls back to its default outside a shot", () => {
    expect(
      (candidates.createDefinition({ prompt: "a walk" }) as FalAssetDefinition).inputs,
    ).toEqual({
      prompt: "a walk",
      duration: "auto",
    });
  });
});
