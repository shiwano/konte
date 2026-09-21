import { describe, expect, it } from "vitest";
import {
  Audio,
  Composition,
  Panel,
  asset,
  defineAnimatic,
  defineDirection,
  respell,
} from "../dsl/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { minimaxH3Dialogue } from "../dsl/validators/index.js";
import type { ScriptLine } from "../dsl/direction.js";
import { directionDefaults } from "./helpers/direction.js";

const image = defineComfyAsset({
  workflow: "image.json",
  description: "test image adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const tts = defineComfyAsset({
  workflow: "tts.json",
  description: "test speech adapter",
  inputs: { script: { nodeId: "1", field: "text", type: "spokenText" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

// An audio processor: its `prompt` describes the treatment, not the words. Reading it as words
// would call the recording behind it readable and then refuse the lines it holds.
const cleanup = defineComfyAsset({
  workflow: "clean-audio.json",
  description: "test audio-processor adapter",
  inputs: {
    prompt: { nodeId: "1", field: "text", type: "prompt" },
    source: { nodeId: "2", field: "audio", type: "audio" },
  },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

// A model that takes its lines in its conditioning rather than in a `spokenText` input, and says
// where: H3's `<d>[Japanese] …</d>`.
const dialogueInPrompt = defineComfyAsset({
  workflow: "r2a.json",
  description: "test dialogue-in-prompt adapter",
  inputs: { prompt: { nodeId: "1", field: "prompt", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
  spokenTextPattern: minimaxH3Dialogue,
});

// The same adapter with nothing declared — its prompt stays treatment prose.
const undeclaredDialogue = defineComfyAsset({
  workflow: "r2a-undeclared.json",
  description: "test dialogue-in-prompt adapter with no pattern",
  inputs: { prompt: { nodeId: "1", field: "prompt", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const recording = defineComfyAsset({
  workflow: "load-audio.json",
  description: "test audio-with-no-text adapter",
  inputs: { gain: { nodeId: "1", field: "gain", type: "number" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const LINES = [
  { character: "ane", text: "かあちゃん、飴だまちょうだい。", acting: "wheedling, drawn out" },
  { character: "imouto", text: "あたしにも。" },
] as const satisfies readonly ScriptLine[];

const direction = defineDirection({
  ...directionDefaults,
  characters: {
    ane: {
      name: "the sister",
      description: "the elder sister",
      voice: { id: "aneVoice", description: "a bright ten-year-old" },
      promptDepiction: "ane",
    },
    imouto: {
      name: "the little one",
      description: "the younger sister",
      voice: { id: "imoutoVoice", description: "a small six-year-old" },
      promptDepiction: "imouto",
    },
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      {
        id: "01",
        role: "ordinary",
        action: "the sisters ask for a sweet",
        setup: "front",
        duration: 3,
        script: [...LINES],
        lineup: [],
      },
    ],
  },
});

// Each build gets the cues it declares; the panel is always there so `PANEL_REQUIRED` never fires
// first.
function board(cues: () => void) {
  return () =>
    defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => {
          asset("first", image, { prompt: "two girls on a deck" });
          cues();
          return (
            <Composition>
              <Panel src={{ src: "__konte:animatic:shot.01.first__" } as never} />
              <Audio src={{ src: "__konte:animatic:shot.01.vo__" } as never} />
              <Audio src={{ src: "__konte:animatic:shot.01.vo2__" } as never} />
            </Composition>
          );
        }),
      }),
    });
}

describe("a shot's lines are voiced per line", () => {
  it("takes one take per line", () => {
    expect(
      board(() => {
        asset("vo", tts, { script: LINES[0].text });
        asset("vo2", tts, { script: LINES[1].text });
      }),
    ).not.toThrow();
  });

  it("refuses a shot whose second line no take carries", () => {
    expect(
      board(() => {
        asset("vo", tts, { script: LINES[0].text });
        asset("vo2", tts, { script: "a line nobody wrote" });
      }),
    ).toThrow(/never voices the line/);
  });

  it("does not read an audio processor's prompt as the words it carries", () => {
    expect(
      board(() => {
        const raw = asset("raw", recording, { gain: 1 });
        asset("vo", cleanup, { prompt: "a clean studio read", source: raw });
        asset("vo2", cleanup, { prompt: "a clean studio read", source: raw });
      }),
    ).not.toThrow();
  });

  it("falls back to the whole-shot rule as soon as one cue is unreadable", () => {
    // The lines are split across a generated take and a recording. konte cannot read a waveform, so
    // it can say neither which lines that cue holds nor how many — including both of them.
    expect(
      board(() => {
        asset("vo", tts, { script: LINES[0].text });
        asset("vo2", recording, { gain: 1 });
      }),
    ).not.toThrow();
    expect(
      board(() => {
        asset("vo", recording, { gain: 1 });
        asset("vo2", recording, { gain: 1 });
      }),
    ).not.toThrow();
  });
});

describe("a model taking its lines in the prompt answers for them", () => {
  const take = (line: string) =>
    `Out on open water, she turns to her mother and asks, <d>[Japanese] ${line}</d>`;

  it("reads the words inside <d>, not the prose around them", () => {
    expect(
      board(() => {
        asset("vo", dialogueInPrompt, { prompt: take(LINES[0].text) });
        asset("vo2", dialogueInPrompt, { prompt: take(LINES[1].text) });
      }),
    ).not.toThrow();
  });

  it("refuses a shot whose second line no take speaks", () => {
    expect(
      board(() => {
        asset("vo", dialogueInPrompt, { prompt: take(LINES[0].text) });
        asset("vo2", dialogueInPrompt, { prompt: take("a line nobody wrote") });
      }),
    ).toThrow(/never voices the line/);
  });

  it("does not accept a line quoted outside <d>", () => {
    expect(
      board(() => {
        asset("vo", dialogueInPrompt, {
          prompt: `${take(LINES[0].text)} Her sister has just said ${LINES[1].text}`,
        });
        asset("vo2", dialogueInPrompt, { prompt: take("a line nobody wrote") });
      }),
    ).toThrow(/never voices the line/);
  });

  it("stays opaque without the pattern, falling back to the whole-shot rule", () => {
    expect(
      board(() => {
        asset("vo", undeclaredDialogue, { prompt: take(LINES[0].text) });
        asset("vo2", undeclaredDialogue, { prompt: take("a line nobody wrote") });
      }),
    ).not.toThrow();
  });
});

describe("a line respelled for the model saying it", () => {
  const RESPELT = "かあちゃん、飴玉ちょうだい。";

  it("takes a cue carrying the declared spelling", () => {
    expect(
      board(() => {
        asset("vo", tts, { script: respell(LINES[0].text, RESPELT) });
        asset("vo2", tts, { script: LINES[1].text });
      }),
    ).not.toThrow();
  });

  it("still refuses the same words undeclared", () => {
    expect(
      board(() => {
        asset("vo", tts, { script: RESPELT });
        asset("vo2", tts, { script: LINES[1].text });
      }),
    ).toThrow(/never voices the line/);
  });

  it("holds a spelling per take, so two models may want two", () => {
    expect(
      board(() => {
        asset("vo", tts, { script: respell(LINES[0].text, RESPELT) });
        asset("vo2", tts, { script: respell(LINES[1].text, "あたしにも！") });
      }),
    ).not.toThrow();
  });

  it("refuses a respelling of words the direction never wrote", () => {
    expect(
      board(() => {
        asset("vo", tts, { script: respell("かあちゃん、飴だまちょーだい。", RESPELT) });
        asset("vo2", tts, { script: LINES[1].text });
      }),
    ).toThrow(/is not a line direction.ts gives shot "01"/);
  });

  // The prompt check skips a line quoted verbatim, and a declared spelling is that line.
  it("hands the declared spelling to the prompt check as a line of the piece", () => {
    const definition = board(() => {
      asset("vo", tts, { script: respell(LINES[0].text, RESPELT) });
      asset("vo2", tts, { script: LINES[1].text });
    })();

    expect(definition.respellings).toEqual([{ shot: "01", line: LINES[0].text, as: RESPELT }]);
    for (const occurrence of definition.prompts ?? []) {
      expect(occurrence.script).toContain(RESPELT);
    }
  });

  it("refuses a spelling that is another line of the shot", () => {
    expect(
      board(() => {
        asset("vo", tts, { script: respell(LINES[0].text, LINES[1].text) });
        asset("vo2", tts, { script: LINES[1].text });
      }),
    ).toThrow(/another line of the same shot/);
  });

  it("does not answer for the same words in another shot", () => {
    const SHARED = "はい。";
    const twoShots = defineDirection({
      ...directionDefaults,
      characters: {
        ane: {
          name: "the sister",
          description: "the elder sister",
          voice: { id: "aneVoice", description: "a bright ten-year-old" },
          promptDepiction: "ane",
        },
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "she answers",
            setup: "front",
            duration: 3,
            script: [{ character: "ane", text: SHARED }],
            lineup: [],
          },
          {
            id: "02",
            role: "hero",
            action: "she answers again",
            setup: "front",
            duration: 3,
            script: [{ character: "ane", text: SHARED }],
            lineup: [],
          },
        ],
      },
    });

    expect(() =>
      defineAnimatic(twoShots, {
        timeline: ({ shot }) => ({
          shots: shot("01", () => {
            asset("first", image, { prompt: "the sister on a deck" });
            asset("vo", tts, { script: respell(SHARED, "ハイ。") });
            return (
              <Composition>
                <Panel src={{ src: "__konte:animatic:shot.01.first__" } as never} />
                <Audio src={{ src: "__konte:animatic:shot.01.vo__" } as never} />
              </Composition>
            );
          }).nextShot("02", () => {
            asset("first", image, { prompt: "the sister on a deck again" });
            asset("vo", tts, { script: "ハイ。" });
            return (
              <Composition>
                <Panel src={{ src: "__konte:animatic:shot.02.first__" } as never} />
                <Audio src={{ src: "__konte:animatic:shot.02.vo__" } as never} />
              </Composition>
            );
          }),
        }),
      }),
    ).toThrow(/shot "02" never voices the line/);
  });

  it("refuses a blank spelling", () => {
    expect(
      board(() => {
        asset("vo", tts, { script: respell(LINES[0].text, "  ") });
        asset("vo2", tts, { script: LINES[1].text });
      }),
    ).toThrow(/both non-empty/);
  });
});
