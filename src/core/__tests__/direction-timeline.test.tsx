import { describe, expect, it } from "vitest";
import type React from "react";
import { Composition, Panel, asset, defineAnimatic, defineDirection } from "../dsl/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import {
  readDirectionTimeline,
  resolveDirectionTimeline,
  type Direction,
  type DirectionPolicy,
} from "../dsl/direction.js";
import { KonteError } from "../errors.js";
import type { SongAnalysis } from "../types/index.js";
import { directionDefaults } from "./helpers/direction.js";
import { moves } from "./helpers/shot.js";
import { songTake, steadySong } from "./helpers/song.js";
import { withSongTakes } from "../dsl/song-context.js";

const secondsDirection = (durations: number[], fps = 24): Direction =>
  ({
    ...directionDefaults,
    policy: { ...directionDefaults.policy, format: { ...directionDefaults.policy.format, fps } },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: durations.map((duration, i) => ({
        id: `s${i}`,
        role: "ordinary",
        action: "a",
        setup: "front",
        duration,
        lineup: [],
      })),
    },
  }) as Direction;

const songPolicy = (fps = 24): DirectionPolicy => ({
  ...directionDefaults.policy,
  format: { ...directionDefaults.policy.format, fps },
  song: "song",
});

const beatsDirection = (beats: number[], fps = 24): Direction =>
  ({
    ...directionDefaults,
    policy: songPolicy(fps),
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: beats.map((b, i) => ({
        id: `s${i}`,
        role: "ordinary",
        action: "a",
        setup: "front",
        beats: b,
        lineup: [],
      })),
    },
  }) as Direction;

const spans = (direction: Direction): number[] =>
  [...resolveDirectionTimeline(direction).timings.values()].map((t) => t.duration!);

const timingsOn = (direction: Direction, take: SongAnalysis | null) => [
  ...readDirectionTimeline(direction, take ? songTake(take) : null).timings.values(),
];

describe("resolveDirectionTimeline", () => {
  it("leaves a span that already lands whole frames untouched", () => {
    expect(spans(secondsDirection([0.5, 3.5, 4]))).toEqual([0.5, 3.5, 4]);
  });

  it("cuts off-frame spans at the nearest frame so the cut keeps the direction's length", () => {
    const result = spans(secondsDirection([2.3, 3.1, 4.55, 4.55]));
    expect(result.map((d) => Math.round(d * 24))).toEqual([55, 75, 109, 109]);
    expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(14.5, 9);
  });

  it("gives a span shorter than half a frame one frame", () => {
    expect(spans(secondsDirection([0.01, 1])).map((d) => Math.round(d * 24))).toEqual([1, 23]);
  });

  it("counts beats on the take's own beats", () => {
    expect(timingsOn(beatsDirection([4, 8, 2]), steadySong({ bpm: 120 }))).toEqual([
      { start: 0, duration: 2, startBeat: 0, beats: 4 },
      { start: 2, duration: 4, startBeat: 4, beats: 8 },
      { start: 6, duration: 1, startBeat: 12, beats: 2 },
    ]);
  });

  it("lands every cut on the frame nearest its beat, so no shot's rounding drifts the next", () => {
    // 100 BPM is 0.6s a beat: 3 beats run 43.2 frames at 24fps.
    const frames = timingsOn(beatsDirection([3, 3, 3]), steadySong({ bpm: 100 })).map((t) =>
      Math.round((t.start! + t.duration!) * 24),
    );
    expect(frames).toEqual([43, 86, 130]);
  });

  it("puts every cut on its beat where the take's tempo moves", () => {
    // Each beat a little longer than the last: 0.5s, 0.51s, 0.52s, …
    const beats: number[] = [];
    for (let i = 0, t = 0; i < 40; t += 0.5 + 0.01 * i, i++) beats.push(t);
    const take = { ...steadySong(), beats, firstBeat: 0 };
    const timings = timingsOn(beatsDirection([4, 8, 6, 3]), take);
    const ends = [4, 12, 18, 21];
    expect(timings.map((t) => Math.round((t.start! + t.duration!) * 24))).toEqual(
      ends.map((beat) => Math.round(beats[beat]! * 24)),
    );
  });

  it("holds the beats and no seconds while no take of the song is read", () => {
    expect(timingsOn(beatsDirection([4, 8]), null)).toEqual([
      { start: null, duration: null, startBeat: 0, beats: 4 },
      { start: null, duration: null, startBeat: 4, beats: 8 },
    ]);
  });

  it("gives the first shot what the take plays before beat 0, and moves every cut by it", async () => {
    const timings = (beat0Sec: number) =>
      withSongTakes(
        () => songTake(steadySong({ bpm: 120, beat0Sec })),
        async () =>
          timingsOn(
            defineDirection(beatsDirection([4, 8]) as never) as unknown as Direction,
            steadySong({ bpm: 120, beat0Sec }),
          ),
      );
    expect(await timings(0.5)).toEqual([
      { start: 0, duration: 2.5, startBeat: 0, beats: 4 },
      { start: 2.5, duration: 4, startBeat: 4, beats: 8 },
    ]);
    // 0.51s is frame 12.24 at 24fps: the lead is whole frames, so the shots after it keep theirs.
    expect((await timings(0.51)).map((t) => t.duration)).toEqual([2.5, 4]);
  });
});

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const board = (): React.ReactElement => {
  const first = asset("first", imageComfy, { prompt: "a" });
  return (
    <Composition>
      <Panel src={first} {...moves} />
    </Composition>
  );
};

