import type { LocalAssetDefinition } from "../../types/index.js";
import type { MediaAsset } from "../builders.js";
import type { AssetAdapter } from "../adapter.js";
import { parseColorString } from "./local.js";

// konte's own fixture adapters, for the tests that have to drive an asset offline without a vendor.
// `internalTestImage` stands in for an AI asset whose accept/reroll cycle a test is about — every
// shipped `local` adapter is deterministic, so none of them can; `internalTestPlate` is the other
// half, konte's own take, and it is what carries the ffmpeg `blank` operation.
//
// Kept out of the workspace's surface entirely: outside the `adapters` namespace, which is what
// `konte adapter list` enumerates, and outside `template-entry.ts`, so the generated `.konte/mod.ts`
// never declares it. That leaves it importable at runtime and unknown to the workspace type-check,
// which is why a fixture importing it says `@ts-expect-error` over the line.
export type InternalTestImageInputs = {
  width: number;
  height: number;
  // Given, the output is that image resized; omitted, a blank canvas.
  image?: MediaAsset<"image">;
};

export const internalTestImage: AssetAdapter<InternalTestImageInputs, "image"> = {
  type: "image",
  meta: {
    backend: "local",
    mediaType: "image",
    description: "konte's own test fixture: a sized image, resized from `image` when one is given.",
    ref: "internal-test",
    inputs: {
      width: { type: "number", required: true },
      height: { type: "number", required: true },
      image: { type: "image", required: false },
    },
  },
  createDefinition(inputs: InternalTestImageInputs): LocalAssetDefinition {
    return inputs.image
      ? {
          kind: "local",
          operation: "resize",
          mediaType: "image",
          inputs: { image: inputs.image.src, width: inputs.width, height: inputs.height },
        }
      : {
          kind: "local",
          operation: "blank",
          mediaType: "image",
          inputs: { width: inputs.width, height: inputs.height, color: "#000000" },
        };
  },
};

export type InternalTestPlateInputs = {
  width: number;
  height: number;
  color?: string;
};

export const internalTestPlate: AssetAdapter<InternalTestPlateInputs, "image"> = {
  type: "image",
  meta: {
    backend: "local",
    mediaType: "image",
    description: "konte's own test fixture: a solid canvas konte accepts itself.",
    ref: "internal-test-plate",
    inputs: {
      width: { type: "number", required: true },
      height: { type: "number", required: true },
      color: { type: "string", required: false, default: "#000000" },
    },
  },
  createDefinition(inputs: InternalTestPlateInputs): LocalAssetDefinition {
    return {
      kind: "local",
      operation: "blank",
      mediaType: "image",
      deterministic: true,
      inputs: {
        width: inputs.width,
        height: inputs.height,
        color: parseColorString(inputs.color ?? "#000000"),
      },
    };
  },
};
