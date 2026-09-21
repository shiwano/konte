import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  analyzeWorkflow,
  collectClassTypes,
  extractHiddenSubgraphInputs,
  generateAdapterCode,
} from "../src/cli/commands/comfy.js";
import { ComfyUIHttpClient } from "../src/comfyui/http-client.js";
import { ComfyUIManagerClient } from "../src/comfyui/manager-client.js";
import { convertLitegraphToApi } from "../src/comfyui/convert.js";
import type { LitegraphWorkflow } from "../src/comfyui/convert.js";
import type { ComfyUINode, ComfyUINodeDefinition, ComfyUIWorkflow } from "../src/comfyui/types.js";

const ROOT = path.resolve(import.meta.dirname, "..");
// Every workflow the generator reads, as committed litegraph JSON, one directory per origin — an
// upstream one copied out of its clone, a hand-authored one written there directly. Committing
// them is what makes an upstream revision reviewable as a diff, and what lets a re-emit run
// without re-fetching.
const WORKFLOW_DIR = path.join(ROOT, "workflows");
// Clones backing the git sources: derived, gitignored, and never read after vendoring.
const CLONE_DIR = path.join(ROOT, "vendor/comfy/.clones");
const OUTPUT_DIR = path.join(ROOT, "src/cli/templates/workspace/adapters/comfy");

const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8000";

type GitSource = {
  // Directory under `WORKFLOW_DIR` the copies (and the upstream LICENSE) land in.
  dir: string;
  // The provenance label (host + path) is derived from `gitUrl`, so the host is explicit for any
  // forge (github.com, gitlab.com, huggingface.co, …), and so is the clone directory.
  gitUrl: string;
  license: string;
  // Path in the repo → output name, which is also the vendored filename. The sparse-checkout is
  // derived from the keys. A list derives several adapters from one template, vendored once under
  // the first name.
  map: Record<string, string | readonly [string, ...string[]]>;
};

const GIT_SOURCES: ReadonlyArray<GitSource> = [
  {
    dir: "comfy",
    gitUrl: "https://github.com/Comfy-Org/workflow_templates.git",
    license: "MIT License",
    map: {
      "templates/image_z_image.json": "image_z_image_base",
      "templates/video_minimax_h3_r2v.json": "video_minimax_h3_r2v",
      "templates/image_qwen_image_2_1_image_edit.json": [
        "image_qwen_image_edit_2_1",
        "image_qwen_image_edit_2_1_inpaint",
      ],
      "templates/image_krea2_turbo_t2i_int8.json": "image_krea2_turbo_t2i",
      "templates/utility_seedvr2_video_upscale.json": "video_seedvr2_upscale",
      "templates/audio_ace_step1_5_xl_turbo.json": "audio_ace_step1_5_xl_turbo",
      "templates/audio_stable_audio_3_medium.json": "audio_stable_audio_3_medium",
      "templates/audio_minimax_music_3.json": "audio_minimax_music_3",
    },
  },
];

// Workflows with no upstream — authored by hand under `WORKFLOW_DIR/konte`, so vendoring only
// checks that the file is there.
const LOCAL_DIR = "konte";
const LOCAL_WORKFLOWS: ReadonlyArray<string> = [
  // The style-reference template with its LoRA and its FluxKontextMultiReferenceLatentMethod
  // taken out — the pair that make the reference a style source.
  "image_krea2_turbo_reference",
  "image_minimax_h3_r2i",
  "audio_minimax_h3_r2a",
  "audio_zonos2_voice_clone",
];

