import { describe, expect, it } from "vitest";
import type React from "react";
import { listShotStems } from "../address.js";
import { audioLevelling } from "../audio-level.js";
import { harvestShotPictureCues } from "../composition-builder.js";
import { stemDefinitionHash } from "../composition-resource.js";
import { Audio, Composition, Image, Panel, Video } from "../dsl/composition/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineDirection } from "../dsl/direction.js";
import { adapters, asset, defineAnimatic, defineVideo, soundtrack } from "../dsl/index.js";
import { makeAddressPlaceholder } from "../dsl/shot-context.js";
import { withSongTakes } from "../dsl/song-context.js";
import type { ShotScript } from "../dsl/shot-script.js";
import type { MediaAsset } from "../dsl/builders.js";
import { SONG_BED_ID, mixedSoundtracks } from "../song-bed.js";
import type { AnimaticDefinition, VideoDefinition } from "../types/index.js";
import { directionDefaults } from "./helpers/direction.js";
import { moves } from "./helpers/shot.js";

const stillComfy = defineComfyAsset({
  workflow: "still.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const ia2vComfy = defineComfyAsset({
  workflow: "ia2v.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    audio: { nodeId: "2", field: "audio", type: "audio" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// A model timing its picture to its `stem` input, which konte fills on a song.
const stemComfy = defineComfyAsset({
  workflow: "stem.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    track: { nodeId: "2", field: "audio", type: "audio", stem: true },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// A half-second lead: shot 01 holds 0–2.5s, shot 02 2.5–4.5s.
const songTake = () => ({
  address: "reference:song",
  variantId: "v-song",
  analysis: {
    bpm: 120,
    downbeatSec: 0.5,
    sectionSecs: [],
    phrases: null,
    heard: null,
    analyzedAt: "2026-09-30T00:00:00.000Z",
    clock: { bpm: 120, beatsPerBar: 4 },
    lang: "en",
  },
});

function clockedDirection(opts: { script?: boolean; clock?: false } = {}) {
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
    policy: {
      ...directionDefaults.policy,
      ...(opts.clock === false ? {} : { clock: { song: "song", bpm: 120, beatsPerBar: 4 } }),
    },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        { id: "01", role: "ordinary", action: "a", setup: "front", beats: 4, lineup: [] },
        {
          id: "02",
          role: "hero",
          action: "the cat speaks",
          setup: "front",
          beats: 4,
          ...(opts.script ? { script: [{ character: "cat", text: "meow" }] as const } : {}),
          lineup: [],
        },
      ],
    },
  });
}

const board = (): React.ReactElement => (
  <Composition>
    <Panel src={asset("first", stillComfy, { prompt: "a" })} {...moves} />
  </Composition>
);

const onSong = <T,>(fn: () => T): Promise<T> =>
  withSongTakes(
    (address) => (address === "reference:song" ? songTake() : null),
    async () => fn(),
  );

function clockedAnimatic(opts: { script?: boolean } = {}) {
  return defineAnimatic(clockedDirection(opts), {
    timeline: ({ shot }) => ({
      shots: shot("01", board).nextShot("02", ({ script }) => (
        <Composition>
          <Panel src={asset("first", stillComfy, { prompt: "a" })} {...moves} />
          {opts.script ? (
            <Audio src={asset("vo", ttsComfy, { text: (script as ShotScript).cat?.[0] ?? "" })} />
          ) : null}
        </Composition>
      )),
    }),
  });
}

// A video shot's picture that plays no take.
const still = (): React.ReactElement => (
  <Composition>
    <Image src={asset("still", stillComfy, { prompt: "a" })} />
  </Composition>
);

const videoOpeningWith = (first: () => React.ReactElement): VideoDefinition =>
  defineVideo(clockedDirection(), {
    timeline: ({ shot }) => ({ shots: shot("01", first).nextShot("02", still) }),
  });

