import {
  adapters,
  Animate,
  asset,
  Audio,
  Composition,
  Cutin,
  defineVideo,
  Image,
  soundtrack,
  Subtitle,
  upscale,
  Video,
} from "konte";
import { videoMinimaxH3R2v } from "konte/workspace/adapters/comfy/video_minimax_h3_r2v.js";
import { videoSeedvr2Upscale } from "konte/workspace/adapters/comfy/video_seedvr2_upscale.js";
import { audioStableAudio3Medium } from "konte/workspace/adapters/comfy/audio_stable_audio_3_medium.js";
import { falSeedance25I2v } from "konte/workspace/adapters/fal/seedance-2-5.js";
import { falVideoUpscale } from "konte/workspace/adapters/fal/video-upscale.js";
import animatic from "./animatic";
import direction from "./direction";
import reference from "./reference";

const motionPrompt = (summary: string, described: string, landing = true) => ({
  subjectDefinitions: [
    "<Picture 1> is the first frame of [Shot 1].",
    ...(landing ? ["<Picture 2> is the last frame of [Shot 1]."] : []),
  ],
  summary: { tasks: ["keyframe completion"] as ["keyframe completion"], text: summary },
  retentionAnalysis: [
    "<Picture 1> ([Shot 1] first frame): fully_preserved - the opening frame.",
    ...(landing ? ["<Picture 2> ([Shot 1] last frame): fully_preserved - the closing frame."] : []),
  ],
  detailedDescription: { style: "2D-animated.", shots: [described] as [string] },
  overallSoundscape: "A quiet kitchen.",
  nonDiegeticMusic: "N/A",
});

const pinned = (id: "02" | "06" | "08", first: string, last: string, text: string) =>
  asset("motion", videoMinimaxH3R2v, {
    image1: animatic.shot(id).image(first),
    image2: animatic.shot(id).image(last),
    startImage: animatic.shot(id).image(first),
    endImage: animatic.shot(id).image(last),
    audioStem: animatic.shot(id).stem,
    prompt: motionPrompt(text, `${text} The shot opens on <Picture 1> and lands on <Picture 2>.`),
  });

export default defineVideo(direction, {
  waivers: {},
  export: {
    delivery: {
      upscale: {
        video: ({ video, width, height }) =>
          upscale(videoSeedvr2Upscale, {
            video,
            width,
            height,
            resolution: Math.min(width, height),
          }),
        frame: ({ video, scale }) => upscale(falVideoUpscale, { video, scale }),
      },
    },
  },
  timeline: ({ pendingShot }) => {
    const clang = asset("clang", audioStableAudio3Medium, {
      prompt: "A pan clangs once.",
      category: "One-shot",
      duration: 1,
    });
    return {
      soundtracks: [
        soundtrack("bed", animatic.shot("01").stem, {
          duck: { depth: 0.3, attack: 0.1, release: 0.3, hold: 0.1 },
          from: { shot: "02", at: 0.5 },
          until: { shot: "08" },
          mediaStart: 0,
          volume: 0.6,
          fadeIn: 0.5,
          fadeOut: 0.5,
          loop: true,
        }),
        soundtrack("clang", clang, { duck: false, from: { shot: "03" }, loop: false }),
      ],
      shots: pendingShot("01")
        .nextShot("02", ({ script, duration }) => (
          <Composition>
            <Video src={pinned("02", "first", "last", "The woman walks in beside the boy.")} />
            <Subtitle entries={[{ start: 1, end: duration, text: script.rival[0] }]} />
          </Composition>
        ))
        .nextShot("03", ({ duration }) => {
          const motion = asset("motion", videoMinimaxH3R2v, {
            image1: animatic.shot("03").image("first"),
            startImage: animatic.shot("03").image("first"),
            audioStem: animatic.shot("03").stem,
            prompt: motionPrompt(
              "They wave the smoke away.",
              "The shot opens on <Picture 1>; they wave the smoke away.",
              false,
            ),
          });
          const insert = asset("insert", falSeedance25I2v, {
            prompt: "Smoke curls up off the pan.",
            image: animatic.shot("03").image("insert"),
            resolution: "480p",
          });
          return (
            <Composition>
              <Video src={motion} hasAudio volume={1} />
              <Cutin at="bottom-left" size={0.25}>
                <Video src={insert} />
              </Cutin>
              <div className="title">Fire!</div>
              <Animate
                script={({ timeline }) => {
                  timeline.fromTo(
                    ".title",
                    { opacity: 0 },
                    { opacity: 1, duration: duration / 3 },
                    0,
                  );
                }}
              />
            </Composition>
          );
        })
        .nextAsideShot("eyecatch", ({ duration, label }) => {
          const clip = asset("clip", adapters.videoFile, { path: "assets/files/clip.mp4" });
          const title = asset("title", adapters.videoTrim, { source: clip, start: 0, duration: 1 });
          return (
            <Composition>
              <Video src={title} duration={duration} />
              <Subtitle entries={[{ start: 0, end: duration, text: label }]} />
            </Composition>
          );
        })
        .nextGraphicShot("04", ({ duration }) => {
          const card = asset("card", adapters.imageResize, {
            image: animatic.shot("04").image("card"),
            width: 1920,
            height: 1080,
          });
          const wipe = asset("wipe", falSeedance25I2v, {
            prompt: "The boy nods along.",
            image: animatic.shot("04").image("wipe"),
          });
          return (
            <Composition>
              <Image src={card} fill start={0} duration={duration} />
              <Cutin at="top-right">
                <Video src={wipe} />
              </Cutin>
              <Audio src={animatic.shot("04").narrationStem} />
            </Composition>
          );
        })
        .nextShot("05", ({ duration }) => {
          const motion = asset("motion", falSeedance25I2v, {
            prompt: "The boy sets the plate down and grins.",
            image: animatic.shot("05").image("only"),
          });
          const still = asset("still", adapters.videoFrame, { source: motion, at: "last" });
          const tail = asset("tail", adapters.audioTrim, {
            source: reference.tone,
            start: 0,
            duration,
          });
          const stretched = asset("stretched", adapters.audioRetime, {
            source: tail,
            duration: duration + 0.5,
            waiver: "A held note under the plate landing.",
          });
          return (
            <Composition>
              <Video src={motion} />
              <Image src={still} fill start={duration - 0.5} duration={0.5} />
              <Audio src={stretched} mediaStart={0} />
            </Composition>
          );
        })
        .nextShot("06", () => (
          <Composition>
            <Video
              src={asset("motion", falSeedance25I2v, {
                prompt: "She blows on the burnt toast.",
                image: animatic.shot("06").image("first"),
                endImage: animatic.shot("06").image("first"),
              })}
            />
          </Composition>
        ))
        .nextPendingShot("07")
        .nextShot("08", ({ shot }) => (
          <Composition>
            <Video
              src={asset("motion", falSeedance25I2v, {
                prompt: "She hands the boy a fresh pan and he laughs.",
                image: animatic.shot("08").image("only"),
              })}
              mediaStart={0}
            />
            <Image src={shot("05").image("still")} fill start={2.5} duration={0.5} />
          </Composition>
        )),
    };
  },
});
