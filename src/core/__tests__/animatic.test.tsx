import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { inBuild } from "./helpers/build.js";
import {
  formatCompositionAddress,
  formatShotStemAddress,
  isCompositionAddress,
  isMaterializedLeafAddress,
} from "../address.js";
import {
  type AnimaticOverflow,
  findAnimaticOverflows,
  formatAnimaticOverflow,
} from "../animatic-overflow.js";
import { harvestShotAudioStructure } from "../composition-builder.js";
import {
  compositionDefinitionHash,
  stemDefinitionHash,
  timelineStemRefs,
} from "../composition-resource.js";
import { Audio, Composition, Image, Panel, Video } from "../dsl/composition/index.js";
import { defineDirection } from "../dsl/direction.js";
import { asset, defineAnimatic, defineVideo, soundtrack } from "../dsl/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { buildDependencyGraph, listUnusedAssetPaths } from "../graph.js";
import { StateManager } from "../state/index.js";
import { directionDefaults } from "./helpers/direction.js";
import type { VariantMedia, VideoDefinition } from "../types/index.js";
import type { ShotScript } from "../dsl/shot-script.js";

const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

// A plain motion model, for the case that tries to hide one inside the animatic.
const motionComfy = defineComfyAsset({
  workflow: "motion.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const stillComfy = defineComfyAsset({
  workflow: "still.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

// An audio-driven motion model: the shape the whole stem mechanism exists for.
const ia2vComfy = defineComfyAsset({
  workflow: "ia2v.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    audio: { nodeId: "2", field: "audio", type: "audio" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// One shot, 4s, with a spoken line — every rule here turns on that line existing.
function direction(
  opts: { script?: boolean; telop?: boolean; duration?: number } = { script: true },
) {
  return defineDirection({
    ...directionDefaults,
    characters: {
      cat: {
        name: "the cat",
        description: "a black cat",
        voice: { id: "catvoice", description: "a small dry voice" },
        promptDepiction: "cat",
      },
    },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        {
          id: "01",
          role: "hero",
          action: "the cat speaks",
          setup: "front",
          duration: opts.duration ?? 4,
          ...(opts.script ? { script: [{ character: "cat", text: "meow" }] as const } : {}),
          ...(opts.telop ? { telop: ["第一話"] } : {}),
          lineup: [],
        },
      ],
    },
  });
}

// The canonical shape: the board sounds the line over its keyframe, and the video drives an IA2V
// model with the mixed-down stem.
function speakingAnimatic() {
  return defineAnimatic(direction(), {
    timeline: ({ shot }) => ({
      shots: shot("01", ({ script }) => (
        <Composition>
          <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
          <Audio
            src={asset("vo", ttsComfy, { text: (script as ShotScript).cat?.[0] ?? "" })}
            start={0.2}
          />
        </Composition>
      )),
    }),
  });
}

function speakingVideo(animatic = speakingAnimatic()): VideoDefinition {
  return defineVideo(direction(), {
    timeline: ({ shot }) => ({
      shots: shot("01", () => (
        <Composition>
          <Video
            src={asset("motion", ia2vComfy, {
              image: animatic.shot("01").image("still"),
              audio: animatic.shot("01").stem,
            })}
            hasAudio
          />
        </Composition>
      )),
    }),
  });
}

describe("animatic addresses", () => {
  it("reads the composition and the stem as leaves", () => {
    expect(isCompositionAddress("animatic:shot.01#composition")).toBe(true);
    expect(isMaterializedLeafAddress("animatic:shot.01#composition")).toBe(true);
    expect(isMaterializedLeafAddress("animatic:shot.01#stem")).toBe(true);
    expect(formatCompositionAddress("animatic", "01")).toBe("animatic:shot.01#composition");
    expect(formatShotStemAddress("animatic", "01")).toBe("animatic:shot.01#stem");
  });
});

describe("defineAnimatic", () => {
  it("keeps the stem out of the pool and names its cues on stemRefs", () => {
    const shot = speakingAnimatic().shots[0]!;
    expect(Object.keys(shot.assets).sort()).toEqual(["still", "vo"]);
    expect(shot.stemRefs).toEqual(["animatic:shot.01.vo"]);
    expect(shot.shotFn).toBeTypeOf("function");
  });

  it("records each <Panel> as a keyframe with its window", () => {
    const animatic = defineAnimatic(direction({ script: false }), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("first", stillComfy, { prompt: "a" })} blocking="she turns" />
            <Panel src={asset("last", stillComfy, { prompt: "b" })} />
          </Composition>
        )),
      }),
    });
    // A 4s shot, two panels, no declared starts: an even split, each holding to the next cut.
    expect(animatic.shots[0]!.panels).toEqual([
      {
        assetName: "first",
        assetPath: "animatic:shot.01.first",
        start: 0,
        duration: 2,
        blocking: "she turns",
      },
      { assetName: "last", assetPath: "animatic:shot.01.last", start: 2, duration: 2 },
    ]);
  });

  it("pins a declared start and runs the panel before it up to that cut", () => {
    const animatic = defineAnimatic(direction({ script: false }), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("first", stillComfy, { prompt: "a" })} blocking="she turns" />
            <Panel src={asset("last", stillComfy, { prompt: "b" })} start={3} />
          </Composition>
        )),
      }),
    });
    expect(animatic.shots[0]!.panels?.map((p) => [p.start, p.duration])).toEqual([
      [0, 3],
      [3, 1],
    ]);
  });

  // A pin bounds its neighbours rather than being laid over a fixed whole-shot grid: on a 4s shot
  // the grid would put the third panel at 2.67s, before the pin, and fail its own monotonic check.
  it("divides only what the pins leave, so a pin never crowds the panel after it", () => {
    const animatic = defineAnimatic(direction({ script: false }), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("first", stillComfy, { prompt: "a" })} />
            <Panel src={asset("mid", stillComfy, { prompt: "b" })} start={3} />
            <Panel src={asset("last", stillComfy, { prompt: "c" })} />
          </Composition>
        )),
      }),
    });
    expect(animatic.shots[0]!.panels?.map((p) => [p.start, p.duration])).toEqual([
      [0, 3],
      [3, 0.5],
      [3.5, 0.5],
    ]);
  });

  it("still divides the whole shot evenly when nothing is pinned", () => {
    const animatic = defineAnimatic(direction({ script: false }), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("a", stillComfy, { prompt: "a" })} />
            <Panel src={asset("b", stillComfy, { prompt: "b" })} />
            <Panel src={asset("c", stillComfy, { prompt: "c" })} />
          </Composition>
        )),
      }),
    });
    expect(animatic.shots[0]!.panels?.map((p) => p.start)).toEqual([0, 4 / 3, 8 / 3]);
  });

  it("identifies the stem by the shot's cues and duration", () => {
    const animatic = speakingAnimatic();
    expect(harvestShotAudioStructure(animatic, "01")).toMatchObject([
      { src: "animatic:shot.01.vo", start: 0.2 },
    ]);
    // The clamp is the direction's duration, not the TTS take's — the direction decides how long the
    // shot runs, so a retimed shot is a different stem.
    const hash = stemDefinitionHash(animatic, "animatic:shot.01#stem");
    expect(hash).not.toBe("");
    expect(stemDefinitionHash(speakingAnimatic(), "animatic:shot.01#stem")).toBe(hash);
    const retimed = defineAnimatic(direction({ script: true, duration: 6 }), {
      timeline: ({ shot }) => ({
        shots: shot("01", ({ script }) => (
          <Composition>
            <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
            <Audio
              src={asset("vo", ttsComfy, { text: (script as ShotScript).cat?.[0] ?? "" })}
              start={0.2}
            />
          </Composition>
        )),
      }),
    });
    expect(stemDefinitionHash(retimed, "animatic:shot.01#stem")).not.toBe(hash);
  });

  it("keeps the timeline stem's identity when a line under a ducking bed moves", () => {
    const withLineAt = (start: number) =>
      defineAnimatic(direction(), {
        timeline: ({ shot }) => ({
          shots: shot("01", ({ script }) => (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
              <Audio
                src={asset("vo", ttsComfy, { text: (script as ShotScript).cat?.[0] ?? "" })}
                start={start}
              />
            </Composition>
          )),
          soundtracks: [
            soundtrack("bed", asset("bgm", ttsComfy, { text: "music" }), { duck: true }),
          ],
        }),
      });
    const hash = stemDefinitionHash(withLineAt(0.2), "animatic:timeline#stem");
    expect(hash).not.toBe("");
    expect(stemDefinitionHash(withLineAt(1), "animatic:timeline#stem")).toBe(hash);
    expect(timelineStemRefs(withLineAt(1))).toEqual(["animatic:timeline.bgm"]);
  });

  // Two cues on one take are two placements, in order — the mix must not dedupe them into one.
  it("keeps one placement per cue when the same take is played twice", () => {
    const animatic = defineAnimatic(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => {
          const vo = asset("vo", ttsComfy, { text: "meow" });
          return (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
              <Audio src={vo} start={0} />
              <Audio src={vo} start={2} />
            </Composition>
          );
        }),
      }),
    });
    expect(harvestShotAudioStructure(animatic, "01")).toMatchObject([
      { src: "animatic:shot.01.vo", start: 0 },
      { src: "animatic:shot.01.vo", start: 2 },
    ]);
    // One edge, though — the graph dedupes what the mix repeats.
    expect(buildDependencyGraph(animatic).dependencies.get("animatic:shot.01#stem")).toEqual([
      "animatic:shot.01.vo",
    ]);
  });

  it("wires the stem into the video build as a real cross-stage edge", () => {
    const animatic = speakingAnimatic();
    const graph = buildDependencyGraph(speakingVideo(animatic), animatic);
    expect(graph.dependencies.get("video:shot.01.motion")).toContain("animatic:shot.01#stem");
    expect(graph.dependencies.get("animatic:shot.01#stem")).toEqual(["animatic:shot.01.vo"]);
    // The animatic composition is a leaf over everything it shows.
    expect([...(graph.dependencies.get("animatic:shot.01#composition") ?? [])].sort()).toEqual([
      "animatic:shot.01.still",
      "animatic:shot.01.vo",
    ]);
  });

  it("counts the board's takes as used — its composition is a review root of its own", () => {
    const animatic = speakingAnimatic();
    const video = speakingVideo(animatic);
    expect(listUnusedAssetPaths(video, animatic, buildDependencyGraph(video, animatic))).toEqual(
      [],
    );
  });
});