describe("the song bed", () => {
  it("is laid under a stage of a piece cut to its song, from its first sample, unducked", async () => {
    const animatic = await onSong(() => clockedAnimatic());
    expect(animatic.song).toBe("reference:song");
    const [bed] = mixedSoundtracks(animatic, animatic.timelineSoundtracks);
    expect(bed).toMatchObject({
      id: SONG_BED_ID,
      src: { src: makeAddressPlaceholder("reference:song") },
      options: { loop: false, duck: false },
      song: true,
    });
    // It is not an authored bed, so it opens no timeline stem to review.
    expect(animatic.timelineSoundtracks).toBeUndefined();
  });

  it("is levelled to -14 LUFS", () => {
    const leveled = audioLevelling("song", {
      integratedLufs: -20,
      truePeakDb: -3,
    } as Parameters<typeof audioLevelling>[1]);
    expect(leveled.gain).toBeCloseTo(10 ** (6 / 20), 6);
  });

  it("refuses a soundtrack of the song, which would play it twice", async () => {
    await expect(
      onSong(() =>
        defineAnimatic(clockedDirection(), {
          timeline: ({ shot }) => ({
            shots: shot("01", board).nextShot("02", board),
            soundtracks: [
              soundtrack(
                "song",
                { src: makeAddressPlaceholder("reference:song") },
                { duck: false },
              ),
            ],
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "SONG_DOUBLED" });
  });
});

describe("a board shot's stem on a piece cut to its song", () => {
  it("holds the shot's span of the song, even where the shot sounds nothing", async () => {
    const animatic: AnimaticDefinition = await onSong(() => clockedAnimatic());
    const [first, second] = animatic.shots;
    expect(first!.songCue).toEqual({ src: "reference:song", mediaStart: 0, duration: 2.5 });
    expect(second!.songCue).toEqual({ src: "reference:song", mediaStart: 2.5, duration: 2 });
    expect(listShotStems("animatic", second!)).toEqual([
      { address: "animatic:shot.02#stem", refs: ["reference:song"] },
      { address: "animatic:shot.02#songStem", refs: ["reference:song"] },
    ]);
    const hashes = ["01", "02"].map((id) =>
      stemDefinitionHash(animatic, `animatic:shot.${id}#stem`),
    );
    expect(hashes[0]).not.toBe("");
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("leaves the song out of the cues the shot plays", async () => {
    const animatic = await onSong(() => clockedAnimatic({ script: true }));
    const second = animatic.shots[1]!;
    expect(second.stemRefs).toEqual(["animatic:shot.02.vo"]);
    expect(second.cueKinds).toEqual({ "animatic:shot.02.vo": "voice" });
  });
});

describe("a board shot's song stem", () => {
  // Shot 01 (0–2.5s) frames no one; shot 02 (2.5–4.5s) frames the cat, who sings over it while
  // the dog sings off screen.
  const singingDirection = () =>
    defineDirection({
      ...directionDefaults,
      characters: {
        cat: { name: "the cat", description: "a black cat", promptDepiction: "cat" },
        dog: { name: "the dog", description: "a white dog", promptDepiction: "dog" },
      },
      policy: { ...directionDefaults.policy, clock: { song: "song", bpm: 120, beatsPerBar: 4 } },
      lyrics: [
        { label: "verse", singer: "cat", lines: ["la la", "na na", "ta ta"] },
        { label: "bridge", singer: "dog", lines: ["wo wo"] },
      ],
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "a", setup: "front", beats: 4, lineup: [] },
          { id: "02", role: "hero", action: "b", setup: "front", beats: 4, lineup: ["cat"] },
        ],
      },
    });
  const line = (text: string, startSec: number, endSec: number) => ({
    text,
    startSec,
    endSec,
  });
  const onSungSong = <T,>(fn: () => T): Promise<T> =>
    withSongTakes(
      (address) =>
        address === "reference:song"
          ? {
              ...songTake(),
              analysis: {
                ...songTake().analysis,
                lines: {
                  "1.1": line("la la", 1, 2),
                  "1.2": line("na na", 3, 3.5),
                  "1.3": line("ta ta", 3.25, 4),
                  "2.1": line("wo wo", 4, 4.25),
                },
              },
            }
          : null,
      async () => fn(),
    );
  const singingAnimatic = () =>
    defineAnimatic(singingDirection(), {
      timeline: ({ shot }) => ({ shots: shot("01", board).nextShot("02", board) }),
    });

  it("is the instrumental where no one in frame sings", async () => {
    const animatic = await onSungSong(singingAnimatic);
    expect(animatic.shots[0]!.songStem).toEqual({ part: "instrumental" });
  });

  it("is the vocals over the lines a singer in frame sings, an off-screen singer's left out", async () => {
    const animatic = await onSungSong(singingAnimatic);
    expect(animatic.shots[1]!.songStem).toEqual({
      part: "vocals",
      windows: [{ start: 0.5, duration: 1 }],
    });
  });

  it("is a stem of its own, on its own hash", async () => {
    const animatic = await onSungSong(singingAnimatic);
    const song = stemDefinitionHash(animatic, "animatic:shot.02#songStem");
    expect(song).not.toBe("");
    expect(song).not.toBe(stemDefinitionHash(animatic, "animatic:shot.02#stem"));
  });

  it("puts a take built on it on the song", async () => {
    const video = await onSungSong(() => {
      const animatic = singingAnimatic();
      return defineVideo(singingDirection(), {
        timeline: ({ shot }) => ({
          shots: shot("01", still).nextShot("02", () => (
            <Composition>
              <Video
                src={asset("clip", ia2vComfy, {
                  image: animatic.shot("02").image("first"),
                  audio: animatic.shot("02").songStem,
                })}
              />
            </Composition>
          )),
        }),
      });
    });
    expect(harvestShotPictureCues(video, "02")?.map((cue) => cue.mediaStart)).toEqual([0]);
  });
});

describe("an adapter's stem input on a piece cut to its song", () => {
  const videoWith = (
    track?: (animatic: ReturnType<typeof clockedAnimatic>) => MediaAsset<"audio">,
  ) =>
    onSong(() => {
      const animatic = clockedAnimatic();
      return videoOpeningWith(() => (
        <Composition>
          <Video
            src={asset("clip", stemComfy, {
              image: animatic.shot("01").image("first"),
              ...(track ? { track: track(animatic) } : {}),
            })}
          />
        </Composition>
      ));
    });

  it("is filled with the shot's song stem", async () => {
    const video = await videoWith();
    expect(JSON.stringify(video.shots[0]!.assets.clip)).toContain("animatic:shot.01#songStem");
  });

  it("takes the shot's own song stem written there, and refuses any other", async () => {
    await expect(videoWith((animatic) => animatic.shot("01").songStem)).resolves.toBeDefined();
    await expect(videoWith((animatic) => animatic.shot("02").songStem)).rejects.toMatchObject({
      code: "SONG_STEM_OVERRIDDEN",
    });
  });

  it("is left alone off a song", () => {
    const video = defineVideo(clockedDirection({ clock: false }), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video
              src={asset("clip", stemComfy, {
                image: asset("still", stillComfy, { prompt: "a" }),
              })}
            />
          </Composition>
        )).nextShot("02", still),
      }),
    });
    expect(JSON.stringify(video.shots[0]!.assets.clip)).not.toContain("songStem");
  });

  it("refuses the board's whole-song stem", async () => {
    await expect(
      onSong(() => {
        const animatic = clockedAnimatic();
        return videoOpeningWith(() => (
          <Composition>
            <Video
              src={asset("clip", ia2vComfy, {
                image: animatic.shot("01").image("first"),
                audio: animatic.shot("01").stem,
              })}
            />
          </Composition>
        ));
      }),
    ).rejects.toMatchObject({ code: "ANIMATIC_INVALID" });
  });

  it("is one audio per adapter", () => {
    const declare = (inputs: Parameters<typeof defineComfyAsset>[0]["inputs"]) => () =>
      defineComfyAsset({
        workflow: "x.json",
        description: "test adapter",
        inputs,
        outputs: { result: { nodeId: "9", type: "video" } },
      });
    expect(declare({ a: { nodeId: "1", field: "image", type: "image", stem: true } })).toThrow();
    expect(
      declare({
        a: { nodeId: "1", field: "audio", type: "audio", stem: true },
        b: { nodeId: "2", field: "audio", type: "audio", stem: true },
      }),
    ).toThrow();
  });
});

