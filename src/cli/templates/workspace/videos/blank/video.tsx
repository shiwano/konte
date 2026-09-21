import { defineVideo } from "konte";
import direction from "./direction";

// The final motion video — walk the direction like the animatic and return `{ shots, soundtracks? }`,
// each shot's build returning the delivered `<Composition>`. It takes its keyframes and its
// mixed-down audio from the board: `animatic.shot("01").image("first")`, `animatic.shot("01").stem`,
// `animatic.shot("01").narrationStem`.
// Read the `authoring-guide` skill for the shot chain and asset wiring, `composition-guide` for what
// goes inside a `<Composition>`.
export default defineVideo(direction, {
  timeline: () => ({ shots: [] }),
});