function sourceLabel(gitUrl: string): string {
  return gitUrl.replace(/^[a-z]+:\/\//, "").replace(/\.git$/, "");
}

// Next id above every existing one, matching how `flattenSubgraphs` allocates. Deriving
// it rather than hardcoding keeps a patch from silently overwriting a node the upstream
// template grows into that slot.
function freeNodeId(workflow: ComfyUIWorkflow): string {
  const ids = Object.keys(workflow).map(Number);
  if (ids.some(Number.isNaN)) throw new Error("Expected numeric node ids");
  return String(Math.max(...ids) + 1);
}

// Mechanical edits to an upstream workflow, applied to the converted API form (a flat
// `Record<id, {class_type, inputs}>`) — far easier to write than the litegraph link
// rewiring, and the API form is what ships. Keyed by output name.
//
// These are generator code, like `generateAdapterCode` — `source-hash` does not cover
// them, so editing one and re-running reports "unchanged, skipping". Delete the target
// `.ts` to force a re-emit.
const PATCHES: Record<string, (workflow: ComfyUIWorkflow) => void> = {
  image_qwen_image_edit_2_1: (workflow) => {
    addQwenImage21Reference(workflow);
    useLiteralLatentSize(workflow, "EmptyLatentImage", 1280, 736);
    const latent = Object.entries(workflow).find(
      ([, node]) => node.class_type === "EmptyLatentImage",
    )!;
    const samplers = Object.values(workflow).filter((node) => node.class_type === "KSampler");
    if (samplers.length !== 1) throw new Error("Expected one KSampler");
    samplers[0]!.inputs.latent_image = [latent[0], 0];
    pruneUnreachable(workflow);
  },
  image_qwen_image_edit_2_1_inpaint: (workflow) => {
    addQwenImage21Reference(workflow);
    useInpaintCropAndStitch(workflow);
    pruneUnreachable(workflow);
  }, // The template sizes the latent from a ResolutionSelector (aspect ratio + megapixels); konte
  // renders at the video's canvas, so drive width/height directly instead.
  image_z_image_base: (workflow) => {
    useLiteralLatentSize(workflow);
  },
  // The Krea-2 template runs the authored prompt through an LLM expansion and appends a style
  // LoRA's trigger word, each behind a switch, and sizes the latent from a ResolutionSelector.
  // konte's prompts are checked as written and it renders at the video's canvas, so the text and
  // the size become literals and the sampler reads the loader directly.
  image_krea2_turbo_t2i: (workflow) => {
    useLiteralPromptText(workflow);
    useUnswitchedModel(workflow);
    useLiteralLatentSize(workflow, "EmptyLatentImage");
    pruneUnreachable(workflow);
  },
  // Both higher encoder slots are wired here: with no LoRA holding the references to one job,
  // each is the author's to assign in the prompt.
  image_krea2_turbo_reference: (workflow) => {
    useLiteralPromptText(workflow, "TextEncodeQwenImageEditPlus", "prompt");
    useLiteralSizes(workflow);
    addReferenceImage(workflow, "image2", 1);
    addReferenceImage(workflow, "image3", 1);
    pruneUnreachable(workflow);
  },
  video_minimax_h3_r2v: (workflow) => {
    useLiteralH3Inputs(workflow);
    // Nine reference images, three reference clips, each clip's own soundtrack and three
    // standalone audios, of which the template wires two images. Each gets its own loader, so an
    // omitted one is pruned out of the graph entirely — which is also why they must be filled from
    // 1 upward with no gaps: the model numbers `<Picture N>` / `<Video N>` / `<Audio N>` by the
    // order the surviving references are wired, not by slot.
    for (let i = 0; i < 9; i++) wireH3Slot(workflow, `ref_images.ref_image_${i}`, LOAD_IMAGE);
    for (let i = 0; i < 3; i++) wireH3VideoSlot(workflow, i);
    for (let i = 0; i < 3; i++) wireH3Slot(workflow, `ref_audios.ref_audio_${i}`, LOAD_AUDIO);
    wireH3Guides(workflow);
    // Last, so the ids every pass above allocated stay where the committed graph has them.
    for (let i = 0; i < 3; i++) {
      wireH3Slot(workflow, `ref_video_audios.ref_video_audio_${i}`, LOAD_VIDEO_AUDIO);
    }
    useTurboSamplerSchedule(workflow);
  },
};

// TextEncodeQwenImageEditPlus takes image1..image3; the upstream template leaves the higher
// slots unwired. Add a LoadImage and feed it to `slot` on every encoder — a graph that encodes
// its negative branch too must see the same reference set on both.
function addReferenceImage(
  workflow: ComfyUIWorkflow,
  slot: "image2" | "image3",
  encoderCount: number,
): void {
  const encoders = Object.values(workflow).filter(
    (node) => node.class_type === "TextEncodeQwenImageEditPlus",
  );
  if (encoders.length !== encoderCount) {
    throw new Error(
      `Expected ${encoderCount} TextEncodeQwenImageEditPlus nodes, found ${encoders.length}`,
    );
  }
  // Unconnected optional slots survive conversion as an explicit null; only a link means the
  // template already wired this reference, in which case overwriting it would be silent breakage.
  for (const encoder of encoders) {
    if (Array.isArray(encoder.inputs[slot])) {
      throw new Error(`Encoder ${slot} is already wired; refusing to overwrite`);
    }
  }
  const loadImageId = freeNodeId(workflow);
  workflow[loadImageId] = { class_type: "LoadImage", inputs: { image: "example.png" } };
  for (const encoder of encoders) {
    encoder.inputs[slot] = [loadImageId, 0];
  }
}

// Replace an empty latent's linked width/height with literals, so the size lands as an adapter
// input. Whatever computed them is deleted once nothing else reads it.
function useLiteralLatentSize(
  workflow: ComfyUIWorkflow,
  classType = "EmptySD3LatentImage",
  width = 1280,
  height = 720,
): void {
  const latents = Object.entries(workflow).filter(
    ([, node]) =>
      node.class_type === classType &&
      Array.isArray(node.inputs.width) &&
      Array.isArray(node.inputs.height),
  );
  if (latents.length !== 1) {
    throw new Error(`Expected exactly one linked-size empty latent, found ${latents.length}`);
  }
  const latent = latents[0]![1];
  const sourceIds = new Set([
    (latent.inputs.width as [string, number])[0],
    (latent.inputs.height as [string, number])[0],
  ]);
  latent.inputs.width = width;
  latent.inputs.height = height;

  for (const sourceId of sourceIds) {
    const stillUsed = Object.values(workflow).some((node) =>
      Object.values(node.inputs).some((value) => Array.isArray(value) && value[0] === sourceId),
    );
    if (!stillUsed) delete workflow[sourceId];
  }
}

// Cut the encoder's text loose from whatever computed it, so the prompt lands as an adapter input.
function useLiteralPromptText(
  workflow: ComfyUIWorkflow,
  classType = "CLIPTextEncode",
  field = "text",
): void {
  const encoders = Object.values(workflow).filter(
    (node) => node.class_type === classType && Array.isArray(node.inputs[field]),
  );
  if (encoders.length !== 1) {
    throw new Error(`Expected exactly one linked-${field} ${classType}, found ${encoders.length}`);
  }
  encoders[0]!.inputs[field] = "";
}

// Retype every linked width/height in the graph to literals, for a template that sizes more than
// one node off a shared selector. What computed them is left to `pruneUnreachable`, and the
// surviving pairs become one adapter input each — collapsed into one with `also` by hand.
function useLiteralSizes(workflow: ComfyUIWorkflow, width = 1280, height = 720): void {
  const sized = Object.values(workflow).filter(
    (node) => Array.isArray(node.inputs.width) && Array.isArray(node.inputs.height),
  );
  if (sized.length === 0) throw new Error("Expected at least one linked width/height pair");
  for (const node of sized) {
    node.inputs.width = width;
    node.inputs.height = height;
  }
}

// Read the sampler's model from the off branch of the ComfySwitchNode in front of it, leaving
// whatever the on branch adds (a LoRA) out of the graph.
function useUnswitchedModel(workflow: ComfyUIWorkflow): void {
  const samplers = Object.values(workflow).filter(
    (node) => node.class_type === "KSampler" && Array.isArray(node.inputs.model),
  );
  if (samplers.length !== 1) {
    throw new Error(`Expected exactly one KSampler, found ${samplers.length}`);
  }
  const sampler = samplers[0]!;
  const switchId = (sampler.inputs.model as [string, number])[0];
  const switchNode = workflow[switchId];
  if (switchNode?.class_type !== "ComfySwitchNode") {
    throw new Error(
      `Expected a ComfySwitchNode on KSampler.model, found ${switchNode?.class_type}`,
    );
  }
  const offBranch = switchNode.inputs.on_false;
  if (!Array.isArray(offBranch)) {
    throw new Error("Expected the model switch's on_false to be linked");
  }
  sampler.inputs.model = offBranch;
}

// The template's turbo switch swaps the model and the step count but keeps the base sampler and
// schedule; the turbo LoRA is trained on euler/simple at its own 4 steps. Switch the sampler and
// the sigmas instead, the turbo schedule computed on the LoRA model, so `steps` feeds only the
// base schedule.
function useTurboSamplerSchedule(workflow: ComfyUIWorkflow): void {
  const [, sampler] = onlyNode(workflow, "SamplerCustomAdvanced");
  const [, scheduler] = onlyNode(workflow, "BasicScheduler");
  const [loraId] = onlyNode(workflow, "LoraLoaderModelOnly");
  const switchId = (scheduler.inputs.steps as [string, number])[0];
  const stepsSwitch = workflow[switchId];
  if (stepsSwitch?.class_type !== "ComfySwitchNode") {
    throw new Error(
      `Expected a ComfySwitchNode on BasicScheduler.steps, found ${stepsSwitch?.class_type}`,
    );
  }
  scheduler.inputs.steps = stepsSwitch.inputs.on_false;

  const turboScheduleId = freeNodeId(workflow);
  workflow[turboScheduleId] = {
    class_type: "BasicScheduler",
    inputs: { scheduler: "simple", steps: 4, denoise: 1, model: [loraId, 0] },
  };
  stepsSwitch.inputs.on_false = sampler.inputs.sigmas;
  stepsSwitch.inputs.on_true = [turboScheduleId, 0];
  sampler.inputs.sigmas = [switchId, 0];

  const turboSamplerId = freeNodeId(workflow);
  workflow[turboSamplerId] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
  const samplerSwitchId = freeNodeId(workflow);
  workflow[samplerSwitchId] = {
    class_type: "ComfySwitchNode",
    inputs: {
      on_false: sampler.inputs.sampler,
      on_true: [turboSamplerId, 0],
      switch: stepsSwitch.inputs.switch,
    },
  };
  sampler.inputs.sampler = [samplerSwitchId, 0];
  pruneUnreachable(workflow);
}

function onlyNode(workflow: ComfyUIWorkflow, classType: string): [string, ComfyUINode] {
  const found = Object.entries(workflow).filter(([, node]) => node.class_type === classType);
  if (found.length !== 1) throw new Error(`Expected one ${classType}, found ${found.length}`);
  return found[0]!;
}

function addQwenImage21Reference(workflow: ComfyUIWorkflow): void {
  const encoders = Object.values(workflow).filter(
    (node) => node.class_type === "TextEncodeQwenImage21",
  );
  if (encoders.length !== 1) throw new Error("Expected one TextEncodeQwenImage21");
  if (Array.isArray(encoders[0]!.inputs["images.image_3"])) {
    throw new Error("Encoder image_3 is already wired; refusing to overwrite");
  }
  const id = freeNodeId(workflow);
  workflow[id] = { class_type: "LoadImage", inputs: { image: "example.png" } };
  encoders[0]!.inputs["images.image_3"] = [id, 0];
}

// Redraw a ~1MP crop and composite it at source size; pixels beyond the feathered margin stay exact.
//
// The crop is the region plus a thin margin: the model composes for the whole crop it is shown, so a
// wide neighbourhood sizes a new element past the mask, and the margin's held latent anchors the
// redrawn tone at the seam. The feather falls off inside that margin — GrowMask and ImageBlur both
// read past the crop's edge as more of the edge, so a feather reaching it never gets to zero.
function useInpaintCropAndStitch(workflow: ComfyUIWorkflow): void {
  const only = (classType: string): [string, ComfyUINode] => {
    const found = Object.entries(workflow).filter(([, node]) => node.class_type === classType);
    if (found.length !== 1) {
      throw new Error(`Expected exactly one ${classType}, found ${found.length}`);
    }
    return found[0]!;
  };
  const add = (class_type: string, inputs: ComfyUINode["inputs"]): [string, number] => {
    const id = freeNodeId(workflow);
    workflow[id] = { class_type, inputs };
    return [id, 0];
  };
  const math = (
    expression: string,
    values: Record<string, [string, number] | number>,
  ): [string, number] => {
    const [id] = add("ComfyMathExpression", {
      expression,
      ...Object.fromEntries(Object.entries(values).map(([k, v]) => [`values.${k}`, v])),
    });
    // ComfyMathExpression outputs FLOAT, INT, BOOLEAN.
    return [id, 1];
  };

  const [, encoder] = only("TextEncodeQwenImage21");
  const source = encoder.inputs["images.image_1"] as [string, number];
  add("VAEEncode", { pixels: source, vae: encoder.inputs.vae });
  const [encodeId, encode] = only("VAEEncode");
  const [, sampler] = only("KSampler");
  const [decodeId] = only("VAEDecode");
  const [, save] = only("SaveImageAdvanced");

  const size = add("GetImageSize", { image: source });
  const imageW: [string, number] = [size[0], 0];
  const imageH: [string, number] = [size[0], 1];
  // The region's edges as fractions of image 1.
  const left = add("PrimitiveFloat", { value: 0.25 });
  const top = add("PrimitiveFloat", { value: 0.25 });
  const right = add("PrimitiveFloat", { value: 0.75 });
  const bottom = add("PrimitiveFloat", { value: 0.75 });
  // A fraction that lands on a whole pixel comes back a hair above it in floating point, so a ceil
  // would widen the region by a pixel.
  const x = math("round(a * e)", { a: left, e: imageW });
  const y = math("round(a * e)", { a: top, e: imageH });
  const w = math("max(1, round(b * e) - round(a * e))", { a: left, b: right, e: imageW });
  const h = math("max(1, round(b * e) - round(a * e))", { a: top, b: bottom, e: imageH });

  const margin = math("max(16, ceil(min(a, b) * 0.12))", { a: w, b: h });
  const cropX = math("max(0, a - m)", { a: x, m: margin });
  const cropY = math("max(0, a - m)", { a: y, m: margin });
  const cropW = math("min(e, a + c + m) - max(0, a - m)", { a: x, c: w, e: imageW, m: margin });
  const cropH = math("min(e, a + c + m) - max(0, a - m)", { a: y, c: h, e: imageH, m: margin });
  // Sized so the grow and the blur's tail fall off within the margin.
  const sigma = math("max(1, min(10, a / 3.5))", { a: margin });
  const sigmaFloat: [string, number] = [sigma[0], 0];
  // Match the encoder's reference grid; 2.1 reads this pre-scaled crop with resolution 0.
  const workW = math("round(a * sqrt(1048576 / (a * b)) / 32) * 32", {
    a: cropW,
    b: cropH,
  });
  const workH = math("round(b * sqrt(1048576 / (a * b)) / 32) * 32", {
    a: cropW,
    b: cropH,
  });
  const maskX = math("a - b", { a: x, b: cropX });
  const maskY = math("a - b", { a: y, b: cropY });

  const rect = add("MaskComposite", {
    destination: add("SolidMask", { value: 0, width: cropW, height: cropH }),
    source: add("SolidMask", { value: 1, width: w, height: h }),
    x: maskX,
    y: maskY,
    operation: "add",
  });
  const grown = add("GrowMask", {
    mask: rect,
    expand: math("ceil(a)", { a: sigmaFloat }),
    tapered_corners: true,
  });
  const blurred = add("ImageBlur", {
    image: add("MaskToImage", { mask: grown }),
    blur_radius: math("min(31, ceil(a * 3))", { a: sigmaFloat }),
    sigma: sigmaFloat,
  });
  const mask = add("ImageToMask", { image: blurred, channel: "red" });

  const crop = add("ImageCrop", { image: source, width: cropW, height: cropH, x: cropX, y: cropY });
  const work = add("ImageScale", {
    image: crop,
    upscale_method: "lanczos",
    width: workW,
    height: workH,
    crop: "disabled",
  });
  encoder.inputs["images.image_1"] = work;
  encoder.inputs.resolution = 0;

  encode.inputs.pixels = work;
  sampler.inputs.latent_image = add("SetLatentNoiseMask", { samples: [encodeId, 0], mask });
  const restored = add("ImageScale", {
    image: [decodeId, 0],
    upscale_method: "lanczos",
    width: cropW,
    height: cropH,
    crop: "disabled",
  });
  save.inputs.images = add("ImageCompositeMasked", {
    destination: source,
    source: restored,
    x: cropX,
    y: cropY,
    resize_source: false,
    mask,
  });
}

const LOAD_IMAGE = { classType: "LoadImage", field: "image", value: "example.png" } as const;
const LOAD_AUDIO = { classType: "LoadAudio", field: "audio", value: "example.mp3" } as const;
// A clip's soundtrack, on a loader of its own so the picture can be passed without it. ComfyUI's
// LoadAudio takes a video container, so the slot is handed the clip itself.
const LOAD_VIDEO_AUDIO = { classType: "LoadAudio", field: "audio", value: "example.mp4" } as const;

function minimaxH3Node(workflow: ComfyUIWorkflow): ComfyUINode {
  const nodes = Object.values(workflow).filter(
    (node) => node.class_type === "MiniMaxH3ReferenceToVideo",
  );
  if (nodes.length !== 1) {
    throw new Error(`Expected exactly one MiniMax H3 node, found ${nodes.length}`);
  }
  return nodes[0]!;
}

// The H3 template sizes the canvas from a ResolutionSelector, feeds the prompt in from a primitive,
// and derives the frame count from a `duration → 17k+5` math chain. konte renders at the video's
// canvas and knows the shot's duration, so all four become literals the adapter drives directly.
function useLiteralH3Inputs(workflow: ComfyUIWorkflow): void {
  const node = minimaxH3Node(workflow);
  node.inputs.prompt = "";
  node.inputs.width = 1344;
  node.inputs.height = 768;
  node.inputs.length = 124;
  pruneUnreachable(workflow);
}

// Give one of the H3 node's reference slots its own loader. Already-wired slots are left alone.
function wireH3Slot(
  workflow: ComfyUIWorkflow,
  key: string,
  loader: { classType: string; field: string; value: string },
): void {
  const node = minimaxH3Node(workflow);
  if (Array.isArray(node.inputs[key])) return;
  const loaderId = freeNodeId(workflow);
  workflow[loaderId] = { class_type: loader.classType, inputs: { [loader.field]: loader.value } };
  node.inputs[key] = [loaderId, 0];
}

// A reference clip's picture. Its soundtrack is a slot of its own, wired by `LOAD_VIDEO_AUDIO`.
function wireH3VideoSlot(workflow: ComfyUIWorkflow, index: number): void {
  const node = minimaxH3Node(workflow);
  const videoKey = `ref_videos.ref_video_${index}`;
  if (Array.isArray(node.inputs[videoKey])) return;
  const loaderId = freeNodeId(workflow);
  workflow[loaderId] = { class_type: "LoadVideo", inputs: { file: "example.mp4" } };
  const splitterId = freeNodeId(workflow);
  workflow[splitterId] = { class_type: "GetVideoComponents", inputs: { video: [loaderId, 0] } };
  node.inputs[videoKey] = [splitterId, 0];
}

// The take's own soundtrack and its first/last frame. The adapter names each guide as its loader's
// `passThrough` branch.
function wireH3Guides(workflow: ComfyUIWorkflow): void {
  if (Object.values(workflow).some((n) => n.class_type === "MiniMaxH3AddGuide")) {
    throw new Error("The upstream template now carries a MiniMaxH3AddGuide; revisit this patch");
  }
  const node = minimaxH3Node(workflow);
  const nodeId = Object.keys(workflow).find((id) => workflow[id] === node)!;
  const guiders = Object.values(workflow).filter((n) => n.class_type === "BasicGuider");
  const guider = guiders[0];
  if (guiders.length !== 1 || !guider) {
    throw new Error(`Expected exactly one BasicGuider, found ${guiders.length}`);
  }
  const conditioning = guider.inputs.conditioning;
  if (!Array.isArray(conditioning) || conditioning[0] !== nodeId || conditioning[1] !== 0) {
    throw new Error("Expected BasicGuider to read its conditioning from the H3 node");
  }

  const addGuide = (
    loader: { classType: string; field: string; value: string },
    vae: Record<string, unknown>,
    frameIdx: number,
  ): void => {
    const loaderId = freeNodeId(workflow);
    workflow[loaderId] = {
      class_type: loader.classType,
      inputs: { [loader.field]: loader.value },
    };
    const guideId = freeNodeId(workflow);
    workflow[guideId] = {
      class_type: "MiniMaxH3AddGuide",
      inputs: {
        positive: guider.inputs.conditioning,
        latent: [nodeId, 1],
        ...vae,
        [loader.field]: [loaderId, 0],
        frame_idx: frameIdx,
      },
    };
    guider.inputs.conditioning = [guideId, 0];
  };
  addGuide(LOAD_AUDIO, { audio_vae: node.inputs.audio_vae }, 0);
  addGuide(LOAD_IMAGE, { vae: node.inputs.vae }, 0);
  addGuide(LOAD_IMAGE, { vae: node.inputs.vae }, -1);
}

// Drop every node no output node reads, directly or transitively — what a literal retype just
// orphaned, plus a template's own dead ends (i2v ships an unwired ImageScaleToTotalPixels →
// GetImageSize pair). Each would otherwise survive as an adapter input that changes nothing.
function pruneUnreachable(workflow: ComfyUIWorkflow): void {
  const reachable = new Set<string>();
  const queue = Object.entries(workflow)
    .filter(([, node]) => node.class_type.startsWith("Save"))
    .map(([id]) => id);
  while (queue.length > 0) {
    const id = queue.pop()!;
    const node = workflow[id];
    if (!node || reachable.has(id)) continue;
    reachable.add(id);
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string") queue.push(value[0]);
    }
  }
  for (const id of Object.keys(workflow)) {
    if (!reachable.has(id)) delete workflow[id];
  }
}

