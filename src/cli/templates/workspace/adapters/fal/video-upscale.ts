import { defineFalAsset } from "konte";

// Prebuilt video upscaler backed by fal.ai's `fal-ai/video-upscaler` (RealESRGAN), for
// `export.delivery.upscale.video`. konte injects the source `video` and a `scale`
// default (the delivery/working ratio, e.g. 1.5 for 720p→1080p) at export time — that one
// uniform factor upscales every layer to its exact delivery display size. The model takes a
// `scale` factor (1–8), so override via params if your delivery ratio is fractional and the
// model wants an integer (e.g. `params: { scale: 2 }`), or supply your own `defineFalAsset`.
//
// Schema verified against https://fal.ai/models/fal-ai/video-upscaler/api.
export const falVideoUpscale = defineFalAsset({
  endpointId: "fal-ai/video-upscaler",
  description:
    "RealESRGAN video upscaler by a scale factor — for export.delivery.upscale.video, not for authoring a shot.",
  mediaType: "video",
  inputs: {
    video: { field: "video_url", type: "video", required: true },
    scale: { field: "scale", type: "number", default: 2 },
  },
});
