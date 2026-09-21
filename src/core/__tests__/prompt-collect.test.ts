import { describe, expect, it } from "vitest";
import { Composition } from "../dsl/composition/composition.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineReference, defineVideo, definePatch } from "../dsl/index.js";
import { checkPrompts } from "../prompt-check.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { defineDirection } from "../dsl/direction.js";
import { minimaxH3Dialogue } from "../dsl/validators/index.js";
import { directionDefaults, testDirection, plainDirection } from "./helpers/direction.js";

const FREEZE = /\bnothing\s+moves\b/i;
const FORMAT = { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } };

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "prompt" },
    negativePrompt: { nodeId: "4", field: "text", type: "negativePrompt" },
    // Not conditioning at all, so it is never collected.
    filename: { nodeId: "6", field: "filename_prefix", type: "string" },
    styleNote: { nodeId: "5", field: "text", type: "prompt", default: "no gradients" },
    image: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
  promptExemptions: [FREEZE],
});

// A model that takes its lines in the conditioning and says where — the only shape the script
// exemption reads.
const dialogueComfy = defineComfyAsset({
  workflow: "r2a.json",
  description: "test dialogue-in-prompt adapter",
  inputs: { prompt: { nodeId: "1", field: "prompt", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
  spokenTextPattern: minimaxH3Dialogue,
});

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

describe("prompt collection", () => {
  it("collects a video stage's prompts, addressed, and nothing else", () => {
    const video = defineVideo(testDirection(FORMAT), {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2,
            build: () => {
              asset("motion", imageComfy, {
                prompt: "a lit desk",
                negativePrompt: "blur, watermark",
                filename: "shot-01",
              });
              return el();
            },
          }),
        ]),
    });

    expect(video.prompts).toEqual([
      {
        address: "video:shot.01.motion",
        input: "prompt",
        value: "a lit desk",
        exemptions: [FREEZE],
      },
      {
        address: "video:shot.01.motion",
        input: "negativePrompt",
        value: "blur, watermark",
        negative: true,
        exemptions: [FREEZE],
      },
      {
        address: "video:shot.01.motion",
        input: "styleNote",
        value: "no gradients",
        exemptions: [FREEZE],
      },
    ]);
  });

  it("marks the words a prompt-borne model's lines sit in, leaving the value a prompt", () => {
    const value = "She turns and asks, <d>[Japanese] かあちゃん、あたしにも。</d>";
    const video = defineVideo(testDirection(FORMAT), {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2,
            build: () => {
              asset("vo", dialogueComfy, { prompt: value });
              return el();
            },
          }),
        ]),
    });
    const [p] = video.prompts ?? [];
    expect(p?.value).toBe(value);
    expect(p?.spoken).toBeUndefined();
    expect(p?.spokenWithin).toEqual(["かあちゃん、あたしにも。"]);
    expect(p?.spokenMarks).toEqual(["<d>[Japanese] かあちゃん、あたしにも。</d>"]);
  });

  // An adapter that never says where its model's lines are gets no cut: the words are read as the
  // author's.
  it("reads a quoted line as prompt text when the adapter marks no lines", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            duration: 2,
            setup: "front",
            role: "hero",
            action: "she refuses",
            script: [{ narration: "I don't want to." }],
            lineup: [],
          },
        ],
      },
    });
    const video = defineVideo(direction, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2,
            build: () => {
              asset("motion", imageComfy, {
                prompt: "She says, I don't want to.",
                styleNote: "flat watercolor",
              });
              return el();
            },
          }),
        ]),
    });

    expect(checkPrompts(video.prompts ?? []).active.map((f) => f.phrase)).toContain(
      "I don't want to",
    );
  });

  it("carries the adapter's exemptions into the check", () => {
    const video = defineVideo(testDirection(FORMAT), {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2,
            build: () => {
              asset("motion", imageComfy, {
                prompt: "the room holds still and nothing moves",
                styleNote: "flat watercolor",
              });
              return el();
            },
          }),
        ]),
    });

    expect(checkPrompts(video.prompts ?? []).active).toEqual([]);
  });

  it("stamps the direction's spoken lines, so a quoted line is not a negation", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            duration: 2,
            setup: "front",
            role: "hero",
            action: "she refuses",
            script: [{ narration: "I don't want to." }],
            lineup: [],
          },
        ],
      },
    });
    const video = defineVideo(direction, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2,
            build: () => {
              asset("vo", dialogueComfy, {
                prompt: "She says, <d>[English] I don't want to.</d> and turns away.",
              });
              return el();
            },
          }),
        ]),
    });

    expect(video.prompts?.[0]?.script).toEqual(["I don't want to."]);
    expect(checkPrompts(video.prompts ?? []).active).toEqual([]);
  });

  it("carries a stage's waivers onto the definition", () => {
    const video = defineVideo(testDirection(FORMAT), {
      waivers: { "prompt-negation:abcd1234": "the model's own vocabulary" },
      timeline: () => videoTimeline([]),
    });
    expect(video.waivers).toEqual({ "prompt-negation:abcd1234": "the model's own vocabulary" });
  });

  it("collects the reference stage's prompts", () => {
    const reference = defineReference(plainDirection, () => ({
      hero: asset("hero", imageComfy, { prompt: "a woman in a red coat", styleNote: "ink wash" }),
    }));
    expect(reference.prompts).toEqual([
      {
        address: "reference:hero",
        input: "prompt",
        value: "a woman in a red coat",
        exemptions: [FREEZE],
      },
      {
        address: "reference:hero",
        input: "styleNote",
        value: "ink wash",
        exemptions: [FREEZE],
      },
    ]);
  });

  it("collects a patch chain's prompts, addressed off the take it corrects", () => {
    const patch = definePatch<"image">(({ source }) =>
      asset("patched", imageComfy, {
        image: source,
        prompt: "the cup is upright",
        styleNote: "ink",
      }),
    );
    const built = patch.build({
      stage: "video",
      sourceAddress: "video:shot.01.frame",
      sourceVariantId: "v-abc123",
    });
    expect(built.prompts?.map((p) => p.address)).toEqual([
      "video:patch.v-abc123.patched",
      "video:patch.v-abc123.patched",
    ]);
  });

  it("leaves a definition built with no prompt input carrying none", () => {
    const promptless = defineComfyAsset({
      workflow: "up.json",
      description: "test adapter",
      inputs: { image: { nodeId: "1", field: "image", type: "image" } },
      outputs: { result: { nodeId: "9", type: "image" } },
    });
    const reference = defineReference(plainDirection, () => ({
      plate: asset("plate", promptless, {}),
    }));
    expect(reference.prompts).toBeUndefined();
  });
});