// A patch for a workflow this script no longer syncs is dead config: the sync loop never visits it,
// so nothing else would ever say so.
function orphanedConfigEntries(outputNames: ReadonlySet<string>): string[] {
  const maps: Record<string, Record<string, unknown>> = { PATCHES };
  return Object.entries(maps).flatMap(([mapName, map]) =>
    Object.keys(map)
      .filter((outputName) => !outputNames.has(outputName))
      .map((outputName) => `${mapName} has "${outputName}", which is not synced`),
  );
}

const HASH_RE = /^\/\/ source-hash: ([0-9a-f]{64})$/;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// A workflow's content with its whitespace dropped. Editors and formatters touch a vendored copy's
// trailing newline, which must neither re-vendor it nor re-emit its adapter.
function canonicalJson(content: string): string {
  return JSON.stringify(JSON.parse(content));
}

function ensureRepo(source: GitSource, cloneDir: string): void {
  const label = sourceLabel(source.gitUrl);
  if (fs.existsSync(path.join(cloneDir, ".git"))) {
    console.log(`Updating ${label}...`);
    execSync(`git -C ${cloneDir} fetch --depth 1 origin`, { stdio: "inherit" });
    execSync(`git -C ${cloneDir} reset --hard origin/HEAD`, { stdio: "inherit" });
  } else {
    console.log(`Cloning ${label} (sparse, shallow)...`);
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    execSync(`git clone --depth 1 --filter=blob:none --sparse ${source.gitUrl} ${cloneDir}`, {
      stdio: "inherit",
    });
    const sparsePaths = [
      ...new Set(
        Object.keys(source.map)
          .map((p) => path.dirname(p))
          .filter((d) => d !== "."),
      ),
    ];
    if (sparsePaths.length > 0) {
      execSync(`git -C ${cloneDir} sparse-checkout set ${sparsePaths.join(" ")}`, {
        stdio: "inherit",
      });
    }
  }
}

