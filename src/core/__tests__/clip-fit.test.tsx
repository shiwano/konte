import { describe, expect, it } from "vitest";
import { Audio, Composition, Panel, asset, defineAnimatic, defineDirection } from "../dsl/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { minimaxH3Dialogue } from "../dsl/validators/index.js";
import type { AdapterValidator } from "../dsl/validators/index.js";
import type { AnimaticDefinition } from "../types/animatic.js";
import { directionDefaults } from "./helpers/direction.js";

const image = defineComfyAsset({
  workflow: "image.json",
  description: "test image adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

// A speech model shaped like H3's: its lines are marked inside the prompt, and its clip length is a
// frame count on its own clock, landing on the same offset grid.
const cutFitsTake: AdapterValidator = (inputs) => {
  const at = /cut at (\d+)s/.exec(String(inputs.prompt ?? ""));
  const frames = inputs.length;
  if (!at || typeof frames !== "number") return undefined;
  const take = frames / 24;
  return Number(at[1]) >= take ? `cut at ${at[1]}s past a ${take.toFixed(2)}s take` : undefined;
};
cutFitsTake.inputs = ["prompt", "length"];

const speech = defineComfyAsset({
  workflow: "r2a.json",
  description: "test speech adapter",
  validators: [cutFitsTake],
  inputs: {
    prompt: { nodeId: "1", field: "prompt", type: "prompt" },
    length: {
      nodeId: "1",
      field: "length",
      type: "frames",
      clock: 24,
      default: 120,
      grid: { step: 17, offset: 5 },
      fill: "speech",
    },
  },
  outputs: { result: { nodeId: "9", type: "audio" } },
  spokenTextPattern: minimaxH3Dialogue,
});

// A model that asks for its clip length in seconds — the other spelling of the same thing.
const sfx = defineComfyAsset({
  workflow: "sfx.json",
  description: "test SFX adapter measured in seconds",
  inputs: {
    prompt: { nodeId: "1", field: "prompt", type: "prompt" },
    duration: { nodeId: "2", field: "seconds", type: "seconds", default: 150 },
  },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const LINE = "かあちゃん、飴だまちょうだい。";

function directionOf(duration: number) {
  return defineDirection({
    ...directionDefaults,
    policy: { ...directionDefaults.policy, lang: "ja" },
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
          action: "the sister asks for a sweet",
          setup: "front",
          duration,
          script: [{ character: "ane", text: LINE }],
          lineup: [],
        },
      ],
    },
  });
}

function board(opts: {
  duration: number;
  start?: number;
  length?: number;
  cutAt?: number;
  cueDuration?: number;
  // A second placement of the same take.
  againAt?: number;
}): () => AnimaticDefinition {
  const direction = directionOf(opts.duration);
  return () =>
    defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => {
          asset("first", image, { prompt: "a girl on a deck" });
          asset("vo", speech, {
            prompt:
              `A girl asks for a sweet, and says <d>[Japanese] ${LINE}</d>` +
              (opts.cutAt !== undefined ? ` The camera cut at ${opts.cutAt}s.` : ""),
            ...(opts.length !== undefined ? { length: opts.length } : {}),
          });
          return (
            <Composition>
              <Panel src={{ src: "__konte:animatic:shot.01.first__" } as never} />
              <Audio
                src={{ src: "__konte:animatic:shot.01.vo__" } as never}
                {...(opts.start !== undefined ? { start: opts.start } : {})}
                {...(opts.cueDuration !== undefined ? { duration: opts.cueDuration } : {})}
              />
              {opts.againAt !== undefined && (
                <Audio
                  src={{ src: "__konte:animatic:shot.01.vo__" } as never}
                  start={opts.againAt}
                />
              )}
            </Composition>
          );
        }),
      }),
    });
}

const framesOf = (definition: AnimaticDefinition): number => {
  const vo = definition.shots.find((s) => s.id === "01")!.assets.vo!;
  return (vo as { inputs: Record<string, unknown> }).inputs["1.length"] as number;
};

