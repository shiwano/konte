import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { inBuild } from "./helpers/build.js";
import { listStemAddresses } from "../address.js";
import { commitShotStem, prepareShotStem, stemDefinitionHash } from "../composition-resource.js";
import { Audio, Composition, Panel, Video } from "../dsl/composition/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineDirection, type ScriptLine } from "../dsl/direction.js";
import {
  asset,
  defineAnimatic,
  defineVideo,
  type MediaAsset,
  type NarrationStem,
} from "../dsl/index.js";
import { buildDependencyGraph, listBoardlessVideoShots } from "../graph.js";
import { assertNarrationStemsPlaced } from "../narration-stem.js";
import { shotAcceptTargets } from "../shot-accept-targets.js";
import { StateManager } from "../state/index.js";
import { directionDefaults } from "./helpers/direction.js";
import { writeSilentWav } from "./helpers/wav.js";

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

// No words anywhere in its inputs: a door slam, or a recording.
const recording = defineComfyAsset({
  workflow: "sfx.json",
  description: "test wordless audio adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const ia2v = defineComfyAsset({
  workflow: "ia2v.json",
  description: "test audio-driven motion adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    audio: { nodeId: "2", field: "audio", type: "audio" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const t2v = defineComfyAsset({
  workflow: "t2v.json",
  description: "test motion adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const LINE = "かあちゃん、飴だまちょうだい。";
const NARRATION = "その夏、姉は八つだった。";

const directionWith = (script: readonly ScriptLine[]) =>
  defineDirection({
    ...directionDefaults,
    characters: {
      ane: {
        name: "the sister",
        description: "the elder sister",
        voice: { id: "aneVoice", description: "a bright ten-year-old" },
        promptDepiction: "ane",
      },
    },
    narrator: { id: "narratorVoice", description: "a calm, low read" },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        {
          id: "01",
          role: "ordinary",
          action: "the sister asks for a sweet",
          setup: "front",
          duration: 3,
          script,
          lineup: [],
        },
      ],
    },
  });

type Board = ReturnType<typeof defineAnimatic>;

// One board shot over the given lines, playing each cue `cues` declares.
function boardWith(script: readonly ScriptLine[], cues: () => Array<MediaAsset<"audio">>): Board {
  return defineAnimatic(directionWith(script), {
    timeline: ({ shot }) => ({
      shots: shot("01", () => (
        <Composition>
          <Panel
            src={asset("first", image, { prompt: "a girl on a deck" })}
            blocking="She looks up."
            camera="Holds."
          />
          {cues().map((cue) => (
            <Audio key={cue.src} src={cue} />
          ))}
        </Composition>
      )),
    }),
  });
}

const BOTH: ScriptLine[] = [{ character: "ane", text: LINE }, { narration: NARRATION }];

const boardWithBoth = () =>
  boardWith(BOTH, () => [
    asset("vo", tts, { script: LINE }),
    asset("narration", tts, { script: NARRATION }),
    asset("slam", recording, { prompt: "a door slamming" }),
  ]);