// A workflow ready to generate from: its committed litegraph JSON (repo-relative), plus the
// provenance line the generated adapter carries.
type VendoredWorkflow = { outputName: string; file: string; provenance: string };

// Copy a git source's mapped workflows into its `WORKFLOW_DIR` subdirectory, byte for byte, after
// refreshing the clone. The copies are what the generator reads and what git records, so an
// upstream revision lands as a reviewable diff ahead of the adapters it regenerates.
function vendorGitSource(source: GitSource): VendoredWorkflow[] {
  const label = sourceLabel(source.gitUrl);
  const cloneDir = path.join(CLONE_DIR, label);
  ensureRepo(source, cloneDir);
  fs.mkdirSync(path.join(WORKFLOW_DIR, source.dir), { recursive: true });
  copyLicense(source, cloneDir, label);

  return Object.entries(source.map).flatMap(([sourcePath, outputs]) => {
    const outputNames = typeof outputs === "string" ? [outputs] : outputs;
    const from = path.join(cloneDir, sourcePath);
    if (!fs.existsSync(from)) {
      console.error(`  Source not found: ${label} / ${sourcePath}`);
      process.exit(1);
    }
    const file = path.join(source.dir, `${outputNames[0]}.json`);
    const to = path.join(WORKFLOW_DIR, file);
    const content = fs.readFileSync(from, "utf-8");
    if (
      fs.existsSync(to) &&
      canonicalJson(fs.readFileSync(to, "utf-8")) === canonicalJson(content)
    ) {
      console.log(`  ${file}: unchanged`);
    } else {
      fs.writeFileSync(to, content, "utf-8");
      console.log(`  ${file}: vendored`);
    }
    const provenance = `${label} / ${sourcePath} (${source.license})`;
    return outputNames.map((outputName) => ({ outputName, file, provenance }));
  });
}