describe("animatic definition errors", () => {
  it("refuses a scripted shot that plays no audio", () => {
    expect(() =>
      defineAnimatic(direction(), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
            </Composition>
          )),
        }),
      }),
    ).toThrow(/has spoken lines in the direction but plays no audio/);
  });

  it("lets a telop-only shot through silent — nobody speaks it", () => {
    expect(() =>
      defineAnimatic(direction({ telop: true }), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
            </Composition>
          )),
        }),
      }),
    ).not.toThrow();
  });

  it("refuses a developed shot with no <Panel> — a board shot IS its keyframes", () => {
    expect(() =>
      defineAnimatic(direction({ script: false }), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Image src={asset("plate", stillComfy, { prompt: "a wall" })} />
            </Composition>
          )),
        }),
      }),
    ).toThrow(/declares no <Panel>/);
  });

  it("refuses panel starts that do not increase, or fall outside the shot", () => {
    const withStarts = (a: number, b: number) => () =>
      defineAnimatic(direction({ script: false }), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("first", stillComfy, { prompt: "a" })} start={a} />
              <Panel src={asset("last", stillComfy, { prompt: "b" })} start={b} />
            </Composition>
          )),
        }),
      });
    expect(withStarts(2, 1)).toThrow(/starts must increase/);
    expect(withStarts(0, 9)).toThrow(/outside the shot/);
  });

  it("refuses a <Video> — it would be a place to hide the motion spend", () => {
    expect(() =>
      defineAnimatic(direction({ script: false }), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
              <Video src={asset("sneaky", motionComfy, { prompt: "a cat" })} />
            </Composition>
          )),
        }),
      }),
    ).toThrow(/renders a <video>/);
  });

  // The ban is on the SURFACE, so raw HTML must not restore it: a placeholder inside
  // dangerouslySetInnerHTML is substituted at render like any other src.
  it("refuses a <video> smuggled in through raw HTML", () => {
    expect(() =>
      defineAnimatic(direction({ script: false }), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
              <div
                dangerouslySetInnerHTML={{
                  __html: `<video src="__konte:animatic:shot.01.sneaky__"></video>`,
                }}
              />
            </Composition>
          )),
        }),
      }),
    ).toThrow(/emits a raw <video>/);
  });

  // Raw <audio> is the quieter half of the same hole: it would play in the review while contributing
  // no cue, so the human would judge audio the motion model never receives.
  it("refuses an <audio> smuggled in through raw HTML", () => {
    expect(() =>
      defineAnimatic(direction(), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
              <Audio src={asset("vo", ttsComfy, { text: "meow" })} />
              <div dangerouslySetInnerHTML={{ __html: `<audio src="x.mp3"></audio>` }} />
            </Composition>
          )),
        }),
      }),
    ).toThrow(/emits a raw <audio>/);
  });

  // A cue konte cannot resolve cannot be in the stem, and silently re-encoding it as a placeholder
  // would surface as a missing-dependency error about a URL.
  it("refuses a cue whose source is not a konte asset", () => {
    expect(() =>
      defineAnimatic(direction(), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
              <Audio src={{ src: "https://cdn.example/line.mp3" }} />
            </Composition>
          )),
        }),
      }),
    ).toThrow(/is not a konte asset/);
  });

  it("refuses .stem on a shot that plays no audio", () => {
    const silent = defineAnimatic(direction({ script: false }), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
          </Composition>
        )),
      }),
    });
    expect(() => inBuild(() => silent.shot("01").stem)).toThrow(
      /plays no audio, so it has no stem/,
    );
  });

  it("refuses an unknown take name, and one of the wrong kind", () => {
    const animatic = speakingAnimatic();
    expect(() => inBuild(() => animatic.shot("01").image("nope"))).toThrow(
      /declares no asset named "nope"/,
    );
    expect(() => inBuild(() => animatic.shot("01").image("vo"))).toThrow(/is audio, not image/);
  });
});

