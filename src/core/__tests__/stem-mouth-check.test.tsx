import { describe, expect, it } from "vitest";
import { formatShotStemAddress } from "../address.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { Audio, Composition, Panel, Video } from "../dsl/composition/index.js";
import { defineDirection, type Direction } from "../dsl/direction.js";
import { asset, defineAnimatic, defineVideo } from "../dsl/index.js";
import { findUnmouthedStems } from "../stem-mouth-check.js";
import type { AnimaticDefinition, VideoDefinition } from "../types/index.js";
import { directionDefaults } from "./helpers/direction.js";
import { moves } from "./helpers/shot.js";

const character = (name: string) => ({ name, description: name, promptDepiction: name });

const direction = defineDirection({
  ...directionDefaults,
  characters: { holmes: character("holmes"), john: character("john") },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      {
        id: "01",
        role: "ordinary",
        action: "x",
        setup: "front",
        duration: 2,
        lineup: ["john"],
        script: [{ character: "holmes", text: "Sit down." }],
      },
      {
        id: "02",
        role: "ordinary",
        action: "x",
        setup: "front",
        duration: 2,
        lineup: ["john"],
        script: [
          { character: "holmes", text: "Well?" },
          { character: "john", text: "Well." },
        ],
      },
      {
        id: "03",
        role: "ordinary",
        action: "x",
        setup: "front",
        duration: 2,
        lineup: [],
        lineupTo: ["holmes"],
        script: [{ character: "holmes", text: "Here I am." }],
      },
      {
        id: "04",
        role: "ordinary",
        action: "x",
        setup: "front",
        duration: 2,
        lineup: ["john"],
        coverage: true,
        script: [{ character: "holmes", text: "Again." }],
      },
      {
        id: "05",
        role: "ordinary",
        action: "x",
        setup: "front",
        duration: 2,
        lineup: ["john"],
        script: [{ speaker: "a crowd", text: "Hurrah!" }],
      },
      {
        id: "06",
        role: "ordinary",
        action: "x",
        setup: "front",
        duration: 2,
        lineup: ["john"],
        script: [{ character: "holmes", text: "Listen." }],
      },
    ],
  },
}) as unknown as Direction;

const IDS = ["01", "02", "03", "04", "05", "06"];

function animatic(overrides: Record<string, object> = {}): AnimaticDefinition {
  return {
    shots: IDS.map((id) => ({
      id,
      stemRefs: [`animatic:shot.${id}.line`],
      cueKinds: { [`animatic:shot.${id}.line`]: "voice" },
      ...(id === "06" ? { pending: true } : {}),
      ...overrides[id],
    })),
  } as unknown as AnimaticDefinition;
}

function video(
  stemInputs: { address: string; source: string }[] = IDS.map((id) => ({
    address: `video:shot.${id}.motion`,
    source: formatShotStemAddress("animatic", id),
  })),
  pictureRefs: Record<string, string[]> = {},
): VideoDefinition {
  return {
    shots: IDS.map((id) => ({ id, assets: {}, pictureRefs: pictureRefs[id] ?? [] })),
    stemInputs,
  } as unknown as VideoDefinition;
}

describe("findUnmouthedStems", () => {
  it("names a take driven by a stem whose lines only an off-frame character speaks", () => {
    expect(findUnmouthedStems(direction, animatic(), video())).toEqual([
      { address: "video:shot.01.motion", shotId: "01", speakers: ["holmes"] },
    ]);
  });

  it("does not read a stem carrying a cue other than a voice", () => {
    const board = animatic({
      "01": {
        stemRefs: ["animatic:shot.01.line", "animatic:shot.01.door"],
        cueKinds: { "animatic:shot.01.line": "voice", "animatic:shot.01.door": "sfx" },
      },
    });
    expect(findUnmouthedStems(direction, board, video())).toEqual([]);
  });

  it("reads a timeline take where the stem's own shot plays it", () => {
    const stem = formatShotStemAddress("animatic", "01");
    const timeline = [{ address: "video:timeline.motion", source: stem }];
    expect(findUnmouthedStems(direction, animatic(), video(timeline))).toEqual([]);
    expect(
      findUnmouthedStems(
        direction,
        animatic(),
        video(timeline, { "01": ["video:timeline.motion"] }),
      ),
    ).toEqual([{ address: "video:timeline.motion", shotId: "01", speakers: ["holmes"] }]);
  });

  it("does not read a stem a different shot's take is driven by", () => {
    const stem = formatShotStemAddress("animatic", "01");
    expect(
      findUnmouthedStems(
        direction,
        animatic(),
        video([{ address: "video:shot.02.motion", source: stem }]),
      ),
    ).toEqual([]);
  });
});

describe("stem inputs collected from video.tsx", () => {
  const still = defineComfyAsset({
    workflow: "still.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "1", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "image" } },
  });
  const tts = defineComfyAsset({
    workflow: "tts.json",
    description: "test adapter",
    inputs: { text: { nodeId: "1", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "audio" } },
  });
  const lipSync = defineComfyAsset({
    workflow: "lip-sync.json",
    description: "test adapter",
    inputs: {
      image: { nodeId: "1", field: "image", type: "image" },
      track: { nodeId: "2", field: "audio", type: "audio", stem: true },
    },
    outputs: { result: { nodeId: "9", type: "video" } },
  });
  const voiceClone = defineComfyAsset({
    workflow: "voice-clone.json",
    description: "test adapter",
    inputs: { voice: { nodeId: "1", field: "audio", type: "audio" } },
    outputs: { result: { nodeId: "9", type: "audio" } },
  });

  const offFrame = defineDirection({
    ...directionDefaults,
    characters: { holmes: character("holmes"), john: character("john") },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        {
          id: "01",
          role: "ordinary",
          action: "x",
          setup: "front",
          duration: 2,
          lineup: ["john"],
          script: [{ character: "holmes", text: "Sit down." }],
        },
      ],
    },
  });

  const board = defineAnimatic(offFrame, {
    timeline: ({ shot }) => ({
      shots: shot("01", () => (
        <Composition>
          <Panel src={asset("key", still, { prompt: "a" })} {...moves} />
          <Audio src={asset("vo", tts, { text: "Sit down." })} />
        </Composition>
      )),
    }),
  });

  it("names a take whose stem input is the off-frame line, not a sound built from it", () => {
    const video = defineVideo(offFrame, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video
              src={asset("motion", lipSync, {
                image: board.shot("01").image("key"),
                track: board.shot("01").stem,
              })}
              hasAudio
            />
            <Audio src={asset("clone", voiceClone, { voice: board.shot("01").stem })} />
          </Composition>
        )),
      }),
    });
    expect(findUnmouthedStems(offFrame as unknown as Direction, board, video)).toEqual([
      { address: "video:shot.01.motion", shotId: "01", speakers: ["holmes"] },
    ]);
  });
});
