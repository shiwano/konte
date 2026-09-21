// The curated built-in lens registry and the `Pleasure` vocabulary every direction draws from, plus
// the by-name lookup the doctor resolves `node.lens` against. Kept apart from the arc engine
// (`direction-check.ts`) so that engine stays generic over `Role` and data-free. A lens declares its
// own beats, and each beat carries the dramatic `fn` the theory checks read — there is no global role
// enum or function map, so a role is just a lens-scoped string. Custom lenses (`defineLens`) slot in
// beside these — see `resolveLens` in `direction.ts`.

import type { Beat, BeatFunction, LensSpec } from "./direction-check.js";

/**
 * The emotional reward a video aims for — orthogonal to the lens (structure): a `mini-drama` can be
 * `cute` or `scary`. Every node names one, root and child alike.
 */
export type Pleasure =
  | "cute"
  | "funny"
  | "cool"
  | "beautiful"
  | "scary"
  | "satisfying"
  | "surprising"
  | "emotional"
  | "mysterious"
  | "awe";

// `konte preview direction` is read by the person paying for the render, and this vocabulary is one
// of the only things they can act on. A `lens` name and a `role` are deliberately absent from the
// page: a reviewer who does not know `three-act` cannot say "this is not a three-act", nor name the
// lens it should have been — glossing those words makes them legible without making them arguable.
// What a reviewer *can* judge is the feeling a stretch aims for, and where the piece rises and lands.
export const PLEASURE_GLOSS: Record<Pleasure, string> = {
  cute: "warmth and affection for the subject",
  funny: "laughter",
  cool: "admiration for style and competence",
  beautiful: "pleasure taken in the image itself",
  scary: "fear, and the tension before it",
  satisfying: "the click of something coming together properly",
  surprising: "the jolt of the unexpected",
  emotional: "being moved — tenderness, or tears",
  mysterious: "the pull of what is withheld",
  awe: "smallness in the face of something vast",
};

// The five functions, named for a reader rather than for the theory. This is the one structural
// word the review page prints: unlike a role ("method"), "payoff" is a claim about the piece that a
// reviewer can dispute — *this* is the high point? — without knowing any of the vocabulary behind it.
export const BEAT_FUNCTION_LABEL: Record<BeatFunction, string> = {
  ground: "opening",
  turn: "turning point",
  build: "rising",
  payoff: "payoff",
  settle: "closing",
};

/**
 * The built-in lenses. Each beat names a `role` and the dramatic `fn` it performs in this lens, so
 * the engine checks theory ("a climax must be earned") off the beat itself. A beat with no `fn` is a
 * container, exempt from the function checks — no built-in declares one; a project opts out of the
 * arc engine in its own `defineLens`. Share budgets are act-ratio guards — a grounding beat past ~40%
 * of the runtime is front-loaded, a settling beat past ~25% outstays the climax it is meant to let
 * ring. Both are waivable pacing findings, never targets. A lens over shots and a lens over sequences
 * live in one registry: any node names any lens, and the checker only flags a role its lens does not
 * declare (a waivable `lens-role-mismatch`).
 */
