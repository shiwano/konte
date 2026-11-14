import {
  adapters,
  asset,
  type AdapterInputs,
  Audio,
  Composition,
  Cutin,
  defineAnimatic,
  Image,
  Panel,
  respell,
  seed,
} from "konte";
import { audioZonos2VoiceClone } from "konte/workspace/adapters/comfy/audio_zonos2_voice_clone.js";
import { imageMinimaxH3ImageEdit } from "konte/workspace/adapters/comfy/image_minimax_h3_image_edit.js";
import direction from "./direction";
import reference from "./reference";

type Prompt = AdapterInputs<typeof imageMinimaxH3ImageEdit>["prompt"];
type Subject = Prompt["references"]["subjects"][number];

const still = (
  subjects: readonly [Subject, ...Subject[]],
  target: string,
  details: string,
): Prompt => ({
  references: { subjects, target },
  details,
  style: "2D-animated, flat cel shading.",
});

const room = (picture: number, what = "kitchen"): Subject => ({
  definition: `The empty ${what} in <Picture ${picture}> is <Subject 1>.`,
  relation: {
    partially:
      "its walls, fixtures, light and camera position remain, while the figures stand in it.",
  },
});
const cook = (picture: number, subject: number): Subject => ({
  definition: `The boy in the apron in <Picture ${picture}> is <Subject ${subject}>.`,
  relation: { partially: "his face, hair and apron remain, while his pose is new." },
});
const rival = (picture: number, subject: number): Subject => ({
  definition: `The woman in the cardigan in <Picture ${picture}> is <Subject ${subject}>.`,
  relation: { partially: "her face, hair and cardigan remain, while her pose is new." },
});

