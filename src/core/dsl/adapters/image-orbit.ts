import type { LocalAssetDefinition } from "../../types/index.js";
import { KonteError } from "../../errors.js";
import { orbitSize, type OrbitPose } from "../../image-orbit.js";
import type { MediaAsset } from "../builders.js";
import { getActiveFormat } from "../shot-context.js";
import { ASSET_SITES, type AssetAdapter } from "../adapter.js";

export type ImageOrbitInputs = {
  master: MediaAsset<"image">;
  yaw: number;
  pitch?: number;
  distance?: number;
  fovY?: number;
  width?: number;
  height?: number;
};

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${name} must be a number from ${min} to ${max}, got ${String(value)}`,
    );
  }
}

export const imageOrbit: AssetAdapter<ImageOrbitInputs, "image"> = {
  type: "image",
  meta: {
    backend: "local",
    allowedIn: ASSET_SITES,
    mediaType: "image",
    description:
      "MoGe depth render of a location master from another camera — the master's surfaces moved " +
      "to where that camera sees them, what the master never saw left flat grey. A rough layout " +
      "fed to an image model as the view it paints over. The camera turns around the room's " +
      "centre at eye height and faces it.",
    ref: "orbit",
    inputs: {
      master: { type: "image", required: true },
      yaw: {
        type: "number",
        required: true,
        description:
          "Degrees the camera turns from the master's, rightward: -90 on the left wall facing right, 90 the reverse, 180 facing the master's camera.",
      },
      pitch: {
        type: "number",
        required: false,
        default: 0,
        description: "Degrees above eye height, -90 to 90: 90 looks straight down.",
      },
      distance: {
        type: "number",
        required: false,
        default: 1,
        description:
          "How far out along that line, 1 the wall or ceiling it meets. Past 1 backs out of the room, what stands between cut away.",
      },
      fovY: {
        type: "number",
        required: false,
        default: 45,
        description: "Vertical field of view in degrees.",
      },
      width: {
        type: "number",
        required: false,
        computed: true,
        description: "Defaults to the canvas's aspect at about a megapixel.",
      },
      height: { type: "number", required: false, computed: true },
    },
  },
  createDefinition(inputs: ImageOrbitInputs): LocalAssetDefinition {
    const pose: OrbitPose = {
      yaw: inputs.yaw,
      pitch: inputs.pitch ?? 0,
      distance: inputs.distance ?? 1,
      fovY: inputs.fovY ?? 45,
    };
    assertRange("yaw", pose.yaw, -180, 180);
    assertRange("pitch", pose.pitch, -90, 90);
    assertRange("distance", pose.distance, 0.1, 10);
    assertRange("fovY", pose.fovY, 10, 120);
    const canvas = getActiveFormat()?.size;
    const width = inputs.width ?? (canvas && orbitSize(canvas).width);
    const height = inputs.height ?? (canvas && orbitSize(canvas).height);
    if (width === undefined || height === undefined) {
      throw new KonteError(
        "VALIDATION_FAILED",
        "imageOrbit needs a width and height. The stage this is declared in has no canvas to " +
          "take them from, so pass both.",
      );
    }
    for (const [name, value] of [
      ["width", width],
      ["height", height],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new KonteError(
          "VALIDATION_FAILED",
          `${name} must be an integer > 0 in pixels, got ${String(value)}`,
        );
      }
    }
    return {
      kind: "local",
      operation: "orbit",
      mediaType: "image",
      deterministic: true,
      inputs: { master: inputs.master.src, pose, width, height },
    };
  },
};
