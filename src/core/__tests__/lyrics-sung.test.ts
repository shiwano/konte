import { describe, expect, it } from "vitest";
import { asset, defineDirection, defineReference, respell } from "../dsl/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { directionDefaults } from "./helpers/direction.js";

const music = defineComfyAsset({
  workflow: "music.json",
  description: "test adapter",
  inputs: {
    tags: { nodeId: "1", field: "tags", type: "prompt" },
    lyrics: { nodeId: "1", field: "lyrics", type: "spokenText" },
  },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const direction = defineDirection({
  ...directionDefaults,
  characters: { konte: { name: "Konte", promptDepiction: "girl", description: "the singer" } },
  policy: {
    format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
    lang: "en",
    speech: "free",
    clock: { song: "song", bpm: 120, beatsPerBar: 4 },
  },
  lyrics: [{ label: "chorus", singer: "konte", lines: ["Hit the light", "Watch me move"] }],
  sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
});

describe("the song's words", () => {
  it("carry every lyric line", () => {
    expect(() =>
      defineReference(direction, () => ({
        song: asset("song", music, {
          tags: "synth-pop",
          lyrics: "[Chorus]\nHit the light\nWatch me move",
        }),
      })),
    ).not.toThrow();
  });

  it("refuse a song that does not sing a declared line", () => {
    expect(() =>
      defineReference(direction, () => ({
        song: asset("song", music, { tags: "synth-pop", lyrics: "[Chorus]\nHit the light" }),
      })),
    ).toThrow(/is not given 1 lyric line\(s\)[\s\S]*“Watch me move”/);
  });

  it("take a line in the spelling a respell() gives it", () => {
    expect(() =>
      defineReference(direction, () => ({
        song: asset("song", music, {
          tags: "synth-pop",
          lyrics: `Hit the light\n${respell("Watch me move", "Watch me mooove")}`,
        }),
      })),
    ).not.toThrow();
  });
});

describe("a song handed no words", () => {
  it("is not held to the lyrics — a file brings its own singing", () => {
    expect(() =>
      defineReference(direction, () => ({
        song: asset("song", music, { tags: "synth-pop" }),
      })),
    ).not.toThrow();
  });
});
