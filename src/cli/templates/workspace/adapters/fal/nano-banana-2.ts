import { defineFalAsset } from "konte";

export const falNanoBanana2 = defineFalAsset({
  endpointId: "fal-ai/nano-banana-2",
  description:
    "Nano Banana 2 — generate a still from a prompt; fast iteration, strong multilingual text, real-world accuracy.",
  mediaType: "image",
  guide: "konte/guides/nano-banana-2.md",
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    aspectRatio: {
      field: "aspect_ratio",
      type: "string",
      default: "16:9",
      values: [
        "auto",
        "21:9",
        "16:9",
        "3:2",
        "4:3",
        "5:4",
        "1:1",
        "4:5",
        "3:4",
        "2:3",
        "9:16",
        "4:1",
        "1:4",
        "8:1",
        "1:8",
      ],
    },
    resolution: {
      field: "resolution",
      type: "string",
      default: "1K",
      values: ["0.5K", "1K", "2K", "4K"],
    },
    enableWebSearch: {
      field: "enable_web_search",
      type: "boolean",
      description: "Improves accuracy for brands, landmarks, and real-world subjects.",
    },
    safetyTolerance: {
      field: "safety_tolerance",
      type: "number",
      description: "Content-filtering level; higher tolerates more for creative requests.",
    },
    systemPrompt: {
      field: "system_prompt",
      type: "prompt",
      description:
        "Persistent instructions (e.g. style directives) kept separate from the main prompt.",
    },
    thinkingLevel: {
      field: "thinking_level",
      type: "string",
      values: ["minimal", "high"],
      description: "Reasoning depth applied before generating.",
    },
    seed: { field: "seed", type: "seed" },
    outputFormat: {
      field: "output_format",
      type: "string",
      default: "png",
      values: ["jpeg", "png", "webp"],
    },
  },
});

export const falNanoBanana2Edit = defineFalAsset({
  endpointId: "fal-ai/nano-banana-2/edit",
  description:
    "Nano Banana 2 Edit — controlled change to existing frame(s), preserving the rest; fast iteration, strong multilingual text.",
  mediaType: "image",
  guide: "konte/guides/nano-banana-2.md",
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    inputImage: {
      field: "image_urls",
      type: "image",
      required: true,
      array: true,
      description:
        "Reference frame(s) to edit — prompt for the delta, don't re-describe the whole scene.",
    },
    aspectRatio: {
      field: "aspect_ratio",
      type: "string",
      default: "auto",
      values: [
        "auto",
        "21:9",
        "16:9",
        "3:2",
        "4:3",
        "5:4",
        "1:1",
        "4:5",
        "3:4",
        "2:3",
        "9:16",
        "4:1",
        "1:4",
        "8:1",
        "1:8",
      ],
    },
    resolution: {
      field: "resolution",
      type: "string",
      default: "1K",
      values: ["0.5K", "1K", "2K", "4K"],
    },
    enableWebSearch: {
      field: "enable_web_search",
      type: "boolean",
      description: "Improves accuracy for brands, landmarks, and real-world subjects.",
    },
    safetyTolerance: {
      field: "safety_tolerance",
      type: "number",
      description: "Content-filtering level; higher tolerates more for creative requests.",
    },
    systemPrompt: {
      field: "system_prompt",
      type: "prompt",
      description:
        "Persistent instructions (e.g. style directives) kept separate from the main prompt.",
    },
    thinkingLevel: {
      field: "thinking_level",
      type: "string",
      values: ["minimal", "high"],
      description: "Reasoning depth applied before generating.",
    },
    seed: { field: "seed", type: "seed" },
    outputFormat: {
      field: "output_format",
      type: "string",
      default: "png",
      values: ["jpeg", "png", "webp"],
    },
  },
});