describe("the board mixes its narration apart", () => {
  it("keeps the narration out of the stem a motion model takes", () => {
    const board = boardWithBoth();
    const shot = board.shots[0]!;
    expect(shot.stemRefs).toEqual(["animatic:shot.01.vo", "animatic:shot.01.slam"]);
    expect(shot.narrationStemRefs).toEqual(["animatic:shot.01.narration"]);
    expect(shot.cueKinds?.["animatic:shot.01.narration"]).toBe("narration");
    expect(listStemAddresses(board)).toEqual([
      "animatic:shot.01#stem",
      "animatic:shot.01#narrationStem",
    ]);
    const stem = stemDefinitionHash(board, "animatic:shot.01#stem");
    const narration = stemDefinitionHash(board, "animatic:shot.01#narrationStem");
    expect(stem).not.toBe("");
    expect(narration).not.toBe("");
    expect(narration).not.toBe(stem);
  });

  it("wires each stem to its own cues", () => {
    const graph = buildDependencyGraph(boardWithBoth());
    expect(graph.dependencies.get("animatic:shot.01#stem")).toEqual([
      "animatic:shot.01.vo",
      "animatic:shot.01.slam",
    ]);
    expect(graph.dependencies.get("animatic:shot.01#narrationStem")).toEqual([
      "animatic:shot.01.narration",
    ]);
  });

  it("gives a narration-only shot no stem to drive motion with", () => {
    const board = boardWith([{ narration: NARRATION }], () => [
      asset("narration", tts, { script: NARRATION }),
    ]);
    expect(board.shots[0]!.stemRefs).toEqual([]);
    expect(() => inBuild(() => board.shot("01").stem)).toThrow(/plays only narration/);
    expect(inBuild(() => board.shot("01").narrationStem.src)).toBe(
      "__konte:animatic:shot.01#narrationStem__",
    );
  });

  it("reads a narration-only shot's only recording as its narration", () => {
    const board = boardWith([{ narration: NARRATION }], () => [
      asset("take", recording, { prompt: "a calm studio read" }),
    ]);
    expect(board.shots[0]!.narrationStemRefs).toEqual(["animatic:shot.01.take"]);
  });

  it("refuses a recording that could be the narration or a sound in the frame", () => {
    expect(() =>
      boardWith(BOTH, () => [
        asset("vo", tts, { script: LINE }),
        asset("take", recording, { prompt: "a calm studio read" }),
      ]),
    ).toThrow(expect.objectContaining({ code: "NARRATION_UNATTRIBUTED" }));
  });

  it("has no narration stem on a shot nobody narrates", () => {
    const board = boardWith([{ character: "ane", text: LINE }], () => [
      asset("vo", tts, { script: LINE }),
    ]);
    expect(() => inBuild(() => board.shot("01").narrationStem)).toThrow(/plays no narration/);
  });

  it("refuses one take saying both the narration and a line", () => {
    expect(() =>
      boardWith(BOTH, () => [asset("both", tts, { script: `${LINE}${NARRATION}` })]),
    ).toThrow(expect.objectContaining({ code: "NARRATION_UNATTRIBUTED" }));
  });

  it("reads a narration quoting a character's words as narration alone", () => {
    const quoted = `${LINE}と、姉は言った。`;
    const board = boardWith([{ character: "ane", text: LINE }, { narration: quoted }], () => [
      asset("vo", tts, { script: LINE }),
      asset("narration", tts, { script: quoted }),
    ]);
    expect(board.shots[0]!.stemRefs).toEqual(["animatic:shot.01.vo"]);
    expect(board.shots[0]!.narrationStemRefs).toEqual(["animatic:shot.01.narration"]);
  });

  it("refuses a board reached outside a build", () => {
    expect(() => boardWithBoth().shot("01")).toThrow(/called outside a build/);
  });
});

