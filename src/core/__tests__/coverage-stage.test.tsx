import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { Composition, Panel, asset, defineAnimatic, defineDirection } from "../dsl/index.js";
import { directionPartHashes } from "../direction-hash.js";
import type { Direction } from "../dsl/direction.js";
import { directionDefaults } from "./helpers/direction.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test image adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const shots = (coverage: boolean) =>
  [
    {
      id: "01",
      role: "ordinary",
      action: "They clash. She lands.",
      setup: "front",
      duration: 6,
      lineup: [],
      ...(coverage ? { coverage: true as const } : {}),
    },
  ] as const;

const direction = defineDirection({
  ...directionDefaults,
  sequence: { lens: "mini-drama", pleasure: "cute", shots: shots(true) },
});

describe("a coverage shot on the board", () => {
  it("is boarded on its opening frame", () => {
    defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("opening", imageComfy, { prompt: "a desk" })} />
          </Composition>
        )),
      }),
    });
  });

  it("refuses a second panel", () => {
    expect(() =>
      defineAnimatic(direction, {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("opening", imageComfy, { prompt: "a desk" })} />
              <Panel src={asset("landing", imageComfy, { prompt: "a desk" })} />
            </Composition>
          )),
        }),
      }),
    ).toThrow(expect.objectContaining({ code: "ANIMATIC_INVALID" }));
  });
});

describe("a coverage shot's part", () => {
  const of = (coverage: boolean) =>
    directionPartHashes({
      ...directionDefaults,
      sequence: { lens: "mini-drama", pleasure: "cute", shots: shots(coverage) },
    } as unknown as Direction);

  it("moves the shot and the sequence when a shot becomes coverage", () => {
    const before = of(false);
    const after = of(true);
    for (const part of ["direction:sequence", "direction:sequence.shots.01"]) {
      expect(after.get(part)).toBeDefined();
      expect(after.get(part)).not.toBe(before.get(part));
    }
  });
});
