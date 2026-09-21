import * as fs from "node:fs/promises";
import * as path from "node:path";

// The video every CLI test scaffolds into. It has the shape a real project has — a direction of
// three shots, a reference pool, a two-panel board per shot, a video that animates them — but it is
// the TESTS' own, not a template's, so a template stays free to change (swap an adapter, retune a
// prompt) without the suite having an opinion about it.
//
// Its media are the two blobs under fixtures/assets: seconds of tone and a 64px square, so the
// repo carries kilobytes.

const FIXTURE_ASSETS = path.join(import.meta.dirname, "fixtures", "assets");

const DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: {
    logline: "A three-shot promo: the creator animatics an idea, accepts it, and watches it move.",
    audience: "Someone sizing up the tool.",
    tone: "Bright and upbeat.",
    look: "Clean anime illustration, purple-and-white palette.",
    outOfScope: ["Not a tutorial", "no second character"],
    tolerances: ["Fine UI text may render as unreadable glyphs at this size."],
  },
  policy: {
    format: {
      fps: 24,
      size: {
        megapixels: 0.589824,
        delivery: { width: 1920, height: 1080 },
      },
    },
    lang: "en",
    speech: "free",
  },
  characters: {
    character: {
      name: "the creator",
      description: "The maker at the desk — the recurring subject the piece follows.",
      promptDepiction: "character",
    },
  },
  locations: {
    studio: {
      name: "the creative studio",
      description: "A bright, tidy studio desk in a soft purple-and-white palette.",
      landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } },
    },
  },
  setups: {
    deskWide: {
      name: "the desk, wide",
      description: "The whole desk from across the room, eye level.",
      location: "studio",
      framing: "wide",
      holds: ["studioMark"],
    },
    deskMedium: {
      name: "the desk, medium",
      description: "The maker and the desk from the front, eye level.",
      location: "studio",
      framing: "medium",
      holds: ["studioMark"],
      within: "deskWide",
    },
    deskClose: {
      name: "the desk, close",
      description: "In on the hands and the page.",
      location: "studio",
      framing: "close",
      holds: ["studioMark"],
      within: "deskMedium",
    },
  },
  sequence: {
    lens: "satisfying-process",
    pleasure: "satisfying",
    shots: [
      {
        id: "01",
        role: "method",
        action: "Plan the story — the creator sketches each shot in the animatic.",
        setup: "deskWide",
        lineup: [],
        duration: 3,
        telop: ["Animatic it."],
      },
      {
        id: "02",
        role: "rhythm",
        action: "Review and accept — the work settles into a confident rhythm.",
        setup: "deskMedium",
        lineup: [],
        duration: 4,
        telop: ["Review it."],
      },
      {
        id: "03",
        role: "completion",
        action: "The idea comes alive as motion — the still sketches become the finished cut.",
        setup: "deskClose",
        lineup: [],
        duration: 3,
        telop: ["Move it."],
      },
    ],
    waivers: {
      "missing-beat_before": "The piece opens at planning, with no prior state to show.",
      "too-few-consecutive_rhythm": "A compressed three-shot showcase.",
      // The board is anchored on a blank latent, not on the studio reference. Wiring it instead would
      // put a studio asset in the reference stage of every suite that swaps this one out — and those
      // stages are each cut to exactly what their own plan / reroll / cascade assertions count.
      "setup-unconsumed_deskWide": "fixture board is anchored on a latent, not the location",
      "setup-unconsumed_deskMedium": "fixture board is anchored on a latent, not the location",
      "setup-unconsumed_deskClose": "fixture board is anchored on a latent, not the location",
      // Same reason one step further: the board declares no plates, so the axial push-in from 01 to
      // 02 has nothing nesting its two frames.
      "axis-unrealized_deskMedium.deskWide": "fixture board declares no plates",
      // Wiring the previous panel would chain each shot's board to the one before it, which every plan and
      // cascade count in the suite would then see.
      "panel-unlinked_01-02": "fixture shots are boarded independently",
      "panel-unlinked_02-03": "fixture shots are boarded independently",
    },
  },
});
`;

/** An empty shared pool — what a fixture writes when it wants the reference stage to declare nothing. */
export const EMPTY_REFERENCE_TSX = `import { defineReference } from "konte";
import direction from "./direction";

export default defineReference(direction, () => ({}));
`;

const REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, {
    path: "assets/files/character.png",
  });

  const bgm = asset("bgm", adapters.audioFile, {
    path: "assets/files/bgm.mp3",
  });

  const studio = asset("studio", internalTestPlate, {
    width: 512,
    height: 512,
    color: "#f3eefb",
  });

  return { character, bgm, studio };
});
`;