// The vendored copies are redistributed, so the upstream notice travels with them.
function copyLicense(source: GitSource, cloneDir: string, label: string): void {
  const from = path.join(cloneDir, "LICENSE");
  if (!fs.existsSync(from)) {
    console.error(`  LICENSE not found in ${label}`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(WORKFLOW_DIR, source.dir, "LICENSE"));
}

function vendorLocalWorkflow(outputName: string): VendoredWorkflow {
  const file = path.join(LOCAL_DIR, `${outputName}.json`);
  if (!fs.existsSync(path.join(WORKFLOW_DIR, file))) {
    console.error(`  Missing hand-authored workflow: workflows/${file}`);
    process.exit(1);
  }
  console.log(`  ${file}: hand-authored`);
  return { outputName, file, provenance: `konte / workflows/${file} (hand-authored)` };
}

async function syncWorkflow(
  workflow: VendoredWorkflow,
  objectInfo: Record<string, ComfyUINodeDefinition>,
  managerClient: ComfyUIManagerClient,
): Promise<void> {
  const { outputName, provenance } = workflow;
  const sourceContent = fs.readFileSync(path.join(WORKFLOW_DIR, workflow.file), "utf-8");
  const sourceHash = sha256(canonicalJson(sourceContent));

  const outputJson = path.join(OUTPUT_DIR, `${outputName}.json`);
  const outputTs = path.join(OUTPUT_DIR, `${outputName}.ts`);

  if (fs.existsSync(outputTs)) {
    const firstLine = fs.readFileSync(outputTs, "utf-8").split("\n")[0] ?? "";
    const match = firstLine.match(HASH_RE);
    if (match && match[1] === sourceHash) {
      console.log(`  ${outputName}: unchanged, skipping`);
      return;
    }
  }

  const litegraph = JSON.parse(sourceContent) as LitegraphWorkflow;
  const { workflow: apiWorkflow, subgraphMeta } = convertLitegraphToApi(litegraph, objectInfo);
  PATCHES[outputName]?.(apiWorkflow);
  const apiJson = JSON.stringify(apiWorkflow, null, 2);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outputJson, apiJson + "\n", "utf-8");
  console.log(`  ${outputName}.json: updated`);

  const analysis = analyzeWorkflow(apiWorkflow, subgraphMeta);
  const hiddenInputs = extractHiddenSubgraphInputs(analysis, subgraphMeta);

  // Resolve the custom node packs this workflow uses (commented-out `nodes` scaffold),
  // mirroring `konte comfy import`. Best-effort — a Manager lacking the mapping API yields none.
  let nodePacks: string[] = [];
  try {
    const classToPack = await managerClient.resolveClassToPack(
      collectClassTypes(apiWorkflow, objectInfo),
    );
    nodePacks = [...new Set(classToPack.values())].sort();
  } catch {
    // Manager unavailable or no mapping API — skip the nodes scaffold.
  }

  const adapterCode = generateAdapterCode(
    outputName,
    `${outputName}.json`,
    analysis,
    hiddenInputs,
    nodePacks,
  );
  fs.writeFileSync(
    outputTs,
    `// source-hash: ${sourceHash}\n// source: ${provenance}\n${adapterCode}`,
    "utf-8",
  );
  console.log(`  ${outputName}.ts: generated`);
}

