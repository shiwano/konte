import { describe, expect, it } from "vitest";
import { Audio, Composition, Image } from "../../dsl/composition/index.js";
import { defineComfyAsset } from "../../dsl/comfy-asset.js";
import { asset, defineDirection, defineVideo, soundtrack } from "../../dsl/index.js";
import { testDirection } from "../../__tests__/helpers/direction.js";
import { shot, videoTimeline } from "../../__tests__/helpers/shot.js";
import { commentSubjectAddresses } from "../subject.js";

const pictureComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});
const voiceComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const direction = testDirection({
  fps: 30,
  size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
});

describe("commentSubjectAddresses", () => {
  // The regression this exists for: the page keeps a shot's audio on the timeline's own track
  // because it accepts through the stem, and a subject read off the page's picture array dropped
  // every voice take — so a comment on a line reading stayed fresh through a reroll of that line.
  it("names a shot's audio as well as its picture", () => {
    const video = defineVideo(direction, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
                <Audio src={asset("vo", voiceComfy, { text: "hello" })} />
              </Composition>
            ),
          }),
        ]),
    });
    const subject = commentSubjectAddresses(video, "video:shot.01");
    expect(subject?.assets.sort()).toEqual(["video:shot.01.motion", "video:shot.01.vo"]);
    expect(subject?.leaves).toEqual(["video:shot.01#composition", "video:shot.01#stem"]);
  });

  it("names no stem for a shot that sounds nothing", () => {
    const video = defineVideo(direction, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
              </Composition>
            ),
          }),
        ]),
    });
    const subject = commentSubjectAddresses(video, "video:shot.01");
    expect(subject?.assets).toEqual(["video:shot.01.motion"]);
    expect(subject?.leaves).toEqual(["video:shot.01#composition"]);
  });

  // A cue keeps the address it was declared at, so what a shot sounds is not what its own prefix
  // names — the reason this reads the composition's refs rather than filtering by address.
  it("names a cue the shot placed but did not declare", () => {
    const video = defineVideo(direction, {
      timeline: () => {
        const stinger = asset("stinger", voiceComfy, { text: "ding" });
        return videoTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
                <Audio src={stinger} />
              </Composition>
            ),
          }),
        ]);
      },
    });
    const subject = commentSubjectAddresses(video, "video:shot.01");
    expect(subject?.assets).toContain("video:timeline.stinger");
    expect(subject?.leaves).toContain("video:shot.01#stem");
  });

  it("names the beds, not the stem's own take, for a soundtrack comment", () => {
    const video = defineVideo(direction, {
      timeline: () => {
        const bgm = asset("bgm", voiceComfy, { text: "music" });
        return videoTimeline(
          [
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
                </Composition>
              ),
            }),
          ],
          [soundtrack("bed", bgm, { duck: false, volume: 0.3 })],
        );
      },
    });
    const subject = commentSubjectAddresses(video, "video:timeline#stem");
    expect(subject?.assets).toEqual(["video:timeline.bgm"]);
    expect(subject?.leaves).toEqual(["video:timeline#stem"]);
  });

  // The set is what the composition REFERENCES, so it parts company with the shot's own assets both
  // ways: a frame drawn from elsewhere is perceived and not declared here, and a declared asset the
  // build never places is on screen nowhere.
  it("names a picture the shot draws but did not declare", () => {
    const video = defineVideo(direction, {
      timeline: () => {
        const overlay = asset("overlay", pictureComfy, { prompt: "a logo" });
        return videoTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
                <Image src={overlay} />
              </Composition>
            ),
          }),
        ]);
      },
    });
    expect(commentSubjectAddresses(video, "video:shot.01")?.assets).toContain(
      "video:timeline.overlay",
    );
  });

  it("leaves out an asset the shot declared but never placed", () => {
    const video = defineVideo(direction, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              asset("unused", pictureComfy, { prompt: "never drawn" });
              return (
                <Composition>
                  <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
                </Composition>
              );
            },
          }),
        ]),
    });
    const subject = commentSubjectAddresses(video, "video:shot.01");
    expect(subject?.assets).toEqual(["video:shot.01.motion"]);
    expect(subject?.assets).not.toContain("video:shot.01.unused");
  });

  // The envelope over a line is signed off on the line's shot stem.
  it("names only the beds, not the lines a ducking bed yields to", () => {
    // A cue counts as a line only where the shot has script, so this builds the direction the real
    // way rather than through the terse `shot()` helper (whose inline shot carries none).
    const spoken = defineDirection({
      brief: { logline: "a test piece" },
      characters: {},
      locations: {
        studio: {
          name: "the studio",
          description: "a plain studio",
          landmarks: {
            studioMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
      },
      setups: {
        front: {
          name: "the front angle",
          description: "straight on, eye level",
          location: "studio",
          framing: "medium",
          holds: ["studioMark"],
        },
      },
      policy: {
        format: { fps: 30, size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } } },
        lang: "en",
        speech: "free",
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "hero",
            action: "she opens the door",
            setup: "front",
            duration: 5,
            script: [{ narration: "it was raining" }],
            lineup: [],
          },
        ],
      },
    });
    const video = defineVideo(spoken, {
      timeline: ({ shot: stageShot }) => {
        const bgm = asset("bgm", voiceComfy, { text: "music" });
        return {
          shots: stageShot("01", () => (
            <Composition>
              <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
              <Audio src={asset("vo", voiceComfy, { text: "hello" })} />
            </Composition>
          )),
          soundtracks: [soundtrack("bed", bgm, { duck: true, volume: 0.3 })],
        };
      },
    });
    const subject = commentSubjectAddresses(video, "video:timeline#stem");
    expect(subject?.assets).toEqual(["video:timeline.bgm"]);
  });

  // A builder always sets `compositionRefs`, so an empty one is an authoritative "references
  // nothing" — not the absent field a raw literal leaves for declarations to stand in for.
  it("names nothing for a shot that places none of what it declared", () => {
    const video = defineVideo(direction, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              asset("unused", pictureComfy, { prompt: "never drawn" });
              return <Composition />;
            },
          }),
        ]),
    });
    expect(commentSubjectAddresses(video, "video:shot.01")?.assets).toEqual([]);
  });

  it("derives nothing for a timeline stem on a stage with no beds", () => {
    const video = defineVideo(direction, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
              </Composition>
            ),
          }),
        ]),
    });
    expect(commentSubjectAddresses(video, "video:timeline#stem")).toBeNull();
  });

  it("derives nothing for a target the stage does not hold", () => {
    const video = defineVideo(direction, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Image src={asset("motion", pictureComfy, { prompt: "a cat" })} />
              </Composition>
            ),
          }),
        ]),
    });
    // A shot this stage does not have, and a shot address belonging to the other stage: both are
    // "there is nothing here", which the caller must be able to tell from an empty subject.
    expect(commentSubjectAddresses(video, "video:shot.99")).toBeNull();
    expect(commentSubjectAddresses(video, "animatic:shot.01")).toBeNull();
  });
});