const ANIMATIC_TS = `import { defineAnimatic, asset, adapters, Composition, Panel } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import { imageMinimaxH3R2i } from "konte/workspace/adapters/comfy/image_minimax_h3_r2i.js";
import direction from "./direction";
import reference from "./reference";

export default defineAnimatic(direction, {
  timeline: ({ format, shot }) => {
    const latent = asset("latent", internalTestPlate, {
      width: format.size.width,
      height: format.size.height,
      color: "#ffffff",
    });

    const still = (canvas: string, body: string) => ({
      subjectDefinitions: [\`<Picture 1> is \${canvas}.\`, "<Picture 2> is the creator."],
      summary: {
        tasks: ["keyframe completion"] as ["keyframe completion"],
        text: "The shot is drawn onto the canvas.",
      },
      retentionAnalysis: [
        "<Picture 1> ([Shot 1] frame): fully_preserved - the canvas is kept as it is.",
        "<Picture 2> (appears in [Shot 1]): attribute_transfer - the creator's face and dress are carried onto a new pose.",
      ],
      detailedDescription: { style: "2D-animated.", shots: [body] as [string] },
    });

    const shotFn = (id: string, first: string, next: string) => () => {
      const firstPanel = asset("first", imageMinimaxH3R2i, {
        image1: latent,
        image2: reference.character,
        prompt: still("the empty canvas", first),
      });
      const lastPanel = asset("last", imageMinimaxH3R2i, {
        image1: firstPanel,
        image2: reference.character,
        prompt: still("the frame this shot opens on", next),
      });
      return <Composition>
<Panel src={firstPanel} blocking={\`The creator carries shot \${id} through to its end.\`} camera="fixed" />
<Panel src={lastPanel} />
</Composition>;
    };

    return {
      shots: shot("01", shotFn("01", "The creator sketches in an animatic book.", "The pencil is lifted and her gaze is up."))
        .nextShot("02", shotFn("02", "Two flat UI cards float in front of her.", "The left card is tapped and lit up."))
        .nextShot("03", shotFn("03", "A card morphs into a video player frame.", "The play button is lit up.")),
    };
  },
});
`;

const VIDEO_TSX = `import { defineVideo, Composition, soundtrack, Video, Subtitle, asset, upscale } from "konte";
import { videoMinimaxH3R2v } from "konte/workspace/adapters/comfy/video_minimax_h3_r2v.js";
import { videoSeedvr2Upscale } from "konte/workspace/adapters/comfy/video_seedvr2_upscale.js";
import direction from "./direction";
import animatic from "./animatic";
import reference from "./reference";

export default defineVideo(direction, {
  export: {
    delivery: {
      upscale: {
        video: ({ video, width, height }) =>
          upscale(videoSeedvr2Upscale, { video, width, height, resolution: 1080 }),
      },
    },
  },

  timeline: ({ shot }) => {
    const motionPrompt = (body: string) => ({
      subjectDefinitions: [
        "<Picture 1> is the first frame of [Shot 1].",
        "<Picture 2> is the last frame of [Shot 1].",
      ],
      summary: {
        tasks: ["keyframe completion"] as ["keyframe completion"],
        text: "The take runs from the first frame to the last.",
      },
      retentionAnalysis: [
        "<Picture 1> ([Shot 1] first frame): fully_preserved - the take opens on this exact frame.",
        "<Picture 2> ([Shot 1] last frame): fully_preserved - the take lands on this exact frame.",
      ],
      detailedDescription: { style: "2D-animated.", shots: [body] as [string] },
      overallSoundscape: "A quiet room, with the small sounds of a hand moving over paper.",
      nonDiegeticMusic: "N/A",
    });

    const shotFn = (id: "01" | "02" | "03", prompt: string, telop: string) => () => {
      const motion = asset("motion", videoMinimaxH3R2v, {
        image1: animatic.shot(id).image("first"),
        image2: animatic.shot(id).image("last"),
        startImage: animatic.shot(id).image("first"),
        endImage: animatic.shot(id).image("last"),
        prompt: motionPrompt(prompt),
      });
      return (
        <Composition>
          <Video src={motion} />
          <Subtitle entries={[{ start: 1, end: 2.5, text: telop }]} />
        </Composition>
      );
    };

    return {
      soundtracks: [soundtrack("bed", reference.bgm, { volume: 0.3, duck: true })],
      shots: shot("01", shotFn("01", "She sketches in <Picture 1>, then lifts her gaze into <Picture 2>.", "Animatic it."))
        .nextShot("02", shotFn("02", "She taps the card in <Picture 1>; it lights up by <Picture 2>.", "Review it."))
        .nextShot("03", shotFn("03", "The card in <Picture 1> becomes the player of <Picture 2>.", "Move it.")),
    };
  },
});
`;

/** Overwrite a freshly scaffolded blank video with the fixture's own definitions and media. */
export async function writeFixtureVideo(videoRoot: string): Promise<void> {
  await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
  await fs.writeFile(path.join(videoRoot, "reference.tsx"), REFERENCE_TS);
  await fs.writeFile(path.join(videoRoot, "animatic.tsx"), ANIMATIC_TS);
  await fs.writeFile(path.join(videoRoot, "video.tsx"), VIDEO_TSX);

  const files = path.join(videoRoot, "assets", "files");
  await fs.mkdir(files, { recursive: true });
  for (const name of ["character.png", "bgm.mp3"]) {
    await fs.copyFile(path.join(FIXTURE_ASSETS, name), path.join(files, name));
  }
}
