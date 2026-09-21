import { describe, expect, it } from "vitest";
import type { DefinitionLike } from "../../../../core/address.js";
import type { AssetDefinition } from "../../../../core/types/index.js";
import { createAssetInfoBuilder } from "../asset-info.js";

const PROMPT = "a girl at a desk";
const NEGATIVE = "blurry";
const ADDR = "video:shot.01.motion";

// The take's snapshot: a comfy definition keyed by workflow target, labelling only its prompts.
const MOTION: AssetDefinition = {
  kind: "comfy",
  workflow: "r2v.json",
  inputs: {
    "136.prompt": PROMPT,
    "136.negative": NEGATIVE,
    "137.image": "__konte:animatic:shot.01.first__",
    "136.width": 1248,
    nested: { frames: ["__konte:reference:character__"] },
  },
  inputLabels: { "136.prompt": "prompt", "136.negative": "negativePrompt" },
};

// The stage as it is now: only its prompt collection is read, to say which inputs are prompt text.
const VIDEO: DefinitionLike = {
  shots: [],
  prompts: [
    { address: ADDR, input: "prompt", value: "rewritten since" },
    { address: ADDR, input: "negativePrompt", value: NEGATIVE, negative: true },
  ],
};

// A builder over one snapshotted take per address.
function builder(
  snapshots: Record<string, AssetDefinition>,
  definitions: Partial<Record<"video" | "reference", DefinitionLike>> = {},
) {
  return createAssetInfoBuilder(
    definitions,
    (addr) => snapshots[addr] ?? null,
    (addr, vid, ref) => `/thumb/${addr}/${vid}/${ref}`,
  );
}

const build = (addr: string) => builder({ [ADDR]: MOTION }, { video: VIDEO })(addr, "v-1");

describe("createAssetInfoBuilder", () => {
  it("splits the prompt inputs off with the take's own text, labelling the exclusion half", () => {
    expect(build(ADDR)?.prompts).toEqual([
      { input: "prompt", kind: "prompt", value: PROMPT },
      { input: "negativePrompt", kind: "negative", value: NEGATIVE },
    ]);
  });

  it("drops the prompt inputs from the rest", () => {
    const names = build(ADDR)?.inputs.map((i) => i.name);
    expect(names).toEqual(["137.image", "136.width", "nested"]);
  });

  it("prints a placeholder as the address it names, with the still of the take it consumed", () => {
    const image = build(ADDR)?.inputs.find((i) => i.name === "137.image");
    expect(image?.value).toBe("animatic:shot.01.first");
    expect(image?.refs).toEqual([
      {
        address: "animatic:shot.01.first",
        imageUrl: `/thumb/${ADDR}/v-1/animatic:shot.01.first`,
      },
    ]);
  });

  it("reaches a placeholder nested inside an object input", () => {
    const nested = build(ADDR)?.inputs.find((i) => i.name === "nested");
    expect(nested?.value).toContain("reference:character");
    expect(nested?.refs.map((r) => r.address)).toEqual(["reference:character"]);
  });

  it("reports the backend and its own identifier", () => {
    expect(build(ADDR)).toMatchObject({ backend: "comfy", ref: "r2v.json" });
  });

  it("names each input the way the adapter declares it, collapsing an `also` pair into one", () => {
    const info = builder({
      [ADDR]: {
        kind: "comfy",
        workflow: "r2v.json",
        inputs: { "136.width": 1248, "129.noise_seed": 7, "144.noise_seed": 7 },
        inputLabels: {
          "136.width": "width",
          "129.noise_seed": "seed",
          "144.noise_seed": "seed",
        },
      },
    })(ADDR, "v-1");
    expect(info?.inputs).toEqual([
      { name: "width", value: "1248", refs: [] },
      { name: "seed", value: "7", refs: [] },
    ]);
  });

  it("falls back to the backend key for an input no label accounts for", () => {
    const info = builder({
      [ADDR]: { kind: "comfy", workflow: "r2v.json", inputs: { "136.width": 1248 } },
    })(ADDR, "v-1");
    expect(info?.inputs.map((i) => i.name)).toEqual(["136.width"]);
  });

  it("keeps an input that merely repeats the prompt's text under another name", () => {
    const info = builder(
      {
        [ADDR]: {
          kind: "comfy",
          workflow: "r2v.json",
          inputs: { "136.prompt": "cinematic", "140.style": "cinematic" },
          inputLabels: { "136.prompt": "prompt", "140.style": "style" },
        },
      },
      { video: { shots: [], prompts: [{ address: ADDR, input: "prompt", value: "cinematic" }] } },
    )(ADDR, "v-1");
    expect(info?.prompts.map((p) => p.input)).toEqual(["prompt"]);
    expect(info?.inputs.map((i) => i.name)).toEqual(["style"]);
  });

  it("prints a partially labelled object whole rather than dropping its unlabelled leaves", () => {
    const info = builder({
      [ADDR]: {
        kind: "fal",
        endpointId: "fal-ai/tts",
        mediaType: "audio",
        inputs: { audioSetting: { format: "mp3", sampleRate: 44100 } },
        inputLabels: { "audioSetting.format": "format" },
      },
    })(ADDR, "v-1");
    expect(info?.inputs.map((i) => i.name)).toEqual(["format", "audioSetting"]);
  });

  it("accounts for a fully labelled nested object without printing it twice", () => {
    const info = builder({
      [ADDR]: {
        kind: "fal",
        endpointId: "fal-ai/tts",
        mediaType: "audio",
        inputs: { audioSetting: { format: "mp3", sampleRate: 44100 } },
        inputLabels: {
          "audioSetting.format": "format",
          "audioSetting.sampleRate": "sampleRate",
        },
      },
    })(ADDR, "v-1");
    expect(info?.inputs.map((i) => i.name)).toEqual(["format", "sampleRate"]);
  });

  it("reads a local take's prompt by the adapter's own input name", () => {
    const info = builder(
      {
        [ADDR]: {
          kind: "local",
          operation: "render",
          mediaType: "image",
          inputs: { prompt: PROMPT, width: 640 },
        },
      },
      { video: VIDEO },
    )(ADDR, "v-1");
    expect(info?.prompts).toEqual([{ input: "prompt", kind: "prompt", value: PROMPT }]);
    expect(info?.inputs.map((i) => i.name)).toEqual(["width"]);
  });

  it("yields nothing for a take with no snapshot", () => {
    expect(build("video:shot.99.motion")).toBeUndefined();
  });
});