describe("the window of a take cut to the song", () => {
  const mediaStartOf = (video: VideoDefinition, shotId: string) =>
    harvestShotPictureCues(video, shotId)?.map((cue) => cue.mediaStart);

  it("is where the song is when the clip plays, less where the take starts on it", async () => {
    const video = await onSong(() => {
      const animatic = clockedAnimatic();
      return defineVideo(clockedDirection(), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => {
            const clip = asset("clip", stemComfy, { image: animatic.shot("01").image("first") });
            return (
              <Composition>
                <Video src={clip} />
              </Composition>
            );
          }).nextShot("02", ({ shot: placed }) => (
            <Composition>
              <Video src={placed("01").video("clip")} />
            </Composition>
          )),
        }),
      });
    });
    expect(mediaStartOf(video, "01")).toEqual([0]);
    expect(mediaStartOf(video, "02")).toEqual([2.5]);
  });

  it("refuses a written mediaStart", async () => {
    await expect(
      onSong(() => {
        const animatic = clockedAnimatic();
        return videoOpeningWith(() => (
          <Composition>
            <Video
              src={asset("clip", stemComfy, { image: animatic.shot("01").image("first") })}
              mediaStart={0.5}
            />
          </Composition>
        ));
      }),
    ).rejects.toMatchObject({ code: "SONG_WINDOW_INVALID" });
  });

  it("refuses a place on the song before the take starts", async () => {
    await expect(
      onSong(() => {
        const animatic = clockedAnimatic();
        return videoOpeningWith(() => (
          <Composition>
            <Video
              src={asset("clip", ia2vComfy, {
                image: animatic.shot("02").image("first"),
                audio: animatic.shot("02").songStem,
              })}
            />
          </Composition>
        ));
      }),
    ).rejects.toMatchObject({ code: "SONG_WINDOW_INVALID" });
  });

  it("refuses the take's own audio, which would play the song twice", async () => {
    await expect(
      onSong(() => {
        const animatic = clockedAnimatic();
        return videoOpeningWith(() => (
          <Composition>
            <Video
              src={asset("clip", stemComfy, { image: animatic.shot("01").image("first") })}
              hasAudio
            />
          </Composition>
        ));
      }),
    ).rejects.toMatchObject({ code: "SONG_DOUBLED" });
  });

  it("moves with a trim of the take", async () => {
    const video = await onSong(() => {
      const animatic = clockedAnimatic();
      return defineVideo(clockedDirection(), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Video
                src={asset("clip", stemComfy, { image: animatic.shot("01").image("first") })}
              />
            </Composition>
          )).nextShot("02", ({ shot: placed }) => (
            <Composition>
              <Video
                src={asset("tail", adapters.videoTrim, {
                  source: placed("01").video("clip"),
                  start: 2,
                  duration: 2,
                })}
              />
            </Composition>
          )),
        }),
      });
    });
    // The trim starts 2s into a take that starts on the song at 0; shot 02 opens at 2.5s.
    expect(harvestShotPictureCues(video, "02")?.map((cue) => cue.mediaStart)).toEqual([0.5]);
  });
});