export default defineAnimatic(direction, {
  plates: ({ format }) => {
    const master = asset("kitchenMaster", adapters.imageResize, {
      image: reference.kitchen,
      width: 2496,
      height: 1248,
    });
    return {
      kitchenWide: asset("kitchenWide", adapters.imageCrop, {
        image: master,
        x: 140,
        y: 0,
        width: 2216,
        height: 1248,
        outWidth: format.size.width,
        outHeight: format.size.height,
      }),
      kitchenMedium: asset("kitchenMedium", adapters.imageCrop, {
        image: master,
        x: 560,
        y: 100,
        width: 1420,
        height: 800,
      }),
      kitchenClose: asset("kitchenClose", adapters.imageCrop, {
        image: master,
        x: 900,
        y: 240,
        width: 780,
        height: 440,
      }),
      yardWide: asset("yardWide", adapters.imageCrop, {
        image: reference.yard,
        x: 140,
        y: 0,
        width: 2216,
        height: 1248,
        outWidth: format.size.width,
        outHeight: format.size.height,
      }),
    };
  },
  timeline: ({ shot, plates }) => ({
    shots: shot("01", ({ script, lineup, duration }) => {
      const first = asset("first", imageMinimaxH3ImageEdit, {
        image1: plates.kitchenWide,
        image2: reference.cook,
        prompt: still(
          [room(1), cook(2, 2)],
          "shows <Subject 2> at the stove of <Subject 1>, flipping eggs.",
          "He stands at the stove, the pan tilted in his right hand, the eggs in the air above it.",
        ),
      });
      // The same take a moment on: an edit of the opening frame.
      const last = asset("last", imageMinimaxH3ImageEdit, {
        image1: first,
        seed: seed(),
        prompt: still(
          [
            {
              definition: "The boy at the stove in <Picture 1> is <Subject 1>.",
              relation: {
                partially: "the room, the framing and the boy remain, while his arms move.",
              },
            },
          ],
          "shows <Subject 1> lifting the eggs onto a plate.",
          "The pan tips over a white plate in his left hand; a thin line of smoke rises behind it.",
        ),
      });
      const line = asset("line", audioZonos2VoiceClone, {
        referenceAudio: reference.cookVoice,
        script: script.cook[0],
      });
      return (
        <Composition>
          <Panel
            src={first}
            alt={lineup.join(", ")}
            blocking="He flips the eggs and turns toward the table."
            camera="Holds."
          />
          {/* 02 runs on from here in one take, so this last panel is no landing frame. */}
          <Panel
            src={last}
            start={duration / 2}
            blocking="He lifts the eggs onto a plate; a thin line of smoke starts to rise."
            camera="Holds."
          />
          <Audio id="cook" src={line} start={0.2} volume={0.9} />
        </Composition>
      );
    })
      .nextShot("02", ({ script, lineupTo }) => {
        // One take runs on from 01, so this keyframe is the seam: video.tsx pins 01's end to it.
        const first = asset("first", imageMinimaxH3ImageEdit, {
          image1: plates.kitchenWide,
          image2: reference.cook,
          prompt: still(
            [room(1), cook(2, 2)],
            "shows <Subject 2> cooking at the stove of <Subject 1> as smoke starts to rise.",
            "A thin grey line of smoke rises from the pan beside his shoulder.",
          ),
        });
        const last = asset("last", imageMinimaxH3ImageEdit, {
          image1: first,
          image2: reference.rival,
          prompt: still(
            [
              {
                definition: "The kitchen and the boy at the stove in <Picture 1> are <Subject 1>.",
                relation: {
                  partially:
                    "the kitchen, the boy at the stove and the smoke remain, while a second figure walks in at the left.",
                },
              },
              rival(2, 2),
            ],
            "shows <Subject 2> walked in at the left of <Subject 1>.",
            "She stands at the left edge of the frame, her nose wrinkled, sniffing at the smoke.",
          ),
        });
        const line = asset("line", audioZonos2VoiceClone, {
          referenceAudio: reference.rivalVoice,
          script: respell(script.rival[0], "Something is... burning."),
        });
        return (
          <Composition>
            <Panel
              src={first}
              blocking={`She walks in and stops beside him (${lineupTo.join(" then ")}).`}
              camera="Holds."
            />
            <Panel src={last} />
            <Audio src={line} start={1} fadeIn={0.05} fadeOut={0.1} />
          </Composition>
        );
      })
      .nextShot("03", ({ script, cutin }) => {
        const key = asset("key", imageMinimaxH3ImageEdit, {
          image1: plates.kitchenMedium,
          image2: reference.rival,
          image3: reference.cook,
          prompt: still(
            [room(1), rival(2, 2), cook(3, 3)],
            "shows <Subject 2> and <Subject 3> in <Subject 1>, smoke billowing between them.",
            "<Subject 2> stands at the left and <Subject 3> at the right, both waving their hands at a thick grey cloud of smoke.",
          ),
        });
        const insert = asset("insert", imageMinimaxH3ImageEdit, {
          image1: reference.view.kitchen.top,
          image2: reference.pan,
          prompt: still(
            [
              {
                definition: "The kitchen seen from above in <Picture 1> is <Subject 1>.",
                relation: {
                  transfers: "its palette and light, carried onto the close view of the pan.",
                },
              },
              {
                definition: "The dented iron pan in <Picture 2> is <Subject 2>.",
                relation: { partially: "its dents and iron finish remain, while it now smokes." },
              },
            ],
            "shows <Subject 2> filling the frame, smoking.",
            "Grey smoke curls up off the pan's blackened base and out of the top of the frame.",
          ),
        });
        const shout = asset("shout", audioZonos2VoiceClone, {
          referenceAudio: reference.tone,
          script: script.speaker[0],
        });
        return (
          <Composition>
            <Panel src={key} blocking="They wave the smoke away." camera="Pushes in." />
            <Cutin at="bottom-left" size={0.25} inset={0.02}>
              <Panel src={insert} alt={cutin.setup} blocking="Smoke curls up." camera="Holds." />
            </Cutin>
            <Audio src={shout} start={0.5} />
          </Composition>
        );
      })
      .nextAsideShot("eyecatch")
      .nextGraphicShot("04", ({ script, duration }) => {
        const card = asset("card", adapters.jsxImage, {
          background: "transparent",
          build: ({ height }) => (
            <div className="flex h-full items-center justify-center">
              <h1 style={{ fontSize: height * 0.08 }}>{script.narration[0]}</h1>
            </div>
          ),
        });
        const wipe = asset("wipe", imageMinimaxH3ImageEdit, {
          image1: plates.kitchenClose,
          image2: reference.cook,
          prompt: still(
            [room(1), cook(2, 2)],
            "shows <Subject 2> leaning over the table of <Subject 1>, reading the recipe.",
            "He leans in on both hands, his eyes on a handwritten recipe card on the table.",
          ),
        });
        const narration = asset("narration", audioZonos2VoiceClone, {
          referenceAudio: reference.narratorVoice,
          script: script.narration[0],
        });
        return (
          <Composition>
            <Image src={card} fill duration={duration} />
            <Cutin at="top-right">
              <Panel src={wipe} blocking="He nods along." camera="Holds." />
            </Cutin>
            <Audio src={narration} />
          </Composition>
        );
      })
      .nextShot("05", ({ framing, location, setup }) => (
        <Composition>
          <Panel
            src={asset("key", imageMinimaxH3ImageEdit, {
              image1: plates.kitchenClose,
              image2: reference.cook,
              prompt: still(
                [room(1), cook(2, 2)],
                "shows <Subject 2> grinning over a plate of eggs on the table of <Subject 1>.",
                "A white plate of fried eggs sits in the foreground; he grins over it.",
              ),
            })}
            alt={`${setup} ${framing} ${location}`}
            blocking="He sets the plate down and grins."
            camera="Holds."
          />
        </Composition>
      ))
      .nextShot("06", () => {
        const key = asset("key", imageMinimaxH3ImageEdit, {
          image1: plates.yardWide,
          image2: reference.rival,
          prompt: still(
            [room(1, "yard"), rival(2, 2)],
            "shows <Subject 2> in <Subject 1> holding up a slice of burnt toast.",
            "She stands between the gate and the tree, the black toast held up in her right hand.",
          ),
        });
        return (
          <Composition>
            <Panel src={key} blocking="She blows on the toast." camera="Holds." />
          </Composition>
        );
      })
      .nextPendingShot("07")
      .nextShot("08", () => {
        return (
          <Composition>
            <Panel
              src={asset("key", imageMinimaxH3ImageEdit, {
                image1: plates.kitchenMedium,
                image2: reference.rival,
                image3: reference.cook,
                prompt: still(
                  [room(1), rival(2, 2), cook(3, 3)],
                  "shows <Subject 3> laughing, a fresh pan in his hands, in <Subject 1>.",
                  "<Subject 2> stands at the left; <Subject 3> at the right holds a new pan in both hands, laughing.",
                ),
              })}
              blocking="She hands it over; he laughs."
              camera="Holds."
            />
          </Composition>
        );
      }),
  }),
});
