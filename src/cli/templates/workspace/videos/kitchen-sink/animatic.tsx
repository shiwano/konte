import {
  adapters,
  asset,
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
import { imageMinimaxH3R2i } from "konte/workspace/adapters/comfy/image_minimax_h3_r2i.js";
import direction from "./direction";
import reference from "./reference";

type Still = {
  task: "reference generation" | "keyframe completion";
  defines: readonly string[];
  retains: readonly string[];
  summary: string;
  described: string;
  cutFrom?: string;
};

const still = ({ task, defines, retains, summary, described, cutFrom }: Still) => {
  const shots: [string] | [string, string] = cutFrom
    ? [cutFrom, `the camera cuts to ${described}`]
    : [described];
  return {
    subjectDefinitions: [...defines],
    summary: { tasks: [task] as [Still["task"]], text: summary },
    retentionAnalysis: [...retains],
    detailedDescription: { style: "2D-animated.", shots },
  };
};

const kept = (label: string, what: string) =>
  `${label} (appears in [Shot 1]): fully_preserved - ${what}`;

export default defineAnimatic(direction, {
  waivers: {},
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
  timeline: ({ shot, plates, views }) => ({
    shots: shot("01", ({ script, lineup, duration }) => {
      const first = asset("first", imageMinimaxH3R2i, {
        image1: reference.cook,
        image2: plates.kitchenWide,
        prompt: still({
          task: "reference generation",
          defines: ["<Subject 1> is the boy in <Picture 1>.", "<Picture 2> is the empty frame."],
          retains: [
            kept("<Subject 1>", "his face and apron."),
            kept("<Picture 2>", "the framing and the room."),
          ],
          summary: "The boy flips eggs at the stove.",
          described: "A wide shot; <Subject 1> stands at the stove flipping eggs.",
        }),
      });
      const last = asset("last", imageMinimaxH3R2i, {
        image1: reference.cook,
        image2: first,
        seed: seed(),
        prompt: still({
          task: "keyframe completion",
          defines: ["<Subject 1> is the boy in <Picture 1>.", "<Picture 2> is the opening frame."],
          retains: [
            kept("<Subject 1>", "his face and apron."),
            kept("<Picture 2>", "the framing and the room."),
          ],
          summary: "The boy lifts the eggs onto a plate.",
          described: "The same wide shot; the boy lifts the eggs onto a plate.",
        }),
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
        // One take runs on from 01, so this keyframe is the seam: video.tsx pins 01's end to it, and
        // no previous panel is taken.
        const first = asset("first", imageMinimaxH3R2i, {
          image1: reference.cook,
          image2: plates.kitchenWide,
          prompt: still({
            task: "reference generation",
            defines: ["<Subject 1> is the boy in <Picture 1>.", "<Picture 2> is the empty frame."],
            retains: [
              kept("<Subject 1>", "his face and apron."),
              kept("<Picture 2>", "the framing and the room."),
            ],
            summary: "The boy keeps cooking as smoke starts to rise.",
            described: "The boy at the stove as a thin line of smoke rises.",
          }),
        });
        const last = asset("last", imageMinimaxH3R2i, {
          image1: reference.rival,
          image2: reference.cook,
          image3: first,
          prompt: still({
            task: "keyframe completion",
            defines: [
              "<Subject 1> is the woman in <Picture 1>.",
              "<Subject 2> is the boy in <Picture 2>.",
              "<Picture 3> is the opening frame.",
            ],
            retains: [
              kept("<Subject 1>", "her face and cardigan."),
              kept("<Subject 2>", "his face and apron."),
              kept("<Picture 3>", "the framing and the room."),
            ],
            summary: "The woman has walked in and stands left of the boy.",
            described: "The woman stands at left, sniffing, the boy at right.",
          }),
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
      .nextShot("03", ({ script, cutin, shot }) => {
        const key = asset("key", imageMinimaxH3R2i, {
          image1: reference.rival,
          image2: reference.cook,
          image3: plates.kitchenMedium,
          image4: shot("02").image("last"),
          prompt: still({
            task: "reference generation",
            defines: [
              "<Subject 1> is the woman in <Picture 1>.",
              "<Subject 2> is the boy in <Picture 2>.",
              "<Picture 3> is the empty frame.",
              "<Picture 4> is the frame this take continues from.",
            ],
            retains: [
              kept("<Subject 1>", "her face and cardigan."),
              kept("<Subject 2>", "his face and apron."),
              kept("<Picture 3>", "the framing and the room."),
              kept("<Picture 4>", "the moment it holds."),
            ],
            summary: "Smoke billows between the woman and the boy.",
            cutFrom: "The frame of <Picture 4>.",
            described: "a medium shot, the woman at left and the boy at right waving at the smoke.",
          }),
        });
        const insert = asset("insert", imageMinimaxH3R2i, {
          image1: reference.pan,
          image2: views.kitchen.top,
          prompt: still({
            task: "reference generation",
            defines: [
              "<Subject 1> is the pan in <Picture 1>.",
              "<Subject 2> is the kitchen in <Picture 2>.",
            ],
            retains: [
              kept("<Subject 1>", "its dents and iron finish."),
              "<Subject 2> (appears in [Shot 1]): attribute_transfer - its palette and light.",
            ],
            summary: "The smoking pan fills the frame.",
            described: "The smoking pan fills the frame.",
          }),
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
        const wipe = asset("wipe", imageMinimaxH3R2i, {
          image1: reference.cook,
          image2: plates.kitchenClose,
          prompt: still({
            task: "reference generation",
            defines: ["<Subject 1> is the boy in <Picture 1>.", "<Picture 2> is the empty frame."],
            retains: [
              kept("<Subject 1>", "his face and apron."),
              kept("<Picture 2>", "the framing and the room."),
            ],
            summary: "The boy leans over the table.",
            described: "The boy leans in over the table, reading the recipe.",
          }),
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
            src={asset("key", imageMinimaxH3R2i, {
              image1: reference.cook,
              image2: plates.kitchenClose,
              prompt: still({
                task: "reference generation",
                defines: [
                  "<Subject 1> is the boy in <Picture 1>.",
                  "<Picture 2> is the empty frame.",
                ],
                retains: [
                  kept("<Subject 1>", "his face and apron."),
                  kept("<Picture 2>", "the framing and the room."),
                ],
                summary: "The boy grins over the plate of eggs he has set down.",
                described: "The plate of eggs on the table, the boy grinning over it.",
              }),
            })}
            alt={`${setup} ${framing} ${location}`}
            blocking="He sets the plate down and grins."
            camera="Holds."
          />
        </Composition>
      ))
      .nextShot("06", () => {
        const key = asset("key", imageMinimaxH3R2i, {
          image1: reference.rival,
          image2: plates.yardWide,
          prompt: still({
            task: "reference generation",
            defines: [
              "<Subject 1> is the woman in <Picture 1>.",
              "<Picture 2> is the empty frame.",
            ],
            retains: [
              kept("<Subject 1>", "her face and cardigan."),
              kept("<Picture 2>", "the framing and the yard."),
            ],
            summary: "The woman holds up a slice of burnt toast in the yard.",
            described:
              "A wide shot; <Subject 1> stands between the gate and the tree holding burnt toast.",
          }),
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
              src={asset("key", imageMinimaxH3R2i, {
                image1: reference.rival,
                image2: reference.cook,
                image3: plates.kitchenMedium,
                prompt: still({
                  task: "reference generation",
                  defines: [
                    "<Subject 1> is the woman in <Picture 1>.",
                    "<Subject 2> is the boy in <Picture 2>.",
                    "<Picture 3> is the empty frame.",
                  ],
                  retains: [
                    kept("<Subject 1>", "her face and cardigan."),
                    kept("<Subject 2>", "his face and apron."),
                    kept("<Picture 3>", "the framing and the room."),
                  ],
                  summary: "The boy laughs, the fresh pan in his hands.",
                  described: "The woman at left, the boy at right holding the fresh pan, laughing.",
                }),
              })}
              blocking="She hands it over; he laughs."
              camera="Holds."
            />
          </Composition>
        );
      }),
  }),
});