describe("the video delivers the board's narration", () => {
  const videoOver = (board: Board, placeNarration: boolean) =>
    defineVideo(directionWith(BOTH), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video
              src={asset("motion", ia2v, {
                image: board.shot("01").image("first"),
                audio: board.shot("01").stem,
              })}
              hasAudio
            />
            {placeNarration && <Audio src={board.shot("01").narrationStem} volume={0.8} />}
          </Composition>
        )),
      }),
    });

  it("places it with <Audio>", () => {
    const board = boardWithBoth();
    const video = videoOver(board, true);
    expect(video.shots[0]!.stemRefs).toContain("animatic:shot.01#narrationStem");
    expect(video.shots[0]!.cueKinds?.["animatic:shot.01#narrationStem"]).toBe("narration");
    expect(() => assertNarrationStemsPlaced(video, board)).not.toThrow();
  });

  it("refuses a developed shot the direction narrates that never places it", () => {
    const board = boardWithBoth();
    expect(() => assertNarrationStemsPlaced(videoOver(board, false), board)).toThrow(
      expect.objectContaining({ code: "NARRATION_UNPLACED" }),
    );
  });

  // Footage alone never reaches the board, and still owes the narration.
  it("refuses a shot built without the board that never places it", () => {
    const video = defineVideo(directionWith(BOTH), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video src={asset("motion", t2v, { prompt: "a girl looks up" })} />
          </Composition>
        )),
      }),
    });
    expect(() => assertNarrationStemsPlaced(video, boardWithBoth())).toThrow(
      expect.objectContaining({ code: "NARRATION_UNPLACED" }),
    );
  });

  it("owes nothing while the shot is still pending", () => {
    const video = defineVideo(directionWith(BOTH), {
      timeline: ({ pendingShot }) => ({ shots: pendingShot("01") }),
    });
    expect(() => assertNarrationStemsPlaced(video, boardWithBoth())).not.toThrow();
  });

  it("refuses it anywhere but an <Audio>", () => {
    const board = boardWithBoth();
    expect(() =>
      defineVideo(directionWith(BOTH), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Video
                src={asset("motion", ia2v, {
                  image: board.shot("01").image("first"),
                  audio: board.shot("01").narrationStem as never,
                })}
                hasAudio
              />
              <Audio src={board.shot("01").narrationStem} />
            </Composition>
          )),
        }),
      }),
    ).toThrow(/placed only with <Audio>/);
  });

  it("does not count placing it as building on the board", () => {
    const board = boardWithBoth();
    const video = defineVideo(directionWith(BOTH), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video src={asset("motion", t2v, { prompt: "a girl looks up" })} />
            <Audio src={board.shot("01").narrationStem} />
          </Composition>
        )),
      }),
    });
    const graph = buildDependencyGraph(video, board);
    expect(listBoardlessVideoShots(video, board, graph)).toEqual([{ shotId: "01", spends: true }]);
  });

  it("is refused by every model input's type", () => {
    const narration = { src: "__konte:animatic:shot.01#narrationStem__" } as NarrationStem;
    // @ts-expect-error — only <Audio> takes a narration stem
    const audio: MediaAsset<"audio"> = narration;
    expect(audio).toBe(narration);
  });
});

describe("a board shot's accept signs off both stems", () => {
  const cues = ["animatic:shot.01.vo", "animatic:shot.01.narration", "animatic:shot.01.slam"];

  async function recorded(): Promise<StateManager> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-narration-stem-"));
    const manager = await StateManager.init(dir);
    for (const address of cues) {
      const name = address.split(".").pop()!;
      await writeSilentWav(path.join(dir, "assets", `${name}.wav`));
      const vid = manager.reserveVariantId(address);
      const variant = manager.getAssetState(address).variants![vid]!;
      variant.file = `assets/${name}.wav`;
      variant.outputHash = name;
      manager.setAccepted(address, vid);
    }
    return manager;
  }

  it("folds the narration stem into the shot's leaves", async () => {
    const manager = await recorded();
    const targets = shotAcceptTargets(manager, boardWithBoth(), {
      shotId: "01",
      pending: false,
      shotFn: () => null,
    });
    expect(targets.stemSources.toSorted()).toEqual(cues.toSorted());
    expect(targets.leaves).toEqual([
      { address: "animatic:shot.01#composition", what: "the composition" },
      { address: "animatic:shot.01#stem", what: "the audio stem" },
      { address: "animatic:shot.01#narrationStem", what: "the narration stem" },
    ]);
  });

  it("mixes the narration stem from the narration alone", async () => {
    const manager = await recorded();
    const board = boardWithBoth();
    const address = "animatic:shot.01#narrationStem";
    const prepared = await prepareShotStem({ manager, video: board, address });
    expect(prepared?.kind).toBe("mix");
    const variantId = await commitShotStem({ manager, video: board, address, prepared: prepared! });
    const variant = manager.getAssetState(address).variants![variantId!]!;
    expect(variant.file).toMatch(/stem\.wav$/);
    expect(variant.inputFingerprints).toEqual({ "animatic:shot.01.narration": "narration" });
  });
});