async function main(): Promise<void> {
  console.log("Vendoring workflows:");
  const workflows = [
    ...GIT_SOURCES.flatMap(vendorGitSource),
    ...LOCAL_WORKFLOWS.map(vendorLocalWorkflow),
  ];

  console.log(`\nConnecting to ComfyUI at ${COMFYUI_URL}...`);
  const client = new ComfyUIHttpClient(COMFYUI_URL);

  const reachable = await client.ping();
  if (!reachable) {
    console.error(`Error: ComfyUI server is not reachable at ${COMFYUI_URL}`);
    console.error("Please start ComfyUI before running this script.");
    process.exit(1);
  }

  console.log("Fetching /object_info...");
  const objectInfo = await client.getObjectInfo();
  console.log(`  Got ${Object.keys(objectInfo).length} node definitions`);

  const managerClient = new ComfyUIManagerClient(COMFYUI_URL, client);

  console.log("\nSyncing adapters:");
  for (const workflow of workflows) {
    await syncWorkflow(workflow, objectInfo, managerClient);
  }
  const orphaned = orphanedConfigEntries(new Set(workflows.map((w) => w.outputName)));
  if (orphaned.length > 0) {
    console.error("\nDead generator config:");
    for (const problem of orphaned) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log("\nDone.");
}

await main();