describe("ctx.beat", () => {
  const songDirection = () =>
    defineDirection({
      ...directionDefaults,
      policy: {
        format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
        lang: "en",
        speech: "free",
        song: "song",
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "a", setup: "front", beats: 3, lineup: [] },
          { id: "02", role: "hero", action: "b", setup: "front", beats: 4, lineup: [] },
        ],
      },
    });

  it("is the second of a beat from the shot's head, on the song's own frame grid", async () => {
    const direction = await withSongTakes(
      () => songTake(steadySong({ bpm: 100 })),
      async () => songDirection(),
    );
    let beats: number[] = [];
    let duration = 0;
    defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", board).nextShot("02", (ctx) => {
          beats = [0, 1, 2].map((n) => ctx.beat(n));
          duration = ctx.duration;
          return board();
        }),
      }),
    });
    // Shot 02 opens on frame 43 (beat 3 = 43.2); beats 4 and 5 fall on frames 58 and 72, and its end
    // (beat 7 = 100.8) on 101.
    expect(beats.map((s) => Math.round(s * 24))).toEqual([0, 15, 29]);
    expect(Math.round(duration * 24)).toBe(58);
  });

  it("stops a shot's build, naming the song, while no take of it is read", () => {
    const direction = songDirection();
    let error: unknown;
    try {
      defineAnimatic(direction, {
        timeline: ({ shot }) => ({ shots: shot("01", board).nextShot("02", board) }),
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as KonteError).code).toBe("SONG_UNREAD");
    expect((error as KonteError).message).toContain("reference:song");
  });

  it("is absent from the type on a direction without a song", () => {
    const direction = defineDirection({
      ...directionDefaults,
      policy: {
        format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
        lang: "en",
        speech: "free",
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "a", setup: "front", duration: 2, lineup: [] },
        ],
      },
    });
    defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", (ctx) => {
          // @ts-expect-error -- a piece in seconds has no beat to count
          void ctx.beat;
          return board();
        }),
      }),
    });
  });
});

describe("the span a shot owes", () => {
  const clocked = {
    format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
    lang: "en",
    speech: "free",
    song: "song",
  } as const;

  it("is beats on a song, refusing a duration", () => {
    defineDirection({
      ...directionDefaults,
      policy: clocked,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "a",
            setup: "front",
            // @ts-expect-error -- the song counts in beats, so a shot owes `beats`
            duration: 2,
            lineup: [],
          },
        ],
      },
    });
  });

  it("is a whole number of beats", () => {
    defineDirection({
      ...directionDefaults,
      policy: clocked,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "a",
            setup: "front",
            // @ts-expect-error -- a half-beat cut is a computed value with a waiver
            beats: 1.5,
            lineup: [],
          },
        ],
      },
    });
  });

  it("refuses beats without a song", () => {
    defineDirection({
      ...directionDefaults,
      policy: {
        format: clocked.format,
        lang: "en",
        speech: "free",
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "a",
            setup: "front",
            // @ts-expect-error -- `beats` counts on a song the direction does not declare
            beats: 4,
            lineup: [],
          },
        ],
      },
    });
  });
});

describe("ctx.lyrics", () => {
  it("hands a shot the lines it hears, from its head, on the take's clock", async () => {
    const take = songTake(
      steadySong({
        bpm: 120,
        beat0Sec: 0.5,
        phrases: [
          { startSec: 0.5, endSec: 2.2 },
          { startSec: 2.5, endSec: 4.3 },
        ],
        heard: [
          { text: " HIT", startSec: 0.5 },
          { text: " THE", startSec: 0.8 },
          { text: " LIGHT", startSec: 1 },
          { text: " WATCH", startSec: 1.4 },
          { text: " ME", startSec: 1.7 },
          { text: " MOVE", startSec: 1.9 },
          { text: " SNAP", startSec: 2.5 },
          { text: " ON", startSec: 2.8 },
          { text: " THE", startSec: 3 },
          { text: " BEAT", startSec: 3.2 },
          { text: " IN", startSec: 3.4 },
          { text: " THE", startSec: 3.6 },
          { text: " GROOVE", startSec: 3.8 },
        ],
      }),
    );
    let heard: readonly { text: string; singer: readonly string[]; start: number; end: number }[] =
      [];
    await withSongTakes(
      (address) => (address === "reference:song" ? take : null),
      async () => {
        const direction = defineDirection({
          ...directionDefaults,
          characters: {
            konte: { name: "Konte", promptDepiction: "girl", description: "the singer" },
          },
          policy: {
            format: {
              fps: 24,
              size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
            },
            lang: "en",
            speech: "free",
            song: "song",
          },
          lyrics: [
            {
              label: "chorus",
              singer: "konte",
              lines: ["Hit the light, watch me move", "Snap on the beat, in the groove"],
            },
          ],
          sequence: {
            lens: "mini-drama",
            pleasure: "cute",
            shots: [
              { id: "01", role: "ordinary", action: "a", setup: "front", beats: 4, lineup: [] },
              { id: "02", role: "hero", action: "b", setup: "front", beats: 4, lineup: [] },
            ],
          },
        });
        defineAnimatic(direction, {
          timeline: ({ shot }) => ({
            shots: shot("01", board).nextShot("02", (ctx) => {
              heard = ctx.lyrics;
              return board();
            }),
          }),
        });
      },
    );
    // The second line is sung from 2.5s of the take: the head of shot 02, which the first shot's
    // four beats and the take's half-second lead reach.
    expect(heard).toEqual([
      { text: "Snap on the beat, in the groove", singer: ["konte"], start: 0, end: 43 / 24 },
    ]);
  });
});

