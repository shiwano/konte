import { describe, expect, it } from "vitest";
import { directionPartHashes } from "../direction-hash.js";
import { directionPartContents } from "../direction-parts.js";
import type { Direction } from "../dsl/direction.js";

// The frames the shots are taken from. A fixture's shots name one by id; its `location`/`framing` are
// read through it, so nothing here is restated on a shot.
const setups = {
  "bedroom-medium": {
    name: "the bedroom, medium",
    description: "straight on, eye level",
    location: "bedroom",
    framing: "medium",
    holds: ["bedroomMark"],
  },
  "bedroom-close": {
    name: "the bedroom, close",
    description: "in on the face",
    location: "bedroom",
    framing: "close",
    holds: ["bedroomMark"],
  },
  "bedroom-wide": {
    name: "the bedroom, wide",
    description: "the whole room",
    location: "bedroom",
    framing: "wide",
    holds: ["bedroomMark"],
  },
} as const;

function flat(): Direction {
  return {
    brief: { logline: "a girl wakes and leaves", tone: "quiet", outOfScope: ["no dialogue"] },
    characters: {
      alice: { name: "Alice", description: "a girl in red", promptDepiction: "alice" },
    },
    props: { key: { name: "the key", description: "a brass key" } },
    locations: {
      bedroom: {
        name: "the bedroom",
        description: "a sunlit bedroom",
        landmarks: {
          bedroomMark: {
            name: "the mark",
            promptDepiction: "mark",
            description: "a mark only this place has",
          },
        },
      },
    },
    setups,
    policy: {
      format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
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
          action: "she wakes",
          setup: "bedroom-medium",
          duration: 4,
          lineup: [],
        },
      ],
      waivers: { "multi-sentence-action_01": "intentional — a quiet shot" },
    },
  } as Direction;
}

function sequenced(): Direction {
  return {
    brief: { logline: "an act of acts" },
    characters: {},
    locations: {
      bedroom: {
        name: "the bedroom",
        description: "a sunlit bedroom",
        landmarks: {
          bedroomMark: {
            name: "the mark",
            promptDepiction: "mark",
            description: "a mark only this place has",
          },
        },
      },
    },
    setups,
    policy: {
      format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
      lang: "en",
      speech: "free",
    },
    sequence: {
      lens: "three-act",
      pleasure: "emotional",
      sequences: [
        {
          id: "s1",
          role: "setup-act",
          synopsis: "ordinary world",
          lens: "kishotenketsu",
          pleasure: "emotional",
          shots: [
            {
              id: "01",
              role: "hero",
              action: "intro",
              setup: "bedroom-medium",
              duration: 5,
              lineup: [],
            },
          ],
          waivers: { "empty-synopsis_s1": "deliberate" },
        },
      ],
    },
  } as Direction;
}

// The same piece with its cast voiced: a character's voice and the narrator's, the two parts that
// exist only when something is cast.
function voiced(): Direction {
  const d = flat();
  d.characters.alice!.voice = { id: "aliceVoice", description: "bright, quick" };
  (d as { narrator?: unknown }).narrator = { id: "narratorVoice", description: "warm, unhurried" };
  return d;
}

describe("directionPartContents", () => {
  // The two walks are the same part set seen from two sides — a part the gate demands and this
  // cannot show would be unreadable, and one it shows that has no hash is unreviewable.
  it.each([
    ["flat", flat],
    ["sequenced", sequenced],
    ["voiced", voiced],
  ])("covers exactly the parts directionPartHashes emits (%s)", (_name, build) => {
    const direction = build();
    expect([...directionPartContents(direction).keys()].sort()).toEqual(
      [...directionPartHashes(direction).keys()].sort(),
    );
  });

  it("carries each part's content", () => {
    const parts = directionPartContents(flat());
    expect(parts.get("direction:brief.logline")).toMatchObject({
      kind: "brief",
      text: "a girl wakes and leaves",
    });
    expect(parts.get("direction:brief.outOfScope")).toMatchObject({ items: ["no dialogue"] });
    // A list field the brief never declared is still a part — an empty list is what it shows.
    expect(parts.get("direction:brief.tolerances")).toMatchObject({ kind: "brief", items: [] });
    expect(parts.get("direction:policy.format")).toMatchObject({ kind: "format", fps: 24 });
    expect(parts.get("direction:characters.alice")).toMatchObject({
      kind: "roster",
      roster: "characters",
      name: "Alice",
    });
    expect(parts.get("direction:sequence.shots.01")).toMatchObject({
      kind: "shot",
      role: "hero",
      duration: 4,
    });
    expect(parts.get("direction:sequence.waivers.multi-sentence-action_01")).toMatchObject({
      kind: "waiver",
    });
    expect(parts.get("direction:sequence")).toMatchObject({ kind: "sequence", children: ["01"] });
  });

  // The reviewer signs off what they can see, so everything the part hashes reaches the page: the
  // word a prompt calls a character by, what only a place has, and what each frame carries of it.
  it("carries the prompt name, the landmarks, and what each frame holds", () => {
    const parts = directionPartContents(flat());
    expect(parts.get("direction:characters.alice")).toMatchObject({ promptDepiction: "alice" });
    expect(parts.get("direction:locations.bedroom")).toMatchObject({
      landmarks: [{ id: "bedroomMark", name: "the mark", promptDepiction: "mark" }],
    });
    expect(parts.get("direction:setups.bedroom-medium")).toMatchObject({
      kind: "setup",
      holds: ["bedroomMark"],
    });
  });

  // `within: null` is a declaration (this frame is a root of its own axis); omitting the field is
  // not, and `within-undeclared` may be asking the author to choose. A page that read the second back
  // as the first would contradict the error it is shown beside.
  it("tells a declared root apart from a frame that declares no window", () => {
    const d = flat();
    (d.setups as unknown as Record<string, { within?: string | null }>)["bedroom-wide"]!.within =
      null;
    const parts = directionPartContents(d);
    expect(parts.get("direction:setups.bedroom-wide")).toMatchObject({ within: null });
    expect(parts.get("direction:setups.bedroom-medium")).not.toHaveProperty("within");
  });

  // The two rosters no check reads a prompt name or a landmark for say so, rather than leaving a
  // reader to guess whether the field was dropped.
  it("leaves a prop's prompt name and landmarks null", () => {
    expect(directionPartContents(flat()).get("direction:props.key")).toMatchObject({
      promptDepiction: null,
      landmarks: null,
    });
  });
});

describe("directionPartContents voices", () => {
  it("carries a character's voice with the character it belongs to", () => {
    expect(directionPartContents(voiced()).get("direction:characters.alice.voice")).toMatchObject({
      kind: "voice",
      characterId: "alice",
      name: "Alice",
      description: "bright, quick",
      assetId: "aliceVoice",
    });
  });

  // The narrator is cast piece-wide and has no roster entry, so the character fields read null.
  it("carries the narrator's voice with no character", () => {
    expect(directionPartContents(voiced()).get("direction:narrator")).toMatchObject({
      kind: "voice",
      characterId: null,
      name: null,
      assetId: "narratorVoice",
    });
  });

  it("emits no voice part for an uncast character", () => {
    expect(directionPartContents(flat()).has("direction:characters.alice.voice")).toBe(false);
  });
});
