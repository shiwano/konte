# The shape of `direction.ts`

The common fields, on a four-shot piece.

```ts
import { defineDirection } from "konte";

export default defineDirection({
  brief: {
    logline: "A kitchen gag: a cat walks a mug off the counter.",
    hook: "The tabby beside the owner, one paw already on the mug.",
    audience: "Cat owners. It was always going to happen.",
    tone: "Dry and quick; the catch is the laugh.",
    look: "Live action, handheld, warm morning light. Short cuts, no music.",
    outOfScope: ["No second room"],
    tolerances: ["Text on the mug may render unreadable — it reads as a stripe."],
  },
  policy: {
    format: {
      fps: 24,
      size: { megapixels: 0.9, delivery: { width: 1280, height: 720 } },
    },
    lang: "en",
    fonts: ["Inter"],
    speech: "free",
  },
  narrator: { id: "narratorVoice", description: "Male, forties, warm, close to the mic." },
  characters: {
    owner: {
      name: "the owner",
      promptDepiction: "woman",
      description: "Thirties, sleeves pushed up, mid-clean-up.",
      voice: { id: "ownerVoice", description: "Female, thirties, low and dry, unhurried." },
    },
    cat: {
      name: "the tabby",
      promptDepiction: "tabby",
      description: "A heavy-set brown tabby, entirely composed.",
    },
  },
  props: {
    mug: { name: "the striped mug", description: "A tall blue-and-white striped mug." },
  },
  locations: {
    kitchen: {
      name: "the kitchen",
      description: "A narrow galley kitchen, white counter, light from the left.",
      landmarks: {
        counter: {
          name: "the counter",
          promptDepiction: "counter",
          description: "The white galley counter running the length of the room.",
        },
        window: {
          name: "the window",
          promptDepiction: "window",
          description: "The sash window at the far end, the room's only light.",
        },
      },
    },
  },
  setups: {
    counterWide: {
      name: "the counter, wide",
      description: "From the doorway at eye level, the whole counter.",
      location: "kitchen",
      framing: "wide",
      within: null,
      holds: ["counter", "window"],
    },
    mugInsert: {
      name: "the mug at the lip",
      description: "At counter height, the mug filling frame against the edge.",
      location: "kitchen",
      framing: "insert",
      holds: [], // an insert is the one framing that holds nothing
    },
    standoffMedium: {
      name: "the stand-off",
      description: "Side on, both of them in one frame from the waist up.",
      location: "kitchen",
      framing: "medium",
      within: null,
      holds: ["counter"],
    },
    ownerClose: {
      name: "the owner, close",
      description: "Tight on the owner's face and hands above the counter.",
      location: "kitchen",
      framing: "close",
      within: "standoffMedium",
      holds: ["counter"],
    },
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "funny",
    shots: [
      {
        id: "01",
        role: "disruption",
        action:
          "Beside the owner, the tabby slides the striped mug from the counter's middle to its edge.",
        setup: "counterWide",
        duration: 3,
        lineup: ["owner", "cat"],
      },
      {
        id: "02",
        role: "pressure",
        action: "The striped mug teeters at the lip as the tabby's paw draws back.",
        setup: "mugInsert",
        duration: 2,
        lineup: ["cat"],
      },
      {
        id: "03",
        role: "pressure",
        action: "The tabby bolts past the owner and out of frame.",
        setup: "standoffMedium",
        duration: 1.5,
        lineup: ["owner", "cat"],
        lineupTo: ["owner"],
        // `join: "continuous" | "jump-back" | "jump-forward"` sits here — required where the
        // shot before is on the same `setup`.
        script: [{ character: "owner", text: "Don't.", acting: "Flat, barely voiced." }],
      },
      {
        id: "04",
        role: "hero",
        action: "The owner catches the falling striped mug an inch above the counter.",
        setup: "ownerClose",
        duration: 2,
        lineup: ["owner"],
        script: [{ narration: "Some house rules are enforced by hand." }],
        telop: ["Counter Rules, Rule 1"],
      },
    ],
    waivers: {
      "missing-beat_ordinary":
        "A cold open — the piece starts on the paw already moving, with no calm to establish first.",
    },
  },
});
```
