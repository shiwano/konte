import { describe, expect, it } from "vitest";
import {
  Audio,
  Composition,
  Panel,
  Video,
  asset,
  defineAnimatic,
  defineDirection,
  respell,
} from "../dsl/index.js";
import { shotCueLevels } from "../audio-level.js";
import type { KonteState } from "../types/index.js";
import { collectShotAudioCues } from "../timeline-audio.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { runInRenderMode } from "../dsl/shot-context.js";
import { HARVEST_TYPOGRAPHY, renderToHtml } from "../jsx-html.js";
import { harvestAudioStructure } from "../composition-builder.js";
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

const motion = defineComfyAsset({
  workflow: "motion.json",
  description: "test motion adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// No words anywhere in its inputs: a door slam, a whoosh.
const sfx = defineComfyAsset({
  workflow: "sfx.json",
  description: "test sound-effect adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const LINE = "かあちゃん、飴だまちょうだい。";
const CROWD = "わあっ";

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

// One board over the given direction, whose shot declares `cues` and plays each as an <Audio>.
function cueKindsOf(script: readonly ScriptLine[], cues: () => string[]): Record<string, string> {
  let names: string[] = [];
  const definition = defineAnimatic(directionWith(script), {
    timeline: ({ shot }) => ({
      shots: shot("01", () => {
        asset("first", image, { prompt: "a girl on a deck" });
        names = cues();
        return (
          <Composition>
            <Panel src={{ src: "__konte:animatic:shot.01.first__" } as never} />
            {names.map((n) => (
              <Audio key={n} src={{ src: `__konte:animatic:shot.01.${n}__` } as never} />
            ))}
          </Composition>
        );
      }),
    }),
  });
  return (definition.shots[0]?.cueKinds ?? {}) as Record<string, string>;
}

describe("a cue's kind is read off the direction", () => {
  it("calls a cue carrying a character's line a voice", () => {
    expect(
      cueKindsOf([{ character: "ane", text: LINE }], () => {
        asset("vo", tts, { script: LINE });
        return ["vo"];
      }),
    ).toEqual({ "animatic:shot.01.vo": "voice" });
  });

  // A respelling is the line, so the cue reading it is the line's voice.
  it("reads a cue through the spelling the take declared", () => {
    expect(
      cueKindsOf([{ character: "ane", text: LINE }], () => {
        asset("vo", tts, { script: respell(LINE, "かあちゃん、飴玉ちょうだい。") });
        return ["vo"];
      }),
    ).toEqual({ "animatic:shot.01.vo": "voice" });
  });

  it("calls a cue carrying a mob's line a mob — the direction already calls it a texture", () => {
    expect(
      cueKindsOf([{ speaker: "群衆", text: CROWD }], () => {
        asset("crowd", tts, { script: CROWD });
        return ["crowd"];
      }),
    ).toEqual({ "animatic:shot.01.crowd": "mob" });
  });

  // The longest MATCH decides, not the longest line: a respelling may be far shorter than the words
  // it stands for.
  it("ranks a cue by the spelling it carries, not by the line behind it", () => {
    expect(
      cueKindsOf(
        [
          { speaker: "群衆", text: "はい、と長い唱和がひとしきり続く" },
          { character: "ane", text: "はい、先生" },
        ],
        () => {
          asset("vo", tts, { script: "はい、先生" });
          respell("はい、と長い唱和がひとしきり続く", "はい");
          return ["vo"];
        },
      ),
    ).toEqual({ "animatic:shot.01.vo": "voice" });
  });

  it("calls a wordless cue beside a spoken one sfx", () => {
    expect(
      cueKindsOf([{ character: "ane", text: LINE }], () => {
        asset("vo", tts, { script: LINE });
        asset("slam", sfx, { prompt: "a door slamming" });
        return ["vo", "slam"];
      }),
    ).toEqual({
      "animatic:shot.01.vo": "voice",
      "animatic:shot.01.slam": "sfx",
    });
  });

  it("calls a shot's only, wordless cues voices — they are the recording of its lines", () => {
    expect(
      cueKindsOf([{ character: "ane", text: LINE }], () => {
        asset("take", sfx, { prompt: "a clean studio read" });
        return ["take"];
      }),
    ).toEqual({ "animatic:shot.01.take": "voice" });
  });

  it("matches the longest line a cue's words contain, not the first", () => {
    // The mob's line contains the character's, so a first-match rule would call the mob a voice.
    expect(
      cueKindsOf(
        [
          { character: "ane", text: "はい" },
          { speaker: "群衆", text: "はい、ただいま" },
        ],
        () => {
          asset("vo", tts, { script: "はい" });
          asset("crowd", tts, { script: "はい、ただいま" });
          return ["vo", "crowd"];
        },
      ),
    ).toEqual({
      "animatic:shot.01.vo": "voice",
      "animatic:shot.01.crowd": "mob",
    });
  });

  it("falls back to voice when a character and the mob are given the same words", () => {
    expect(
      cueKindsOf(
        [
          { character: "ane", text: "はい" },
          { speaker: "群衆", text: "はい" },
        ],
        () => {
          asset("vo", tts, { script: "はい" });
          return ["vo"];
        },
      ),
    ).toEqual({ "animatic:shot.01.vo": "voice" });
  });

  it("calls a wordless cue on a shot with no lines sfx", () => {
    expect(
      cueKindsOf([], () => {
        asset("slam", sfx, { prompt: "a door slamming" });
        return ["slam"];
      }),
    ).toEqual({ "animatic:shot.01.slam": "sfx" });
  });
});

const cueOnly = () => {
  const vo = asset("vo", tts, { script: LINE });
  return (
    <Composition>
      <Audio src={vo} volume={0.5} />
    </Composition>
  );
};

const CONTEXT = {
  shotId: "01",
  width: 640,
  height: 360,
  duration: 3,
  typography: HARVEST_TYPOGRAPHY,
};
const FILES = { vo: "/abs/vo.wav" };

describe("levelling reaches the mix without moving the stem's identity", () => {
  it("folds the gain into data-volume in a render", () => {
    const jsx = runInRenderMode("animatic", "01", cueOnly, FILES, FILES);
    expect(renderToHtml(jsx, { ...CONTEXT, levelGains: { "/abs/vo.wav": 2 } })).toContain(
      'data-volume="1"',
    );
  });

  it("emits the declared volume when nothing was measured", () => {
    const jsx = runInRenderMode("animatic", "01", cueOnly, FILES, FILES);
    expect(renderToHtml(jsx, CONTEXT)).toContain('data-volume="0.5"');
  });

  // The stem's identity is harvested from a render carrying no gains — which is what keeps a
  // re-measured take from ageing out the composition it sits in.
  it("harvests the declared volume, the gains being a render-side thing only", () => {
    const jsx = runInRenderMode("animatic", "01", cueOnly, FILES, FILES);
    expect(harvestAudioStructure(jsx, CONTEXT)).toEqual([
      expect.objectContaining({ src: "/abs/vo.wav", volume: 0.5 }),
    ]);
  });
});

describe("an SE's lead-in reaches the mix without moving the stem's identity", () => {
  const SLAM = { slam: "/abs/slam.wav" };
  const slamAt = (mediaStart?: number) => () => {
    const slam = asset("slam", sfx, { prompt: "a door slamming" });
    return (
      <Composition>
        <Audio src={slam} start={0.8} mediaStart={mediaStart} />
      </Composition>
    );
  };
  const LEAD_INS = { "/abs/slam.wav": 0.105 };

  it("skips the take's lead-in so `start` lands the sound", () => {
    const jsx = runInRenderMode("animatic", "01", slamAt(), SLAM, SLAM);
    expect(renderToHtml(jsx, { ...CONTEXT, leadIns: LEAD_INS })).toContain(
      'data-media-start="0.105"',
    );
  });

  it("keeps a declared mediaStart over the measured lead-in", () => {
    const jsx = runInRenderMode("animatic", "01", slamAt(0.4), SLAM, SLAM);
    expect(renderToHtml(jsx, { ...CONTEXT, leadIns: LEAD_INS })).toContain(
      'data-media-start="0.4"',
    );
  });

  it("harvests no media start, the lead-in being a render-side thing only", () => {
    const jsx = runInRenderMode("animatic", "01", slamAt(), SLAM, SLAM);
    expect(harvestAudioStructure(jsx, CONTEXT)).toEqual([
      expect.objectContaining({ src: "/abs/slam.wav", mediaStart: null }),
    ]);
  });
});

describe("a line the picture carries is still a line", () => {
  const MOTION = { motion: "/abs/motion.mp4" };
  const clipOnly = () => {
    const take = asset("motion", motion, { prompt: "she looks up" });
    return (
      <Composition>
        <Video src={take} hasAudio duration={3} />
      </Composition>
    );
  };

  // The one harvest the mux and the probe read. It used to tag a standalone <Audio> and leave a
  // clip's own track kindless, so a piece whose lines arrive inside the picture ducked its bed in
  // the preview and nowhere else.
  it("folds the gain into a clip's own data-volume, the same as a standalone cue", () => {
    const jsx = runInRenderMode("video", "01", clipOnly, MOTION, MOTION);
    expect(
      renderToHtml(jsx, {
        shotId: "01",
        width: 640,
        height: 360,
        duration: 3,
        typography: HARVEST_TYPOGRAPHY,
        levelGains: { "/abs/motion.mp4": 0.5 },
      }),
    ).toContain('data-volume="0.5"');
  });

  it.each(["voice", "sfx"] as const)(
    "carries the %s adjustment with the harvested gain",
    (kind) => {
      const cueLevels = shotCueLevels({
        stage: "video",
        shotId: "01",
        cueKinds: { "video:shot.01.motion": kind },
        pictureRefs: ["video:shot.01.motion"],
        resolvedVariants: { motion: "v-1" },
        resolve: () => undefined,
        state: {
          assets: {
            "video:shot.01.motion": {
              variants: {
                "v-1": {
                  media: {
                    kind: "video",
                    audio: { loudness: { integratedLufs: -24, truePeakDb: -6 } },
                  },
                },
              },
            },
          },
        } as unknown as KonteState,
      });
      const [track] = collectShotAudioCues({
        stage: "video",
        shotId: "01",
        duration: 3,
        renderFn: clipOnly,
        size: { width: 640, height: 360 },
        resolvedFiles: MOTION,
        cueKinds: { "/abs/motion.mp4": kind },
        cueLevels,
        onRenderError: "throw",
      });
      expect(track?.levelling).toEqual(cueLevels.adjustments["video:shot.01.motion"]);
      expect(track?.volume).toBeCloseTo(track!.levelling!.gain, 6);
      expect(track?.levelling?.reason).toBe(kind === "sfx" ? "no-lines" : undefined);
    },
  );

  it("tags a hasAudio clip's track with its kind, the same as a standalone cue", () => {
    expect(
      collectShotAudioCues({
        stage: "video",
        shotId: "01",
        duration: 3,
        renderFn: clipOnly,
        size: { width: 640, height: 360 },
        resolvedFiles: MOTION,
        cueKinds: { "/abs/motion.mp4": "voice" },
        onRenderError: "throw",
      }),
    ).toEqual([
      expect.objectContaining({ role: "embedded", file: "/abs/motion.mp4", kind: "voice" }),
    ]);
  });
});