describe("a build that reads ctx.lyrics", () => {
  const promptOf = async (take: Parameters<typeof withSongTakes>[0]) => {
    let prompt = "";
    await withSongTakes(take, async () => {
      const direction = defineDirection({
        ...directionDefaults,
        characters: {
          konte: { name: "Konte", promptDepiction: "girl", description: "the singer" },
        },
        policy: {
          format: {
            fps: 24,
            size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
          },
          lang: "en",
          speech: "free",
          song: "song",
        },
        lyrics: [{ label: "chorus", singer: "konte", lines: ["Hit the light, watch me move"] }],
        sequence: {
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            { id: "01", role: "ordinary", action: "a", setup: "front", beats: 4, lineup: [] },
            { id: "02", role: "hero", action: "b", setup: "front", beats: 8, lineup: [] },
          ],
        },
      });
      defineAnimatic(direction, {
        timeline: ({ shot }) => ({
          shots: shot("01", board).nextShot("02", (ctx) => {
            prompt = ctx.lyrics.map((l) => `${l.text}@${l.start}-${l.end}`).join("|");
            return board();
          }),
        }),
      });
    });
    return prompt;
  };
  // "Hit the light, watch me move", sung from `sec` to `sec` + 1.7.
  const sungAt = (sec: number) => ({
    phrases: [{ startSec: sec, endSec: sec + 1.7 }],
    heard: [
      { text: " HIT", startSec: sec },
      { text: " THE", startSec: sec + 0.3 },
      { text: " LIGHT", startSec: sec + 0.5 },
      { text: " WATCH", startSec: sec + 0.9 },
      { text: " ME", startSec: sec + 1.2 },
      { text: " MOVE", startSec: sec + 1.4 },
    ],
  });
  const take = (variantId: string, beat0Sec: number, sectionSecs: number[]) => () =>
    songTake(steadySong({ bpm: 120, beat0Sec, sectionSecs, ...sungAt(beat0Sec + 2.5) }), variantId);

  it("reads the same whichever take sings the lines at the same places", async () => {
    // Another take, another lead and other section guesses — the line sung at the same place after
    // beat 0.
    const a = await promptOf(take("v-a", 0.5, [8.5]));
    const b = await promptOf(take("v-b", 0.9, [4.9, 12.9]));
    // On the frame grid: 2.2s is frame 52.8, read as frame 53.
    expect(a).toBe(`Hit the light, watch me move@0.5-${53 / 24}`);
    expect(b).toBe(a);
  });

  it("moves with a take that sings a line elsewhere", async () => {
    const moved = await promptOf(() => ({
      ...take("v-c", 0.5, [])(),
      analysis: { ...take("v-c", 0.5, [])().analysis, ...sungAt(3.5) },
    }));
    expect(moved).toBe(`Hit the light, watch me move@1-${65 / 24}`);
  });
});

describe("the singers the lyrics name", () => {
  const policy = {
    format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
    lang: "en",
    speech: "free",
    song: "song",
  } as const;
  const characters = {
    konte: { name: "Konte", promptDepiction: "girl", description: "the singer" },
    mika: { name: "Mika", promptDepiction: "woman", description: "the second singer" },
  };

  it("are declared characters, on a section or a line", () => {
    defineDirection({
      ...directionDefaults,
      characters,
      policy,
      lyrics: [
        { label: "verse", singer: "konte", lines: ["a", { text: "b", singer: "mika" }] },
        { label: "chorus", singer: ["konte", "mika"], lines: ["c"] },
      ],
      sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
    });
    defineDirection({
      ...directionDefaults,
      characters,
      policy,
      // @ts-expect-error -- "nobody" is not a declared character
      lyrics: [{ label: "verse", singer: "konte", lines: [{ text: "a", singer: "nobody" }] }],
      sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
    });
  });
});
