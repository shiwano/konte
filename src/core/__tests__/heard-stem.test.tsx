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
  type HeardStem,
} from "../dsl/index.js";
import { collectFindings } from "../checks.js";
import { findingTraits, reviewHold, spendHold } from "../finding.js";
import { buildDependencyGraph, listBoardlessVideoShots } from "../graph.js";
import type { CompositionClip } from "../composition-builder.js";
import type { Direction } from "../dsl/direction.js";
import { findUnplacedStems } from "../heard-stem.js";
import { spokenSourcesOf } from "../line-marks.js";
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
const REPLY = "ひとつだけだよ。";
const NARRATION = "その夏、姉は八つだった。";

type ShotShape = { lineup?: readonly string[]; passing?: readonly string[]; coverage?: true };

const directionWith = (script: readonly ScriptLine[], shape: ShotShape = {}) =>
  defineDirection({
    ...directionDefaults,
    characters: {
      ane: {
        name: "the sister",
        description: "the elder sister",
        voice: { id: "aneVoice", description: "a bright ten-year-old" },
        promptDepiction: "ane",
      },
      haha: {
        name: "the mother",
        description: "the mother",
        voice: { id: "hahaVoice", description: "a warm, tired alto" },
        promptDepiction: "haha",
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
          lineup: shape.lineup ?? ["ane"],
          ...(shape.passing ? { passing: shape.passing } : {}),
          ...(shape.coverage ? { coverage: true as const } : {}),
        },
      ],
    },
  });

type Board = ReturnType<typeof defineAnimatic>;

// One board shot over the given lines, playing each cue `cues` declares.
function boardWith(
  script: readonly ScriptLine[],
  cues: () => Array<MediaAsset<"audio">>,
  shape: ShotShape = {},
): Board {
  return defineAnimatic(directionWith(script, shape), {
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
    ).toThrow(expect.objectContaining({ code: "CUE_UNATTRIBUTED" }));
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
    ).toThrow(expect.objectContaining({ code: "CUE_UNATTRIBUTED" }));
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
    expect(findUnplacedStems(video, board)).toEqual([]);
  });

  it("reads footage beside the placed narration as the footage's own sound", () => {
    const narrated: ScriptLine[] = [{ narration: NARRATION }];
    const board = boardWith(narrated, () => [asset("narration", tts, { script: NARRATION })]);
    const video = defineVideo(directionWith(narrated), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video src={asset("motion", t2v, { prompt: "rain on a deck" })} hasAudio />
            <Audio src={board.shot("01").narrationStem} />
          </Composition>
        )),
      }),
    });
    expect(video.shots[0]!.cueKinds?.["video:shot.01.motion"]).toBe("sfx");
  });

  it("still reads footage as the recording of a line the narration leaves", () => {
    const video = videoOver(boardWithBoth(), true);
    expect(video.shots[0]!.cueKinds?.["video:shot.01.motion"]).toBe("voice");
  });

  it("finds a developed shot the direction narrates that never places it", () => {
    const board = boardWithBoth();
    expect(findUnplacedStems(videoOver(board, false), board)).toEqual([
      { address: "animatic:shot.01#narrationStem", shotId: "01", accessor: "narrationStem" },
    ]);
  });

  // Footage alone never reaches the board, and still owes the narration.
  it("finds a shot built without the board that never places it", () => {
    const video = defineVideo(directionWith(BOTH), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video src={asset("motion", t2v, { prompt: "a girl looks up" })} />
          </Composition>
        )),
      }),
    });
    expect(findUnplacedStems(video, boardWithBoth())).toHaveLength(1);
  });

  it("owes nothing while the shot is still pending", () => {
    const video = defineVideo(directionWith(BOTH), {
      timeline: ({ pendingShot }) => ({ shots: pendingShot("01") }),
    });
    expect(findUnplacedStems(video, boardWithBoth())).toEqual([]);
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
    ).toThrow(/place each only with <Audio>/);
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
    const narration = { src: "__konte:animatic:shot.01#narrationStem__" } as HeardStem;
    // @ts-expect-error — only <Audio> takes a narration stem
    const audio: MediaAsset<"audio"> = narration;
    expect(audio).toBe(narration);
  });
});