export const BUILTIN_LENSES = [
  {
    name: "mini-drama",
    payoff: "hero",
    beats: [
      { role: "ordinary", fn: "ground", maxShare: 0.4 },
      { role: "disruption", fn: "turn" },
      { role: "pressure", fn: "build", maxConsecutive: 3 },
      { role: "hero", fn: "payoff" },
      { role: "release", fn: "settle", required: false, maxShare: 0.25 },
    ],
  },
  {
    name: "comedy",
    payoff: "button",
    beats: [
      { role: "setup", fn: "ground" },
      { role: "violation", fn: "turn" },
      { role: "escalation", fn: "build", required: false }, // optional — a tight gag can skip the build, and a lone escalation still lands
      { role: "button", fn: "payoff" },
    ],
  },
  {
    name: "satisfying-process",
    payoff: "completion",
    beats: [
      { role: "before", fn: "ground", maxShare: 0.4 }, // the deficient starting state — shared with transformation
      { role: "method", fn: "build" },
      { role: "rhythm", fn: "build", minConsecutive: 2 }, // rhythm only reads as rhythm once it repeats
      { role: "completion", fn: "payoff" },
      { role: "after-glow", fn: "settle", required: false, maxShare: 0.25 }, // savor the finished state — shared with transformation
    ],
  },
  {
    name: "mood-piece",
    payoff: "peak",
    beats: [
      { role: "atmosphere", fn: "ground" }, // no ceiling — atmosphere is the genre's substance, not its setup
      { role: "motif", fn: "build" },
      { role: "variation", fn: "build" },
      { role: "peak", fn: "payoff" },
      { role: "fade", fn: "settle", required: false, maxShare: 0.25 },
    ],
  },
  {
    name: "transformation",
    payoff: "reveal",
    beats: [
      { role: "before", fn: "ground", maxShare: 0.4 },
      { role: "process", fn: "build", minConsecutive: 2 }, // the before/after contrast is earned by visible work
      { role: "reveal", fn: "payoff" },
      { role: "after-glow", fn: "settle", required: false, maxShare: 0.25 },
    ],
  },
  {
    name: "product-demo",
    payoff: "result",
    beats: [
      { role: "problem", fn: "ground", maxShare: 0.4 }, // dwell on the pain past ~40% and the demo reads as a complaint
      { role: "solution", fn: "turn" },
      { role: "demonstration", fn: "build" },
      { role: "result", fn: "payoff" }, // the value proven — the climax a demo builds to
      { role: "call-to-action", fn: "settle", required: false, maxShare: 0.2 }, // the ask is a coda, not an act
    ],
  },
  // The one shape with no conflict in it: `ten` lands a juxtaposition rather than an antagonist, and
  // `ketsu` reframes it instead of resolving a fight. Hence the skeleton no other lens has — the
  // turn arrives *after* the build, and the payoff ends the piece with nothing to settle. Roles stay
  // in romaji: they are the lens's own vocabulary, and "twist" would name a beat this lens does not
  // mean. It reads at either scale — four panels of a strip, or four parts of a long piece.
  {
    name: "kishotenketsu",
    payoff: "ketsu",
    beats: [
      { role: "ki", fn: "ground", maxShare: 0.4 },
      { role: "sho", fn: "build" },
      { role: "ten", fn: "turn" },
      { role: "ketsu", fn: "payoff" },
    ],
  },
  {
    name: "three-act",
    payoff: "climax-act",
    beats: [
      { role: "setup-act", fn: "ground", maxShare: 0.4 }, // an act-1 past ~40% of the runtime is front-loaded
      { role: "confrontation-act", fn: "build" },
      { role: "climax-act", fn: "payoff", minShare: 0.15 }, // the payoff act below ~15% reads as rushed
      { role: "resolution-act", fn: "settle", required: false },
    ],
  },
] as const satisfies readonly LensSpec<string>[];

/**
 * One built-in lens, with its name and role literals intact — what the type layer reads to pin a
 * node's `role` to the lens it names. A `defineLens` spec widens to `LensSpec<string>`, so a custom
 * lens is not in this union and its roles fall through to `lens-role-mismatch`.
 */
export type BuiltinLens = (typeof BUILTIN_LENSES)[number];

export function findBuiltinLens(name: string): LensSpec<string> | undefined {
  return BUILTIN_LENSES.find((l) => l.name === name);
}

// A custom lens the author wrote: it declares a beat order, each beat's dramatic `fn`, and the payoff.
// Takes a readonly-friendly shape (an `as const` literal is accepted) and returns a mutable
// `LensSpec`, so the result drops straight into `defineDirection`'s `lenses`. There is no custom
// checking code: the resolved spec flows through the same `checkArc` as a built-in, producing the
// same waivable findings.
type LensSpecInput = {
  name: string;
  payoff: string;
  beats: readonly Beat<string>[];
};

export function defineLens(spec: LensSpecInput): LensSpec<string> {
  return { name: spec.name, payoff: spec.payoff, beats: spec.beats.map((b) => ({ ...b })) };
}