describe("composition definition hash", () => {
  // The audio is the reason the animatic exists, so its hash tracks it — unlike the delivered
  // composition's, which strips audio so a placement edit never churns the picture.
  const boardAt = (start: number) =>
    defineAnimatic(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
            <Audio src={asset("vo", ttsComfy, { text: "meow" })} start={start} />
          </Composition>
        )),
      }),
    });

  it("moves on an audio placement edit in the animatic", () => {
    expect(compositionDefinitionHash(boardAt(0.2), "01")).not.toBe(
      compositionDefinitionHash(boardAt(1.5), "01"),
    );
  });

  it("holds across an audio-only edit in the delivered composition", () => {
    const videoAt = (start: number) =>
      defineVideo(direction({ script: false }), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Video src={asset("motion", motionComfy, { prompt: "a cat" })} />
              <Audio src={asset("sfx", ttsComfy, { text: "meow" })} start={start} />
            </Composition>
          )),
        }),
      });
    expect(compositionDefinitionHash(videoAt(0.2), "01")).toBe(
      compositionDefinitionHash(videoAt(1.5), "01"),
    );
  });

  it("moves when a panel's cut moves", () => {
    const at = (start: number) =>
      defineAnimatic(direction({ script: false }), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Panel src={asset("first", stillComfy, { prompt: "a" })} />
              <Panel src={asset("last", stillComfy, { prompt: "b" })} start={start} />
            </Composition>
          )),
        }),
      });
    expect(compositionDefinitionHash(at(2), "01")).not.toBe(compositionDefinitionHash(at(3), "01"));
  });
});

