// One `"prompt"` / `"negativePrompt"` / `"spokenText"` input's value, as declared at one address.
// `negative` marks the second kind, which reverses which phrasing is the finding; `spoken` the
// third, collected for listing but never checked. `exemptions` are the declaring adapter's
// (`promptExemptions`); `script` is the direction's spoken lines, a line quoted verbatim cut out
// before the value is read. `spokenWithin` holds the words a `"prompt"` value carries for a model
// that takes its lines there (`spokenTextPattern`) — the value stays a prompt and is checked as one.
export type PromptOccurrence = {
  address: string;
  input: string;
  value: string;
  // What the declaring adapter outputs.
  media: "image" | "video" | "audio";
  negative?: true;
  spoken?: true;
  spokenWithin?: readonly string[];
  // The marked text each `spokenWithin` span was written inside, in the same order.
  spokenMarks?: readonly string[];
  exemptions?: readonly RegExp[];
  script?: readonly string[];
};

// One `pin` input's wiring, as declared at one address. `source` is the address it was passed, never
// what that resolves to.
export type PinOccurrence = {
  address: string;
  input: string;
  pin: "start" | "end";
  // Absent where the adapter declares the slot and the author passed nothing. `join-unpinned` reads
  // those to tell a model that CANNOT carry a seam from one whose author did not; every other reader
  // is about what a pin points at, and skips them.
  source?: string;
  // How long the take at `address` is, where its adapter declares the length, and where in it an end
  // image lands — the frame index a workflow anchors it at, else the take's last frame. What says
  // whether a composition that plays the take cuts on the landing.
  clip?: { sec: number; frameSec: number; landsAt: number };
  // The adapter also takes an image that is not pinned.
  referable?: true;
};

/**
 * One wired image input that is not a `pin`, as declared at one address: the addresses it was
 * passed, and whether the declaration is generative rather than deterministic.
 */
export type ImageInputOccurrence = {
  address: string;
  sources: readonly string[];
  generative: boolean;
};

export type StemInputOccurrence = {
  address: string;
  source: string;
};

// What a stage build finds of itself instead of refusing to load: a demand the direction makes that
// the stage file has not caught up with, after an edit to the direction alone.
export type BuildFindingCode =
  // A shot the direction gives lines to that does not sound them.
  | "script-unvoiced"
  // A shot whose `<Cutin>` and the direction's `cutin` disagree on whether there is one.
  | "cutin-required"
  | "cutin-undeclared"
  // A plate filed under a setup the direction does not declare.
  | "plate-undeclared-setup"
  // A soundtrack anchored to a shot the direction does not declare.
  | "soundtrack-anchor-unknown";

export type BuildFinding = {
  code: BuildFindingCode;
  subject: string;
  message: string;
  targets: readonly string[];
};
