import { defineDirection } from "konte";

// The video's direction — the ordered shots every stage builds on, plus the piece-wide policy and
// the rosters, reviewed in `konte preview direction`. All three stage files import it; animatic.tsx
// and video.tsx flesh out each shot. Fill every field below from the shaping conversation
// (`drafting-guide`), per `direction-guide`.
export default defineDirection({
  brief: {
    logline: "",
    hook: "",
    audience: "",
    tone: "",
    look: "",
    outOfScope: [],
    tolerances: [],
  },
  characters: {},
  locations: {},
  setups: {},
  policy: {
    format: {
      fps: 24,
      size: {
        megapixels: 0.9,
        delivery: { width: 1280, height: 720 },
      },
    },
    lang: "en",
    speech: "free",
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [],
  },
});
