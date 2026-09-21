import type {
  Character,
  DirectionBrief,
  DirectionFormat,
  DirectionPolicy,
  Location,
  Setup,
} from "../../dsl/direction.js";
import type { LanguageTag } from "../../typography.js";
import { defineDirection } from "../../dsl/direction.js";

// The policy is required on a real direction. Tests that only care about the sequence spread
// this to satisfy the contract without restating brief/characters/locations/setups/policy each time;
// a test that exercises one of them overrides it after the spread. `setups` carries one entry
// (`front`, in the one `studio` location) so a direction whose shots default their `setup` to it
// stays structurally valid.
export const directionDefaults: {
  brief: DirectionBrief;
  characters: Record<string, Character>;
  locations: Record<string, Location>;
  setups: Record<string, Setup>;
  policy: DirectionPolicy;
} = {
  brief: { logline: "a test piece" },
  characters: {},
  locations: {
    studio: {
      name: "the studio",
      description: "a plain studio",
      landmarks: {
        desk: { name: "the desk", promptDepiction: "desk", description: "a plain desk, centre" },
      },
    },
  },
  setups: {
    front: {
      name: "the front angle",
      description: "straight on, eye level",
      location: "studio",
      framing: "medium",
      holds: ["desk"],
    },
  },
  policy: {
    format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
    lang: "en",
    speech: "free",
  },
};

// A ready `direction` entry carrying `format` as its canvas, for tests that call
// `defineAnimatic`/`defineVideo` (both now take the direction first) but assemble their shots via
// the terse `shot()`/`videoTimeline()` helpers rather than the direction's own sequence. Its sequence is
// an empty leaf — the injected `shot` starter goes unused, only `direction.policy.format` and
// `.lang` are read.
export function testDirection(
  format: DirectionFormat,
  lang: LanguageTag = "en",
  fonts?: readonly string[],
) {
  return defineDirection({
    ...directionDefaults,
    policy: { ...directionDefaults.policy, format, lang, ...(fonts ? { fonts } : {}) },
    sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
  });
}

// The canvas every reference sheet is sized off (0.589824 MP at 16:9 → a 1024×576 base), for a test
// that needs a reference definition without restating a format.
export const plainDirection = testDirection(directionDefaults.policy.format);
