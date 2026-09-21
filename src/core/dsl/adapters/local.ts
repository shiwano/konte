import { z } from "zod";
import { MAX_RETIME_RATE } from "../../audio-retime.js";
import type { LocalAssetDefinition } from "../../types/index.js";
import { KonteError } from "../../errors.js";
import type { MediaAsset } from "../builders.js";
import { getActiveFormat } from "../shot-context.js";
import type { AssetAdapter } from "../adapter.js";

export type ColorString = `#${string}`;

const ColorStringSchema = z
  .string()
  .regex(
    /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    "color must be a 3-, 4-, 6-, or 8-digit hex string like #RGB, #RGBA, #RRGGBB, or #RRGGBBAA",
  );

// The one hex form `jsxImage` accepts, validated where it is declared.
export function parseColorString(color: string): ColorString {
  const parsed = ColorStringSchema.safeParse(color);
  if (!parsed.success) {
    throw new KonteError("VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "invalid color");
  }
  return parsed.data as ColorString;
}

export type ImageResizeInputs = {
  image: MediaAsset<"image">;
  width: number;
  height: number;
};

export type TrimInputs<T extends "video" | "audio"> = {
  source: MediaAsset<T>;
  start: number;
  duration: number;
};

export const imageResize: AssetAdapter<ImageResizeInputs, "image"> = {
  type: "image",
  meta: {
    backend: "local",
    mediaType: "image",
    description:
      "ffmpeg resize of an existing image to an exact size — pins a ComfyUI workflow's output size by sizing its input.",
    ref: "resize",
    inputs: {
      image: { type: "image", required: true },
      width: { type: "number", required: true },
      height: { type: "number", required: true },
    },
  },
  createDefinition(inputs: ImageResizeInputs): LocalAssetDefinition {
    return {
      kind: "local",
      operation: "resize",
      mediaType: "image",
      deterministic: true,
      inputs: {
        image: inputs.image.src,
        width: inputs.width,
        height: inputs.height,
      },
    };
  },
};

export type ImageCropInputs = {
  image: MediaAsset<"image">;
  x: number;
  y: number;
  width: number;
  height: number;
  outWidth?: number;
  outHeight?: number;
};

function assertCropGeometry(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${name} must be an integer ${minimum === 0 ? ">= 0" : "> 0"} in source pixels, got ${String(value)}`,
    );
  }
}

export const imageCrop: AssetAdapter<ImageCropInputs, "image"> = {
  type: "image",
  meta: {
    backend: "local",
    mediaType: "image",
    description:
      "ffmpeg crop of a window out of an existing image, scaled to the working canvas — the setups " +
      "of one camera position cut from a single master, so what two of them share is pixel-identical.",
    ref: "crop",
    guide: "konte/guides/image-crop.md",
    inputs: {
      image: { type: "image", required: true },
      x: {
        type: "number",
        required: true,
        description: "Left edge of the window, in source pixels.",
      },
      y: {
        type: "number",
        required: true,
        description: "Top edge of the window, in source pixels.",
      },
      width: { type: "number", required: true, description: "Window width in source pixels." },
      height: { type: "number", required: true, description: "Window height in source pixels." },
      outWidth: { type: "number", required: false, computed: true },
      outHeight: { type: "number", required: false, computed: true },
    },
  },
  createDefinition(inputs: ImageCropInputs): LocalAssetDefinition {
    assertCropGeometry("x", inputs.x, 0);
    assertCropGeometry("y", inputs.y, 0);
    assertCropGeometry("width", inputs.width, 1);
    assertCropGeometry("height", inputs.height, 1);

    const format = getActiveFormat();
    const outWidth = inputs.outWidth ?? format?.size.width;
    const outHeight = inputs.outHeight ?? format?.size.height;
    if (outWidth === undefined || outHeight === undefined) {
      throw new KonteError(
        "VALIDATION_FAILED",
        "imageCrop needs an outWidth and outHeight. The stage this is declared in has no canvas " +
          "to take them from, so pass both.",
      );
    }
    assertCropGeometry("outWidth", outWidth, 1);
    assertCropGeometry("outHeight", outHeight, 1);

    return {
      kind: "local",
      operation: "crop",
      mediaType: "image",
      deterministic: true,
      inputs: {
        image: inputs.image.src,
        x: inputs.x,
        y: inputs.y,
        width: inputs.width,
        height: inputs.height,
        outWidth,
        outHeight,
      },
    };
  },
};

function createTrimAdapter<T extends "video" | "audio">(
  mediaType: T,
): AssetAdapter<TrimInputs<T>, T> {
  return {
    type: mediaType,
    meta: {
      backend: "local",
      mediaType,
      description: `ffmpeg trim of an existing ${mediaType} to a start/duration window.`,
      ref: "trim",
      inputs: {
        source: { type: mediaType, required: true },
        start: { type: "number", required: true },
        duration: { type: "number", required: true },
      },
    },
    createDefinition(inputs: TrimInputs<T>): LocalAssetDefinition {
      return {
        kind: "local",
        operation: "trim",
        mediaType,
        deterministic: true,
        inputs: { source: inputs.source.src, start: inputs.start, duration: inputs.duration },
      };
    },
  };
}

export const videoTrim = createTrimAdapter("video");
export const audioTrim = createTrimAdapter("audio");

export type AudioRetimeInputs = {
  source: MediaAsset<"audio">;
  duration: number;
  waiver?: string;
};

const RETIME_PERCENT = Math.round((MAX_RETIME_RATE - 1) * 100);

export const audioRetime: AssetAdapter<AudioRetimeInputs, "audio"> = {
  type: "audio",
  meta: {
    backend: "local",
    mediaType: "audio",
    description:
      "ffmpeg tempo change of an existing audio take to an exact duration, pitch left alone — " +
      "fits a voice take into the room a shot gives it without losing the words a trim would cut. " +
      `Past ±${RETIME_PERCENT}% of the take it needs a \`waiver\`.`,
    ref: "retime",
    inputs: {
      source: { type: "audio", required: true },
      duration: {
        type: "number",
        required: true,
        description: "Target length in seconds — the room the take has, not the shot's duration.",
      },
      waiver: {
        type: "string",
        required: false,
        description: `Why this take may run past ±${RETIME_PERCENT}%. Without it the job fails.`,
      },
    },
  },
  createDefinition(inputs: AudioRetimeInputs): LocalAssetDefinition {
    if (!Number.isFinite(inputs.duration) || inputs.duration <= 0) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `duration must be a positive number of seconds, got ${String(inputs.duration)}`,
      );
    }
    return {
      kind: "local",
      operation: "retime",
      mediaType: "audio",
      deterministic: true,
      inputs: {
        source: inputs.source.src,
        duration: inputs.duration,
        ...(inputs.waiver === undefined ? {} : { waiver: inputs.waiver }),
      },
    };
  },
};

export type VideoFrameInputs = {
  source: MediaAsset<"video">;
  at?: number | "last";
};

export const videoFrame: AssetAdapter<VideoFrameInputs, "image"> = {
  type: "image",
  meta: {
    backend: "local",
    mediaType: "image",
    description:
      "ffmpeg extraction of one frame from a video — the seam image a next motion segment is conditioned on, to run a take past a model's maximum duration.",
    ref: "frame",
    guide: "konte/guides/video-frame.md",
    inputs: {
      source: { type: "video", required: true },
      at: { type: "number", required: false, default: "last" },
    },
  },
  createDefinition(inputs: VideoFrameInputs): LocalAssetDefinition {
    const at = inputs.at ?? "last";
    if (at !== "last" && (!Number.isFinite(at) || at < 0)) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `at must be a non-negative number of seconds or "last", got ${String(at)}`,
      );
    }
    return {
      kind: "local",
      operation: "frame",
      mediaType: "image",
      deterministic: true,
      inputs: { source: inputs.source.src, at },
    };
  },
};