// The one surface that tells a truncated stem from one that fits.
describe("animatic overflow", () => {
  const VO = "animatic:shot.01.vo";

  // Two cues over the same shot, so one can be measured while the other is not.
  function twoCueAnimatic() {
    return defineAnimatic(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
            <Audio src={asset("vo", ttsComfy, { text: "meow" })} start={0.2} />
            <Audio src={asset("vo2", ttsComfy, { text: "mrrp" })} start={1} />
          </Composition>
        )),
      }),
    });
  }

  // The shot is 4s and its line starts at 0.2s, so a vo longer than 3.8s is cut.
  async function overflowsWithVo(
    media: VariantMedia | undefined,
    animatic: ReturnType<typeof speakingAnimatic> = speakingAnimatic(),
  ): Promise<AnimaticOverflow[]> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "konte-animatic-overflow-"));
    try {
      const manager = await StateManager.init(tmp);
      if (media) {
        const id = manager.reserveVariantId(VO);
        Object.assign(manager.getAssetState(VO).variants![id]!, {
          file: "vo.mp3",
          outputHash: "vo-1",
          media,
        });
        manager.setAccepted(VO, id);
      }
      return findAnimaticOverflows(animatic, manager);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  const vo = (durationSec: number): VariantMedia => ({
    kind: "audio",
    durationSec,
    channels: 1,
    sampleRate: 24000,
  });

  it("reports what the clamp cuts, and where", async () => {
    const [overflow, ...rest] = await overflowsWithVo(vo(5.6));
    expect(rest).toEqual([]);
    expect(overflow).toMatchObject({
      shotId: "01",
      address: "animatic:shot.01#stem",
      durationSec: 4,
      // 0.2s lead-in + 5.6s of line.
      neededSec: 5.8,
      unmeasuredCues: 0,
    });
    expect(overflow?.overflowSec).toBeCloseTo(1.8, 5);
    expect(formatAnimaticOverflow(overflow!)).toBe(
      "narration truncated by 1.8s — 5.8s of audio in a 4.0s shot",
    );
  });

  it("says nothing about a line that fits, or one under the floor", async () => {
    expect(await overflowsWithVo(vo(3.8))).toEqual([]);
    expect(await overflowsWithVo(vo(2))).toEqual([]);
    expect(await overflowsWithVo(vo(3.85))).toEqual([]);
  });

  // A cue's own `duration` is an atrim, which shortens a take and never pads one — so the take's
  // length still decides where it ends. Reading the declared length instead would report a
  // truncation that is not happening, and send someone to retime a shot that is fine.
  it("bounds a cue by its take, not by the length the cue asks for", async () => {
    const trimmed = defineAnimatic(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
            <Audio src={asset("vo", ttsComfy, { text: "meow" })} start={0.2} duration={20} />
          </Composition>
        )),
      }),
    });
    expect(await overflowsWithVo(vo(2), trimmed)).toEqual([]);
    // ...and the trim still binds when the take is the longer of the two.
    const [overflow] = await overflowsWithVo(vo(30), trimmed);
    expect(overflow?.neededSec).toBe(20.2);
  });

  // A cue mixed at zero is in the stem and in nobody's ears: a warning over it would send someone
  // to move a shot for audio that was never audible.
  it("says nothing about a cue mixed at zero", async () => {
    const muted = defineAnimatic(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
            <Audio src={asset("vo", ttsComfy, { text: "meow" })} start={0.2} volume={0} />
          </Composition>
        )),
      }),
    });
    expect(await overflowsWithVo(vo(5.6), muted)).toEqual([]);
  });

  // The report is a floor, never a guess: an unmeasured take could be any length, so it neither
  // counts as fitting nor as overrunning.
  it("holds its peace on a take it cannot measure", async () => {
    expect(await overflowsWithVo(undefined)).toEqual([]);
    expect(await overflowsWithVo({ kind: "image", width: 8, height: 8 })).toEqual([]);
  });

  // ...but once another cue proves the shot overruns, the unmeasured one is named: what is cut is
  // at least this much.
  it("names the cues it could not measure alongside an overrun it could", async () => {
    const [overflow] = await overflowsWithVo(vo(5.6), twoCueAnimatic());
    expect(overflow).toMatchObject({ overflowSec: expect.closeTo(1.8, 5), unmeasuredCues: 1 });
    expect(formatAnimaticOverflow(overflow!)).toBe(
      "narration truncated by 1.8s — 5.8s of audio in a 4.0s shot (1 cue(s) not measured yet)",
    );
  });
});
