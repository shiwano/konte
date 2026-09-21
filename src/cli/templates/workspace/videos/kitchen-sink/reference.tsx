import { adapters, asset, defineReference, seed } from "konte";
import { imageKrea2TurboReference } from "konte/workspace/adapters/comfy/image_krea2_turbo_reference.js";
import { falNanoBanana2, falNanoBanana2Edit } from "konte/workspace/adapters/fal/nano-banana-2.js";
import direction from "./direction";

export default defineReference(
  direction,
  () => {
    const photo = asset("photo", adapters.imageFile, { path: "assets/files/photo.png" });
    const tone = asset("tone", adapters.audioFile, { path: "assets/files/tone.mp3" });
    const clip = asset("clip", adapters.videoFile, { path: "assets/files/clip.mp4" });

    const cook = asset("cook", imageKrea2TurboReference, {
      image1: photo,
      prompt:
        "A full-body character sheet of the boy from image1 in a white apron, plain backdrop.",
      seed: seed(),
    });
    const rival = asset("rival", falNanoBanana2, {
      prompt: "A full-body character sheet of a woman in a green cardigan, plain backdrop.",
      aspectRatio: "3:4",
    });
    const pan = asset("pan", falNanoBanana2Edit, {
      inputImage: [photo],
      prompt: "A dented iron frying pan on a plain backdrop.",
    });
    const kitchen = asset("kitchen", adapters.jsxImage, {
      width: 2496,
      height: 1248,
      background: "#f5efe6",
      build: ({ width, height }) => (
        <div style={{ width, height, display: "flex", alignItems: "flex-end" }}>
          <div style={{ width: "100%", height: height * 0.3, background: "#c9a26b" }} />
        </div>
      ),
    });
    const yard = asset("yard", adapters.imageResize, { image: photo, width: 2496, height: 1248 });

    const cookVoice = asset("cookVoice", adapters.audioTrim, {
      source: tone,
      start: 0,
      duration: 0.5,
    });
    const rivalVoice = asset("rivalVoice", adapters.audioRetime, { source: tone, duration: 1.5 });
    const narratorVoice = asset("narratorVoice", adapters.audioTrim, {
      source: tone,
      start: 0,
      duration: 1,
    });

    return {
      photo,
      tone,
      clip,
      cook,
      rival,
      pan,
      kitchen,
      yard,
      cookVoice,
      rivalVoice,
      narratorVoice,
    };
  },
  { waivers: {} },
);