describe("a stem holding the song", () => {
  const placedAsAudio = (src: (stem: MediaAsset<"audio">) => MediaAsset<"audio">) =>
    onSong(() => {
      const animatic = clockedAnimatic();
      return videoOpeningWith(() => (
        <Composition>
          <Audio src={src(animatic.shot("01").songStem)} />
        </Composition>
      ));
    });

  it("is refused as an <Audio>, retimed or not, which would play the song twice", async () => {
    await expect(placedAsAudio((stem) => stem)).rejects.toMatchObject({ code: "SONG_DOUBLED" });
    await expect(
      placedAsAudio((stem) => asset("slow", adapters.audioRetime, { source: stem, duration: 2.4 })),
    ).rejects.toMatchObject({ code: "SONG_DOUBLED" });
  });
});

describe("the lines of a video shot on a piece cut to its song", () => {
  const videoOf = (withLine: boolean) =>
    onSong(() => {
      const animatic = clockedAnimatic({ script: true });
      return defineVideo(clockedDirection({ script: true }), {
        timeline: ({ shot }) => ({
          shots: shot("01", still).nextShot("02", () => (
            <Composition>
              <Image src={asset("still", stillComfy, { prompt: "a" })} />
              {withLine ? <Audio src={animatic.shot("02").audio("vo")} /> : null}
            </Composition>
          )),
        }),
      });
    });

  it("refuses a shot the direction gives lines to that places no <Audio>", async () => {
    await expect(videoOf(false)).rejects.toMatchObject({ code: "SCRIPT_UNVOICED" });
    await expect(videoOf(true)).resolves.toBeDefined();
  });
});