describe("a board shot's accept signs off both stems", () => {
  const cues = ["animatic:shot.01.vo", "animatic:shot.01.narration", "animatic:shot.01.slam"];

  async function recorded(): Promise<StateManager> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-heard-stem-"));
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

// The sister is in the frame, her mother answers from off it.
const EXCHANGE: ScriptLine[] = [
  { character: "ane", text: LINE },
  { character: "haha", text: REPLY },
];

const boardWithExchange = (shape: ShotShape = {}) =>
  boardWith(
    EXCHANGE,
    () => [
      asset("vo", tts, { script: LINE }),
      asset("reply", tts, { script: REPLY }),
      asset("slam", recording, { prompt: "a door slamming" }),
    ],
    shape,
  );

describe("the board mixes the lines of a character off its frame apart", () => {
  it("keeps them out of the stem a motion model takes", () => {
    const board = boardWithExchange();
    const shot = board.shots[0]!;
    expect(shot.stemRefs).toEqual(["animatic:shot.01.vo", "animatic:shot.01.slam"]);
    expect(shot.offFrameStemRefs).toEqual(["animatic:shot.01.reply"]);
    expect(shot.cueKinds?.["animatic:shot.01.reply"]).toBe("voice");
    expect(listStemAddresses(board)).toEqual([
      "animatic:shot.01#stem",
      "animatic:shot.01#offFrameStem",
    ]);
    const graph = buildDependencyGraph(board);
    expect(graph.dependencies.get("animatic:shot.01#offFrameStem")).toEqual([
      "animatic:shot.01.reply",
    ]);
    expect(inBuild(() => board.shot("01").offFrameStem.src)).toBe(
      "__konte:animatic:shot.01#offFrameStem__",
    );
  });

  it("reads every character the lineup holds as in the frame", () => {
    const board = boardWithExchange({ lineup: ["ane", "haha"] });
    expect(board.shots[0]!.offFrameStemRefs).toBeUndefined();
  });

  it("reads a character passing through the frame as in it", () => {
    const board = boardWithExchange({ passing: ["haha"] });
    expect(board.shots[0]!.offFrameStemRefs).toBeUndefined();
  });

  it("keeps every line in the stem of a coverage shot", () => {
    const board = boardWithExchange({ coverage: true });
    expect(board.shots[0]!.stemRefs).toContain("animatic:shot.01.reply");
    expect(board.shots[0]!.offFrameStemRefs).toBeUndefined();
  });

  it("reads a character passing through the frame as in it", () => {
    const board = boardWithExchange({ passing: ["haha"] });
    expect(board.shots[0]!.offFrameStemRefs).toBeUndefined();
  });

  it("keeps the lines of a shot nobody in the frame speaks in on its stem", () => {
    const board = boardWith([{ character: "haha", text: REPLY }], () => [
      asset("reply", tts, { script: REPLY }),
    ]);
    expect(board.shots[0]!.stemRefs).toEqual(["animatic:shot.01.reply"]);
    expect(board.shots[0]!.offFrameStemRefs).toBeUndefined();
  });

  it("splits them off a stem that keeps a sound of the frame", () => {
    const board = boardWith([{ character: "haha", text: REPLY }], () => [
      asset("reply", tts, { script: REPLY }),
      asset("slam", recording, { prompt: "a door slamming" }),
    ]);
    expect(board.shots[0]!.stemRefs).toEqual(["animatic:shot.01.slam"]);
    expect(board.shots[0]!.offFrameStemRefs).toEqual(["animatic:shot.01.reply"]);
  });

  it("refuses a recording that could be the off-frame line or a sound in the frame", () => {
    expect(() =>
      boardWith(EXCHANGE, () => [
        asset("vo", tts, { script: LINE }),
        asset("take", recording, { prompt: "a warm read" }),
      ]),
    ).toThrow(expect.objectContaining({ code: "CUE_UNATTRIBUTED" }));
  });

  it("refuses one take saying a line in the frame and one off it", () => {
    expect(() =>
      boardWith(EXCHANGE, () => [asset("both", tts, { script: `${LINE}${REPLY}` })]),
    ).toThrow(expect.objectContaining({ code: "CUE_UNATTRIBUTED" }));
  });

  it("keeps a take on the stem where an off-frame line reads like one in the frame", () => {
    const board = boardWith(
      [
        { character: "ane", text: REPLY },
        { character: "haha", text: REPLY },
      ],
      () => [asset("vo", tts, { script: REPLY }), asset("reply", tts, { script: REPLY })],
    );
    expect(board.shots[0]!.stemRefs).toEqual(["animatic:shot.01.vo", "animatic:shot.01.reply"]);
    expect(board.shots[0]!.offFrameStemRefs).toBeUndefined();
  });

  it("has no off-frame stem on a shot whose speakers are all in the frame", () => {
    const board = boardWith([{ character: "ane", text: LINE }], () => [
      asset("vo", tts, { script: LINE }),
    ]);
    expect(() => inBuild(() => board.shot("01").offFrameStem)).toThrow(/no off-frame stem/);
  });
});

describe("the video delivers the board's off-frame lines", () => {
  const videoOver = (board: Board, place: boolean) =>
    defineVideo(directionWith(EXCHANGE), {
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
            {place && <Audio src={board.shot("01").offFrameStem} />}
          </Composition>
        )),
      }),
    });

  it("places them with <Audio> as a voice", () => {
    const board = boardWithExchange();
    const video = videoOver(board, true);
    expect(video.shots[0]!.cueKinds?.["animatic:shot.01#offFrameStem"]).toBe("voice");
    expect(video.shots[0]!.cueKinds?.["video:shot.01.motion"]).toBe("voice");
    expect(findUnplacedStems(video, board)).toEqual([]);
  });

  it("finds a developed shot that never places them", () => {
    const board = boardWithExchange();
    expect(findUnplacedStems(videoOver(board, false), board)).toEqual([
      { address: "animatic:shot.01#offFrameStem", shotId: "01", accessor: "offFrameStem" },
    ]);
  });

  it("refuses them anywhere but an <Audio>", () => {
    const board = boardWithExchange();
    expect(() =>
      defineVideo(directionWith(EXCHANGE), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Video
                src={asset("motion", ia2v, {
                  image: board.shot("01").image("first"),
                  audio: board.shot("01").offFrameStem as never,
                })}
                hasAudio
              />
            </Composition>
          )),
        }),
      }),
    ).toThrow(/place each only with <Audio>/);
  });

  it("reports the unplaced stem as stem-unplaced, holding the shot", async () => {
    const board = boardWithExchange();
    const traits = findingTraits("stem-unplaced");
    const { findings } = await collectFindings(
      {
        videoRoot: "",
        direction: null,
        directionAccepted: true,
        reference: null,
        animatic: board,
        video: videoOver(board, false),
        manager: null,
        graph: null,
        patches: [],
        lang: null,
      },
      (t) => t === traits,
    );
    const [finding] = findings.filter((f) => f.code === "stem-unplaced");
    expect(finding).toMatchObject({
      subject: "animatic:shot.01#offFrameStem",
      fixIn: { stage: "video" },
      message: '<Audio src={animatic.shot("01").offFrameStem} />',
      targets: ["video:shot.01"],
    });
    expect(reviewHold(finding!, { op: "accept", address: "video:shot.01#composition" })).toBe(true);
    expect(reviewHold(finding!, { op: "preview", stage: "video" })).toBe(true);
    expect(spendHold(finding!, { command: "export", stage: "video" })).toBe("whole");
    expect(spendHold(finding!, { command: "generate", stage: "video" })).toBeNull();
  });

  it("hears both lines in a stem mixed before the off-frame one was split out", async () => {
    const board = boardWithExchange();
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-heard-stem-"));
    const manager = await StateManager.init(dir);
    const address = "animatic:shot.01#stem";
    const vid = manager.reserveVariantId(address);
    const variant = manager.getAssetState(address).variants![vid]!;
    variant.file = "assets/mix.wav";
    variant.outputHash = "mix";
    variant.definitionHash = "before-the-split";
    variant.inputFingerprints = { "animatic:shot.01.vo": "vo", "animatic:shot.01.reply": "reply" };
    const [source] = spokenSourcesOf({ address, variantId: vid } as CompositionClip, {
      manager,
      definitions: { animatic: board },
      direction: directionWith(EXCHANGE) as unknown as Direction,
      animatic: board,
    });
    expect(source?.lines?.map((line) => line.text)).toEqual([LINE, REPLY]);
  });

  it("folds the off-frame stem into the board shot's leaves", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-heard-stem-"));
    const manager = await StateManager.init(dir);
    const targets = shotAcceptTargets(manager, boardWithExchange(), {
      shotId: "01",
      pending: false,
      shotFn: () => null,
    });
    expect(targets.leaves).toContainEqual({
      address: "animatic:shot.01#offFrameStem",
      what: "the off-frame stem",
    });
  });
});
