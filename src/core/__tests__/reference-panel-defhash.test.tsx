import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineReference, defineAnimatic, asset, Composition, Panel } from "../dsl/index.js";
import { moves, shot, animaticTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection } from "./helpers/direction.js";
import { definitionHashForAddress } from "../composition-resource.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

// A reference-backed panel is addressed `reference:<name>`, whose definition lives in the
// reference stage, not the animatic. The animatic preview must hash such a panel against the
// reference definition to surface its definition-staleness — the animatic definition has no such
// address and yields null.
describe("reference panel def-hash selection", () => {
  it("the reference definition yields a hash where the animatic definition yields null", () => {
    const reference = defineReference(plainDirection, () => ({
      bg: asset("bg", imageComfy, { prompt: "background" }),
    }));
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } },
      }),
      {
        timeline: () =>
          animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Panel src={reference.bg} {...moves} />
                </Composition>
              ),
            }),
          ]),
      },
    );
    const addr = "reference:bg";
    expect(definitionHashForAddress(animatic, addr)).toBeNull();
    expect(definitionHashForAddress(reference, addr)).toEqual(expect.any(String));
  });
});