describe("a derived clip length", () => {
  it("is sized from the words rather than the shot", () => {
    // 13 morae of Japanese, not the 4s shot: the read would spread to fill a shot-sized clip.
    expect(framesOf(board({ duration: 4 })())).toBe(56);
  });

  it("is held inside the window the cue plays in", () => {
    // The same line, 2.5s into the shot: 1.5s of window is left, which the 56-frame count (2.33s)
    // would end past, so it falls to the largest grid point that fits.
    expect(framesOf(board({ duration: 4, start: 2.5 })())).toBe(22);
  });

  it("keeps a count the shot check lets overrun", () => {
    // 56 frames from 1.7s ends 0.03s past the 4s shot, under the tenth the shot check allows.
    expect(framesOf(board({ duration: 4, start: 1.7 })())).toBe(56);
  });

  it("keeps a count that overruns the shot alone by under a tenth", () => {
    // 56 frames is 2.33s, 0.03s past a 2.3s shot.
    expect(framesOf(board({ duration: 2.3 })())).toBe(56);
  });

  it("never lands a count the shot check then refuses", () => {
    for (const start of [0, 0.3, 0.6, 1.2, 2.4]) {
      expect(board({ duration: 4, start })).not.toThrow();
    }
  });

  it("stands aside for a count the caller declares", () => {
    expect(framesOf(board({ duration: 4, length: 39 })())).toBe(39);
  });

  it("names the shot, not the frame count, when the count is konte's own", () => {
    // A 0.5s shot entered at 0.45s: the words are clamped to the smallest count the grid allows and
    // that still overruns. Telling the author to shorten a clip konte sized would be a dead end.
    expect(board({ duration: 0.5, start: 0.45 })).toThrow(
      /start the cue earlier, or give the shot/,
    );
    expect(board({ duration: 0.5, start: 0.45 })).not.toThrow(/Shorten the clip/);
    expect(board({ duration: 3, length: 124 })).toThrow(
      /Shorten the clip \(its frame count is 124/,
    );
  });
});

describe("an adapter's clip length", () => {
  it("is one input, so which one the shot is measured against is never a declaration order", () => {
    // Either spelling counts: a frame count and a duration are two lengths.
    expect(() =>
      defineComfyAsset({
        workflow: "two-lengths.json",
        description: "test adapter giving its clip length twice",
        inputs: {
          length: { nodeId: "1", field: "length", type: "frames", clock: 24 },
          duration: { nodeId: "2", field: "seconds", type: "seconds" },
        },
        outputs: { result: { nodeId: "9", type: "audio" } },
      }),
    ).toThrow(/each give the clip's length/);
  });

  it("fills from the words only where the adapter can read them", () => {
    expect(() =>
      defineComfyAsset({
        workflow: "wordless.json",
        description: "test adapter that declares no words",
        inputs: {
          length: { nodeId: "1", field: "length", type: "frames", clock: 24, fill: "speech" },
        },
        outputs: { result: { nodeId: "9", type: "audio" } },
      }),
    ).toThrow(/no words to read/);
  });
});

describe("a clip length spelled in seconds", () => {
  const secondsOf = (definition: AnimaticDefinition, name: string): number => {
    const a = definition.shots.find((s) => s.id === "01")!.assets[name]!;
    return (a as { inputs: Record<string, unknown> }).inputs["2.seconds"] as number;
  };
  const withSfx = (opts: { duration: number; start?: number; seconds?: number }) => {
    const direction = directionOf(opts.duration);
    return () =>
      defineAnimatic(direction, {
        timeline: ({ shot }) => ({
          shots: shot("01", () => {
            asset("first", image, { prompt: "a girl on a deck" });
            asset("vo", speech, {
              prompt: `A girl asks for a sweet, and says <d>[Japanese] ${LINE}</d>`,
            });
            asset("thud", sfx, {
              prompt: "a wooden pole knocking the gunwale",
              ...(opts.seconds !== undefined ? { duration: opts.seconds } : {}),
            });
            return (
              <Composition>
                <Panel src={{ src: "__konte:animatic:shot.01.first__" } as never} />
                <Audio src={{ src: "__konte:animatic:shot.01.vo__" } as never} />
                <Audio
                  src={{ src: "__konte:animatic:shot.01.thud__" } as never}
                  {...(opts.start !== undefined ? { start: opts.start } : {})}
                />
              </Composition>
            );
          }),
        }),
      });
  };

  it("fills from the shot rather than the adapter's own default", () => {
    expect(secondsOf(withSfx({ duration: 4 })(), "thud")).toBe(4);
  });

  it("is measured against the shot like a frame count is", () => {
    expect(withSfx({ duration: 4, seconds: 9 })).toThrow(/it asks for 9s/);
    expect(withSfx({ duration: 4, seconds: 9 })).toThrow(/past its 4.00s shot/);
  });

  it("counts the cue's start", () => {
    expect(withSfx({ duration: 4, seconds: 3 })).not.toThrow();
    expect(withSfx({ duration: 4, start: 2, seconds: 3 })).toThrow(/past its 4.00s shot/);
  });
});

describe("a narrowed count", () => {
  it("is judged by the adapter's validators, which passed the wider one", () => {
    // The cut at 2s is inside the 2.33s the words asked for and past the 1.63s the window leaves.
    expect(board({ duration: 4, start: 2.5, cutAt: 2 })).toThrow(/cut at 2s past a 0.92s take/);
    expect(board({ duration: 4, cutAt: 2 })).not.toThrow();
  });
});

describe("a derived count narrowed under half the words", () => {
  it("is refused before the take is paid for", () => {
    // The words take 1.2s past the take's lead-in; 0.7s of window is left, whose grid point is 0.21s.
    expect(board({ duration: 4, start: 3.3 })).toThrow(/estimates at 1.2s to say/);
    expect(board({ duration: 4, start: 3.3 })).toThrow(/cut to the 0.21s that fits/);
  });

  it("is refused when the shot alone is too short", () => {
    expect(board({ duration: 0.8 })).toThrow(/leaving 0.80s of its 0.80s shot/);
  });

  it("lets a window short only of the lead-in stand", () => {
    // 0.92s holds the 1.2s of words at a fast read, though not the 2.1s estimate with the lead-in.
    expect(board({ duration: 4, start: 2.5 })).not.toThrow();
  });

  it("stands aside for a count the caller declares", () => {
    expect(board({ duration: 4, start: 3.3, length: 5 })).not.toThrow();
  });

  it("is refused under a cue duration, which trims the take and cannot lengthen it", () => {
    expect(board({ duration: 0.8, cueDuration: 0.5 })).toThrow(/cut to the 0.21s that fits/);
  });

  it("names the placement that narrowed a shared take", () => {
    expect(board({ duration: 4, againAt: 3.3 })).toThrow(/from 3.30s, leaving 0.70s/);
  });
});

describe("a cue that ends past its shot", () => {
  it("is refused before the take is paid for", () => {
    // 124 frames is 5.17s in a 3s shot.
    expect(board({ duration: 3, length: 124 })).toThrow(/past its 3.00s shot/);
  });

  it("counts the cue's start against the shot", () => {
    // 56 frames is 2.33s, which fits a 3s shot on its own and not from 1.5s in.
    expect(board({ duration: 3, length: 56 })).not.toThrow();
    expect(board({ duration: 3, start: 1.5, length: 56 })).toThrow(/past its 3.00s shot/);
  });

  it("lets an overrun under a tenth of a second stand", () => {
    // 73 frames is 3.042s: past a 3s shot by less than a syllable.
    expect(board({ duration: 3, length: 73 })).not.toThrow();
  });
});
