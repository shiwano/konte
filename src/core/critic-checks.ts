import type { FindingCode } from "./finding.js";

// The problem codes each shipped critic contract (`src/cli/templates/agents/<critic>.md`) reports,
// the source of `docs/CRITICS.md`. The contract stays the agent's prose; `critics-doc.test.ts`
// holds the two to one code set. `machine` names the findings that settle the formal half of the
// same question on the artifact the critic reads — `direction.ts`, a prompt, a note, a board's audio.

type CriticCheck = {
  code: string;
  checks: string;
  machine?: readonly FindingCode[];
};

export type Critic = {
  name: string;
  reviews: string;
  checks: readonly CriticCheck[];
};

export const CRITICS: readonly Critic[] = [
  {
    name: "konte-direction-critic",
    reviews: "`direction.ts`, before any stage content is written.",
    checks: [
      {
        code: "late-hook",
        checks: "The first shot does not put `brief.hook` on screen.",
      },
      {
        code: "redundant-exposition",
        checks: "An explanatory shot that can be deleted.",
      },
      {
        code: "possible-overcut",
        checks: "A trigger and its reaction split where one readable action would do.",
      },
      {
        code: "broken-causality",
        checks: "Position, possession, movement or state does not connect across a continuity run.",
      },
      {
        code: "contrived-causality",
        checks: "A physical chain that exists only to reach the last image.",
      },
      {
        code: "orphaned-setup",
        checks: "A plant never collected.",
      },
      {
        code: "illegible-action",
        checks: "An `action`'s subject, change or result is ambiguous without sound.",
      },
      {
        code: "flat-escalation",
        checks: "A repetition that raises nothing.",
      },
      {
        code: "risk-concentration",
        checks: "The payoff rests on one shot with no reading left if its takes don't land.",
      },
      {
        code: "undivided-motion",
        checks: "One take carries a motion its frame cannot show, or a hinge's whole transit.",
      },
      {
        code: "continuity-exposure",
        checks: "An adjacent same-location pair changes size by one step with no job for the cut.",
      },
      {
        code: "unsupported-long-take",
        checks:
          "A `continuous` join whose `action` carries nothing across the seam, or whose shots want different frames.",
        machine: ["join-impossible", "join-lineup-mismatch"],
      },
      {
        code: "missed-long-take",
        checks: "A beat or event that lives on uncut time is cut across shots.",
        machine: ["join-undeclared"],
      },
      {
        code: "missed-coverage",
        checks: "An unbroken exchange split into a shot per setup.",
      },
      {
        code: "unsupported-coverage",
        checks: "A `coverage: true` shot holding one act or a quiet beat.",
      },
      {
        code: "overloaded-coverage",
        checks: "A coverage shot with more beats than its span carries, or a broken cause.",
      },
      {
        code: "weak-payoff",
        checks:
          "The payoff doesn't land, or the final image does not carry `brief.audience`'s takeaway.",
        machine: ["no-payoff", "unearned-payoff"],
      },
      {
        code: "unrostered-recurrence",
        checks: "A noun several shots' `action` names has no roster entry.",
      },
      {
        code: "view-mismatch",
        checks:
          "A setup's `view` is not the way its `description` faces, or its screen sides contradict the master's.",
        machine: ["view-undeclared", "holds-outside-view"],
      },
      {
        code: "absent-subject",
        checks:
          "A subject missing from its endpoint `lineup` / `lineupTo` or from `passing`, or a shown prop missing from `props`.",
        machine: ["lineup-gap", "props-missing"],
      },
      {
        code: "illegible-jump",
        checks: "A `jump-back` / `jump-forward` join no neighbouring shot lets a viewer read.",
        machine: ["location-backtrack"],
      },
      {
        code: "unrostered-set",
        checks: "An `action` names a thing of the set its location's `landmarks` does not hold.",
      },
      {
        code: "unnamed-presence",
        checks: "The staging requires a figure no shot names and no roster holds.",
      },
      {
        code: "out-of-scope",
        checks: "An `action` asks for what `brief.outOfScope` bans.",
      },
      {
        code: "lost-keep",
        checks: "An item of `brief.source.keep` no shot puts on screen.",
      },
    ],
  },
  {
    name: "konte-staging-critic",
    reviews:
      "Pending panel prompts in `animatic.tsx`, against their action, plates and neighbours.",
    checks: [
      {
        code: "lineup-only",
        checks:
          "The prompt says only who is on which side, leaving facing and the rest of the frame to the model.",
      },
      {
        code: "hides-action",
        checks: "A `hinge:` is peripheral, hidden, too small, off-path or implausibly placed.",
      },
      {
        code: "flat-run",
        checks:
          "Adjacent panels repeat size, height, placement and facing with no job, or a run uses one formula.",
      },
      {
        code: "direction-break",
        checks:
          "A side or facing flips across a cut with no move or jump join, or a gaze misses its target or `offscreen:` side.",
      },
      {
        code: "set-clash",
        checks:
          "A figure placed where the plate's landmark stands, or a part of the place the plate does not show.",
        machine: ["landmark-unheld"],
      },
      {
        code: "view-turned",
        checks: "The plate faces another way than the view image its setup stands on.",
      },
      {
        code: "off-plate-camera",
        checks: "The prompt names a size or camera height the plate does not have.",
      },
      {
        code: "contact-unsaid",
        checks: "The parts where one object meets another are unsaid.",
      },
      {
        code: "contradiction",
        checks: "Two parts of the prompt place or turn the same figure differently.",
      },
    ],
  },
  {
    name: "konte-prompt-critic",
    reviews: "one stage's pending prompts, as text, before the first spend on it.",
    checks: [
      {
        code: "named-exclusion",
        checks:
          "A prompt names something to leave out, in a model that does not read it as an omission.",
        machine: ["prompt-negation", "prompt-double-negative"],
      },
      {
        code: "inconsistent-description",
        checks: "The same prop, surface, costume or movement is worded differently in two shots.",
      },
      {
        code: "reference-contradicted",
        checks:
          "A reference held as it stands, then its subject written in another state, count or size.",
      },
      {
        code: "size-unmeasured",
        checks: "A recurring object a character meets is not sized against the body.",
      },
      {
        code: "restated-frame",
        checks: "A motion prompt re-describes the composition its keyframe fixes.",
      },
      {
        code: "model-pitfall",
        checks: "The prompt asks for what the model is known to drop.",
      },
      {
        code: "time-talk",
        checks: "A still's prompt describes what has yet to happen.",
        machine: ["prompt-not-yet"],
      },
      {
        code: "landed-opening",
        checks: "An `opening` keyframe already holds the change the shot's `action` lands.",
      },
      {
        code: "under-directed-voice",
        checks: "A spoken line's manner is listed as acoustics, or left to its voice reference.",
      },
      {
        code: "undetermined-reading",
        checks: "A line's written form leaves open a reading orthography settles.",
      },
      {
        code: "unstable-reading",
        checks: "A word no reliable reading attaches to, not respelled at the take.",
      },
      {
        code: "unexpanded-token",
        checks: "A numeral, date, unit or abbreviation not spelled out at the take.",
      },
      {
        code: "lineup-mismatch",
        checks:
          "A subject written into another place than the `lineup:` line puts them, or one it does not hold.",
        machine: ["subject-unnamed"],
      },
      {
        code: "set-mismatch",
        checks:
          "A subject on the wrong side of the `set:` line's landmarks, or a listed landmark moved.",
        machine: ["landmark-unheld", "landmark-unnamed"],
      },
      {
        code: "body-relative-side",
        checks: "A worn or carried object placed by the figure's own left or right.",
      },
      {
        code: "acting-dropped",
        checks: "A spoken line's prompt drops the delivery its `acting:` note asks for.",
      },
      {
        code: "out-of-scope-object",
        checks: "The prompt names a thing `brief.outOfScope` keeps off screen, even as unseen.",
      },
      {
        code: "unchained-beat",
        checks: "In a coverage take, a beat that does not open on where the last one lands.",
      },
      {
        code: "missing-detail-cuts",
        checks: "In a coverage take, the quick detail cuts are not written as a beat of the body.",
      },
      {
        code: "unwritten-grammar",
        checks: "In a coverage take, the piece's own motion grammar is not written in.",
      },
      {
        code: "contact-unmarked",
        checks:
          "In a coverage take, a contact does not restate the feature telling the two figures apart.",
      },
      {
        code: "off-length",
        checks: "A coverage take outside the adapter guide's length range.",
      },
      {
        code: "view-instant-missing",
        checks: "A view entry's `summary` is not that picture's instant.",
      },
      {
        code: "view-unmeasured",
        checks:
          "A view's camera height and what is in frame are not written in things the master shows.",
        machine: ["view-unnamed"],
      },
      {
        code: "view-relaid",
        checks: "A view lays the room out again wall by wall.",
      },
      {
        code: "view-unbuilt",
        checks: "A view does not write the build of what the master does not show.",
      },
      {
        code: "occupied-plate",
        checks: "A `plates` entry's prompt puts a subject, a pose or an action in the frame.",
      },
    ],
  },
  {
    name: "konte-animatic-critic",
    reviews: "one board's panels and lines, as a first-time viewer, and its plates.",
    checks: [
      {
        code: "weak-hook",
        checks: "Nothing to want answered in the first panel.",
      },
      {
        code: "misread-shot",
        checks:
          "A panel reads as another subject or event than its `action`, or a passer at an endpoint.",
      },
      {
        code: "invisible-change",
        checks: "No panel shows the shot's change landed, or starting where it should.",
      },
      {
        code: "absent-subject",
        checks: "A panel does not hold someone its `lineup` / `lineupTo` or `action` needs.",
      },
      {
        code: "lineup-misplaced",
        checks: "The frame holds them in another order than the `lineup`.",
      },
      {
        code: "jump-cut",
        checks: "An adjacent pair changing neither size nor angle, with no job and no `join`.",
      },
      {
        code: "axis-break",
        checks: "An adjacent pair swapping a subject's side or direction.",
      },
      {
        code: "continuity-drift",
        checks:
          "A recurring thing that changes across panels — possession, holding hand, size against the body, posture, the ledger.",
      },
      {
        code: "contact-off",
        checks: "The part a contact needs faces away, falls short or sits elsewhere.",
      },
      {
        code: "look-drift",
        checks: "A panel whose palette, register or scale breaks from the board.",
      },
      {
        code: "wrong-speaker",
        checks: "A line playing over a picture that does not carry its speaker or its shot.",
      },
      {
        code: "line-misplaced",
        checks: "A line outside its shot's window, or on the wrong instant of it.",
        machine: ["line-truncated"],
      },
      {
        code: "flat-ending",
        checks: "A last panel that carries nothing.",
      },
      {
        code: "fabricated-ui",
        checks: "A real product's screen showing what that product never displays.",
      },
      {
        code: "thin-coverage-note",
        checks: "A coverage shot's `blocking` / `camera` stops short of the shot.",
        machine: ["movement-unwritten"],
      },
      {
        code: "plate-mismatch",
        checks: "A plate misses a landmark its `set:` line lists, or holds another of the place.",
      },
      {
        code: "unplaced",
        checks: "Nothing in a plate fixes the location.",
      },
      {
        code: "occupied",
        checks: "A figure or a pose in a plate.",
      },
      {
        code: "unstyled",
        checks: "A plate with no line, texture or object of the piece's look.",
      },
      {
        code: "off-framing",
        checks: "A plate is not the size its setup declares.",
      },
      {
        code: "view-drift",
        checks: "A view image builds, places or lights the location differently from its master.",
      },
    ],
  },
  {
    name: "konte-video-critic",
    reviews: "motion takes and compositions against their action and accepted board.",
    checks: [
      {
        code: "never-moved",
        checks: "The ask moved and no tile differs.",
      },
      {
        code: "action-missed",
        checks: "The change the `action` names is on no tile, or another event is.",
      },
      {
        code: "wrong-mover",
        checks:
          "Wrong mover, an unexplained appearance, disappearance or doubling, or a passer at an endpoint.",
      },
      {
        code: "hinge-lost",
        checks: "A required `hinge` is absent.",
      },
      {
        code: "eyeline-off",
        checks:
          "A gaze toward a figure out of frame turned to another side than `offscreen`, or into the lens.",
      },
      {
        code: "camera-off",
        checks:
          "The camera does other than `camera` asks, or the picture cuts inside a non-coverage take.",
      },
      {
        code: "endpoint-off",
        checks: "The first or last tile is not the panel the take was built on.",
      },
      {
        code: "contact-off",
        checks:
          "At the contact's tile, the part it needs is turned away, short, or moved on the object.",
      },
      {
        code: "morph",
        checks: "An identity, a hand or an object changing through the tiles.",
      },
      {
        code: "seam-break",
        checks: "Across a boundary, a change its `join` does not allow.",
      },
      {
        code: "beat-dropped",
        checks: "On a coverage shot, an `action` beat on no tile.",
      },
      {
        code: "frozen-stretch",
        checks: "On a coverage shot, a stretch of tiles that stops moving.",
      },
      {
        code: "identity-swap",
        checks:
          "On a coverage shot, the two figures' telling feature swaps or doubles at a contact.",
      },
      {
        code: "insert-flood",
        checks: "Inserts crowd out the exchange.",
      },
      {
        code: "tail-damage",
        checks: "The last tiles smear.",
      },
      {
        code: "half-speed",
        checks: "The action slower than life.",
      },
      {
        code: "drift",
        checks: "A camera floating where `camera` asked for a lock.",
      },
    ],
  },
];
