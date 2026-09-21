import { assertNever } from "./assert.js";
import { KonteError } from "./errors.js";
import type { PinOccurrence } from "./pin-check.js";
import type { PromptOccurrence } from "./prompt-check.js";
import { shotById } from "./shot-index.js";
import type { AssetDefinition } from "./types/index.js";

// The four stages. `direction` is the one that owns no asset — its addresses are feedback-only
// targets.
export type Stage = "animatic" | "video" | "reference" | "direction";

// An address is a fully-qualified location — `<stage>:<suffix>`; an address and an asset path are
// the same string form.
export type ParsedAddress =
  | { stage: AssetStage; kind: "shot"; shotId: string; assetName: string; delivery: boolean }
  | { stage: AssetStage; kind: "timeline"; assetName: string; delivery: boolean }
  // A setup's plate — the frame a shared camera position is held to, keyed by the `setups` roster
  // id. `assetName` IS that id, and there is no second name slot to fill, so no reserved name and
  // no delivery derivative apply.
  | { stage: "animatic"; kind: "plate"; assetName: string; delivery: false }
  | { stage: AssetStage; kind: "reference"; assetName: string; delivery: boolean }
  // A step of one patch's chain. Keyed by the source variant, not its address: two variants at the
  // same address can each carry a patch, and both may name a step `patched`.
  | {
      stage: AssetStage;
      kind: "patch";
      sourceVariantId: string;
      assetName: string;
      delivery: false;
    };

export interface DefinitionLike {
  shots: Array<{ id: string; assets: Record<string, AssetDefinition> }>;
  topLevelAssets?: Record<string, AssetDefinition>;
  // Animatic stage only: every asset its `plates` callback declared, keyed by name.
  plates?: Record<string, AssetDefinition>;
  // Animatic stage only: the plate names it returned (see isUnexposedPlateAddress).
  exposedPlateIds?: string[];
  // Reference stage only: the asset names its callback returned (see listExposedReferenceAssetPaths).
  exposedAssetNames?: string[];
  // What the prompt and pin gates read off a stage entry, whichever one this is (see
  // prompt-check.ts, pin-check.ts). `waivers` is the one record both are keyed in.
  prompts?: readonly PromptOccurrence[];
  pins?: readonly PinOccurrence[];
  waivers?: Record<string, string>;
}

const ADDRESS_PATTERN = /^(animatic|video|reference):(.+)$/;
const NAME_BODY = "[a-zA-Z0-9_-]+";
// A reserved name fills the same slot as an author's name but is introduced by `#` instead of `.`
// (see RESERVED_NAME_SIGIL). Exactly the token `delivery` is excluded, so `#delivery` can only ever
// be read as the derivative axis — the two `#` axes never compete for the same token. The inner
// lookahead is what keeps the exclusion to that token: a longer name that merely starts with it
// (`#delivery-cut`) is a name like any other.
const RESERVED_NAME_BODY = `#(?!delivery(?![a-zA-Z0-9_-]))${NAME_BODY}`;
// Groups: 1 = shot id, 2 = author name, 3 = reserved name (2 and 3 are mutually exclusive).
const SHOT_SUFFIX_PATTERN = new RegExp(
  `^shot\\.(${NAME_BODY})(?:\\.(${NAME_BODY})|(${RESERVED_NAME_BODY}))$`,
);
// Groups: 1 = author name, 2 = reserved name.
const TIMELINE_SUFFIX_PATTERN = new RegExp(
  `^timeline(?:\\.(${NAME_BODY})|(${RESERVED_NAME_BODY}))$`,
);
// A plate's suffix: `plate.<setupId>` and nothing more. No name slot, so neither the reserved-name
// nor the `#delivery` alternation applies — matched before the delivery strip, so `plate.x#delivery`
// falls through and is rejected rather than silently read as a derivative.
const PLATE_SUFFIX_PATTERN = new RegExp(`^plate\\.(${NAME_BODY})$`);
const REFERENCE_SUFFIX_PATTERN = /^([a-zA-Z0-9_-]+)$/;
// Non-capturing forms, for the scope patterns.
const NAME_SLOT = `(?:\\.${NAME_BODY}|${RESERVED_NAME_BODY})`;
const VARIANT_ID_BODY = "v-[a-zA-Z0-9]+";
const PATCH_SUFFIX_PATTERN = new RegExp(`^patch\\.(${VARIANT_ID_BODY})\\.([a-zA-Z0-9_-]+)$`);
const PATCH_ADDRESS_PATTERN = new RegExp(
  `^(?:animatic|video|reference):patch\\.(${VARIANT_ID_BODY})\\.[a-zA-Z0-9_-]+$`,
);
// The brief's fields, in the order the review page reads them — each is its own feedback target, so
// a note on the tone is not aged out by a logline rewrite. Mirrors `DirectionBrief` (dsl/direction);
// the hash and preview builders index a brief by these keys, so a stray name is a compile error.
export const DIRECTION_BRIEF_FIELDS = [
  "logline",
  "hook",
  "audience",
  "tone",
  "look",
  "outOfScope",
  "tolerances",
] as const;

export type DirectionBriefField = (typeof DIRECTION_BRIEF_FIELDS)[number];

// The brief fields holding a list rather than a sentence — the hash, the CLI and the review page
// each render these two differently from the prose ones.
const DIRECTION_BRIEF_LIST_FIELDS = ["outOfScope", "tolerances"] as const;

export type DirectionBriefListField = (typeof DIRECTION_BRIEF_LIST_FIELDS)[number];

export function isDirectionBriefListField(
  field: DirectionBriefField,
): field is DirectionBriefListField {
  return (DIRECTION_BRIEF_LIST_FIELDS as readonly string[]).includes(field);
}

// The direction's machine-checked policy fields, each reviewed on its own so a note on the speech
// rule is not aged out by an aspect-ratio change. Mirrors the members of `DirectionPolicy`
// (dsl/direction); addressed as `direction:policy.<field>`, and the hash and preview builders index
// them by these keys.
export const DIRECTION_POLICY_FIELDS = ["format", "lang", "fonts", "speech"] as const;

export type DirectionPolicyField = (typeof DIRECTION_POLICY_FIELDS)[number];

// The review page's boxes, and the unit a human accepts in. Acceptance state is per PART (one entry
// per address, so a logline rewrite ages out only the logline), but a part is too fine to ask a
// reviewer to click through — they read a box and take a position on it. So the page offers one
// Accept per section, which writes every part the section owns. Ordered as the page reads.
export const DIRECTION_SECTIONS = [
  "brief",
  "policy",
  "characters",
  "props",
  "locations",
  "shots",
  "waivers",
] as const;

export type DirectionSection = (typeof DIRECTION_SECTIONS)[number];

// The section a part address is reviewed in — total over every address `directionPartHashes`
// produces, so every part has an Accept somewhere on the page and none can be silently unreachable.
export function directionSectionOf(address: string): DirectionSection {
  const body = address.slice("direction:".length);
  if (body.startsWith("brief.")) return "brief";
  if (body.startsWith("policy.")) return "policy";
  // The cast is one box: a character's voice rides their `characters.` prefix, and the narrator —
  // a voice with no roster entry of its own — joins them here.
  if (body.startsWith("characters.") || body === "narrator") return "characters";
  if (body.startsWith("props.")) return "props";
  // The places and the frames taken in them are one box: a setup is one camera position IN a
  // location, so the roster reads as a place and the coverage under it. Reviewing a frame means
  // reviewing the set it looks at, and splitting the two put that judgement in two boxes.
  if (body.startsWith("locations.") || body.startsWith("setups.")) return "locations";
  // Waivers peel off first; the rest of the arc tree — the root arc (its sequence map), a child act, a
  // shot — is inseparable (splitting a shot re-shapes the arc), so all of it is reviewed in the one
  // Flow & Shots box.
  if (body.includes(".waivers.")) return "waivers";
  return "shots";
}

// A direction stage carries no asset — its addresses are feedback-only targets, one per reviewable
// part of the direction, and a part IS that part's field path in `direction.ts`: a brief field
// (`brief.<field>`), a policy field (`policy.format`), a character (`characters.<id>`), a character's
// voice (`characters.<id>.voice`), the narrator's voice (`narrator`), a prop
// (`props.<id>`), a location (`locations.<id>`), a camera setup (`setups.<id>`), the root arc
// (`sequence`), a nested one (`sequence.sequences.<id>`), a shot (`sequence.shots.<id>`), or a
// waived finding in the bag of the node that owns it (`sequence.waivers.<code>[_<subject>]`). So an
// address locates its target in the file at any nesting depth, with no lookup table. Like the bare
// whole-shot feedback target `video:shot.01`, these route through `parseAddressStream` only and are
// never parsed by `parseAddress`.
const DIRECTION_ID = "[a-zA-Z0-9_-]+";
const DIRECTION_NODE_PATH = `sequence(?:\\.sequences\\.${DIRECTION_ID})*`;

// A direction scope body: a part address, or the container prefix a part hangs off — `brief`,
// `characters`, `sequence.shots`, … Both name a real place in `direction.ts`, so the prefix forms
// filter the parts under them by the same separator rule as every other address-scope
// (matchesAddressScope). Whether a scope resolves to one part or to many is the reader's business,
// not the grammar's: the live part set is the authority, and a caller needing an exact part checks
// it there.
const DIRECTION_SCOPE_BODY = [
  `brief(?:\\.(?:${DIRECTION_BRIEF_FIELDS.join("|")}))?`,
  `policy(?:\\.(?:${DIRECTION_POLICY_FIELDS.join("|")}))?`,
  `characters(?:\\.${DIRECTION_ID}(?:\\.voice)?)?`,
  `narrator`,
  `props(?:\\.${DIRECTION_ID})?`,
  `locations(?:\\.${DIRECTION_ID})?`,
  `setups(?:\\.${DIRECTION_ID})?`,
  `${DIRECTION_NODE_PATH}(?:\\.(?:shots|waivers)(?:\\.${DIRECTION_ID})?)?`,
].join("|");

// `#` opens konte's reserved namespace inside an address. It is not a legal identifier character
// (see validate-identifier, at runtime and at the type level), so nothing an author can name reaches
// it — the reservation is structural, not a check that has to be written and kept in sync. Two axes
// use it, and both read left to right as qualifiers on what precedes them:
//
//   name slot   `<container>#<name>`   a target konte owns rather than the author
//                                      (video:shot.01#composition, video:timeline#stem)
//   derivative  `<address>#delivery`   the delivery derivative of any address, always trailing
//                                      (video:shot.01.motion#delivery,
//                                       video:shot.01#composition#delivery)
//
// So `#` may appear twice in one address; `#delivery` is the only token that may be last, which is
// what keeps the parse unambiguous. `#` is reserved for this namespace and nothing else: notably an
// `<Audio id>` cue is NOT addressed `…#<id>`, since a cue id is authored and would collide.
const RESERVED_NAME_SIGIL = "#";

// Reserved asset name for a shot's composition (the assembled shotFn output).
// A composition is addressed like any shot asset (video:shot.<id>#composition)
// so it reuses the variant/feedback/accept machinery.
export const COMPOSITION_ASSET_NAME = `${RESERVED_NAME_SIGIL}composition`;

// Reserved asset name for an audio stem — the shot's <Audio>/<Video hasAudio> cues, or the
// timeline's soundtrack beds, mixed down to one file. The in-context audio review/accept anchor on
// both composition stages, materialized as a no-job leaf like a composition. What the
// materialization writes differs: a delivered stem is a manifest (the mux happens at export), the
// animatic's per-shot stem a real mix, because an audio-driven motion model consumes the file.
export const STEM_ASSET_NAME = `${RESERVED_NAME_SIGIL}stem`;

// Reserved asset name for a board shot's narration, mixed apart from its `#stem`: nothing on screen
// speaks it, so it never reaches a motion model, and `video.tsx` places it with `<Audio>`.
export const NARRATION_STEM_ASSET_NAME = `${RESERVED_NAME_SIGIL}narrationStem`;

// Reserved suffix marking the delivery (납품) derivative of an address. A delivery asset is a
// normal, independent target — e.g. `video:shot.01.motion#delivery` is the upscaled 1080p output
// derived from the 720p `video:shot.01.motion`.
export const DELIVERY_SUFFIX = `${RESERVED_NAME_SIGIL}delivery`;

// Whether a name slot holds one of konte's own reserved names (`#composition`, `#stem`, …) rather
// than a name the author wrote.
function isReservedAssetName(assetName: string): boolean {
  return assetName.startsWith(RESERVED_NAME_SIGIL);
}

// The one place the two halves of the name slot are told apart: a reserved name joins its container
// with `#`, an author's with `.`. Every formatter goes through here, so nothing else needs to know.
function joinAssetName(container: string, assetName: string): string {
  return isReservedAssetName(assetName) ? `${container}${assetName}` : `${container}.${assetName}`;
}

function parseSuffix(
  suffix: string,
  original: string,
  stage: Stage,
):
  | { kind: "shot"; shotId: string; assetName: string; delivery: boolean }
  | { kind: "timeline"; assetName: string; delivery: boolean }
  | { kind: "plate"; assetName: string; delivery: false }
  | { kind: "reference"; assetName: string; delivery: boolean }
  | { kind: "patch"; sourceVariantId: string; assetName: string; delivery: false } {
  // The patch axis is stage-agnostic (a reference asset's take can be patched too) and never a
  // delivery derivative, so it is read before both the reference branch and the suffix strip.
  const patchMatch = PATCH_SUFFIX_PATTERN.exec(suffix);
  if (patchMatch) {
    return {
      kind: "patch",
      sourceVariantId: patchMatch[1]!,
      assetName: patchMatch[2]!,
      delivery: false,
    };
  }
  // Gated on the stage, so `video:plate.x` / `reference:plate.x` are rejected rather than parsing
  // into a namespace their stage does not have.
  if (stage === "animatic") {
    const plateMatch = PLATE_SUFFIX_PATTERN.exec(suffix);
    if (plateMatch) {
      return { kind: "plate", assetName: plateMatch[1]!, delivery: false };
    }
  }
  // A reference asset has no shot/timeline axis — its suffix is a bare name.
  if (stage === "reference") {
    const refMatch = REFERENCE_SUFFIX_PATTERN.exec(suffix);
    if (refMatch) {
      return { kind: "reference", assetName: refMatch[1]!, delivery: false };
    }
    throw new KonteError("INVALID_ADDRESS", `Invalid reference address format: "${original}"`);
  }
  let delivery = false;
  let body = suffix;
  if (body.endsWith(DELIVERY_SUFFIX)) {
    delivery = true;
    body = body.slice(0, -DELIVERY_SUFFIX.length);
  }
  const shotMatch = SHOT_SUFFIX_PATTERN.exec(body);
  if (shotMatch) {
    return {
      kind: "shot",
      shotId: shotMatch[1]!,
      assetName: (shotMatch[2] ?? shotMatch[3])!,
      delivery,
    };
  }
  const timelineMatch = TIMELINE_SUFFIX_PATTERN.exec(body);
  if (timelineMatch) {
    return { kind: "timeline", assetName: (timelineMatch[1] ?? timelineMatch[2])!, delivery };
  }
  throw new KonteError("INVALID_ADDRESS", `Invalid address format: "${original}"`);
}

export function parseAddress(address: string): ParsedAddress {
  const m = ADDRESS_PATTERN.exec(address);
  if (!m) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Invalid address format: "${address}" (expected "<stage>:<path>")`,
    );
  }
  const stage = m[1] as AssetStage;
  const suffix = parseSuffix(m[2]!, address, stage);
  // `parseSuffix` only ever returns a plate for the animatic; restating it here is what carries that
  // into the type, so no consumer has to re-check its stage.
  return suffix.kind === "plate" ? { stage: "animatic", ...suffix } : { stage, ...suffix };
}

// Address and asset path are the same string form; kept as a distinct name for call sites that
// speak in "asset paths" (placeholders, graph, dependency resolution).
export const parseAssetPath = parseAddress;

// The stage a feedback target belongs to, read from its `<stage>:` prefix only. Unlike
// `parseAddress`, it does not parse the suffix, so it also accepts bare feedback targets
// (e.g. `video:shot.01`, whole-shot feedback) and direction parts (`direction:sequence`).
export function parseAddressStream(address: string): { stage: Stage } {
  const m = /^(animatic|video|reference|direction):/.exec(address);
  if (!m) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Invalid address format: "${address}" (expected "<stage>:<path>")`,
    );
  }
  return { stage: m[1] as Stage };
}

// The stage of an ASSET address. `getStage` reads the direction's feedback paths too, so it returns
// the full `Stage`; anything that names a variant or an asset is one of the three below, and this is
// where that is asserted rather than assumed by the caller.
export function getAssetStage(address: string): AssetStage {
  const m = ADDRESS_PATTERN.exec(address);
  if (!m) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Invalid asset address: "${address}" (expected an animatic, video or reference address)`,
    );
  }
  return m[1] as AssetStage;
}

export function getStage(address: string): Stage {
  const m = /^(animatic|video|reference|direction):/.exec(address);
  if (!m) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Invalid address format: "${address}" (missing stage prefix)`,
    );
  }
  return m[1] as Stage;
}

// An address-scope is one of the canonical forms, with no trailing separator:
//   <stage>                     whole stage   (video)
//   <stage>:shot.<id>           one shot      (video:shot.01)
//   <stage>:shot.<id>.<name>    one asset     (video:shot.01.motion)
//   <stage>:shot.<id>#<name>    one reserved asset (video:shot.01#composition)
//   <stage>:timeline            every timeline-level asset (animatic:timeline)
//   <stage>:timeline.<name>     one timeline-level asset
//   <stage>:timeline#<name>     the reserved one (video:timeline#stem)
//   animatic:plate              every plate        (animatic only)
//   animatic:plate.<id>         one setup's plate  (animatic:plate.deskWide)
//   <stage>:patch               every patch step in the stage
//   <stage>:patch.<variantId>   one patch's chain
//   <stage>:patch.<vid>.<name>  one step of it
// A dangling "video:" or "video:shot.01." is rejected rather than silently widened — an agent
// that built a malformed scope should fail loud.
const PATCH_SCOPE_BODY = `patch(\\.${VARIANT_ID_BODY}(\\.[a-zA-Z0-9_-]+)?)?`;
const ADDRESS_SCOPE_PATTERN = new RegExp(
  `^(?:(?:animatic|video)(?::(?:shot\\.${NAME_BODY}(?:${NAME_SLOT}(?:#delivery)?)?|timeline(?:${NAME_SLOT}(?:#delivery)?)?|${PATCH_SCOPE_BODY}))?|animatic:plate(?:\\.${NAME_BODY})?)$`,
);

// A reference scope: the whole stage `reference`, one asset `reference:<name>`, or its patch axis.
const REFERENCE_SCOPE_PATTERN = new RegExp(`^reference(:([a-zA-Z0-9_-]+|${PATCH_SCOPE_BODY}))?$`);

// A direction scope: the whole stage `direction`, one feedback part `direction:<part>`, or a
// container prefix over several of them.
const DIRECTION_SCOPE_PATTERN = new RegExp(`^direction(:(${DIRECTION_SCOPE_BODY}))?$`);

// The direction stage's own scope, resolved rather than merely validated: the whole direction
// (`direction`) or a part scope (`direction:<part>` — one part, or the prefix over the parts under
// it). A part scope is already an address, so it is returned as-is; the whole-stage form yields
// null.
export function parseDirectionScope(scope: string): { address: string | null } {
  const m = DIRECTION_SCOPE_PATTERN.exec(scope);
  if (!m) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Invalid direction scope: "${scope}" (expected "direction" or "direction:<part>", e.g. "direction:brief" or "direction:brief.logline")`,
    );
  }
  return { address: m[1] ? scope : null };
}

// Whether an address falls under an address-scope. Assumes `scope` has been validated via
// assertValidAddressScope (no trailing separator), so a plain prefix check at separator boundaries
// is exact. `#` is a boundary like `.` and `:`, so a shot scope reaches its reserved leaves
// (`video:shot.01#composition`) and an asset scope reaches that asset's delivery derivative.
// The single home for this rule — every filtering command routes here, so a new separator is
// added once rather than in each command's own copy.
export function matchesAddressScope(address: string, scope: string): boolean {
  return (
    address === scope ||
    address.startsWith(`${scope}.`) ||
    address.startsWith(`${scope}:`) ||
    address.startsWith(`${scope}${RESERVED_NAME_SIGIL}`)
  );
}

export function assertValidAddressScope(scope: string): void {
  if (
    !ADDRESS_SCOPE_PATTERN.test(scope) &&
    !REFERENCE_SCOPE_PATTERN.test(scope) &&
    !DIRECTION_SCOPE_PATTERN.test(scope)
  ) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Invalid address-scope: "${scope}" (expected <stage>, <stage>:shot.<id>, or a full address — no trailing ":" or ".")`,
    );
  }
}

// A reel scope: one of the two composition stages, whole or narrowed to a single shot. Composition
// is a per-shot concept, so the commands that take this scope (`reel-thumbnails`, `reel-audio`)
// never accept an individual asset or a timeline scope (both of which pass assertValidAddressScope
// yet are rejected here).
const REEL_SCOPE_PATTERN = /^(animatic|video)(?::shot\.([a-zA-Z0-9_-]+))?$/;

export function parseReelScope(scope: string): { stage: ShotStage; shotId?: string } {
  assertValidAddressScope(scope);
  const m = REEL_SCOPE_PATTERN.exec(scope);
  if (!m) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Unsupported address-scope: "${scope}". A reel is read per shot, so target a composition ` +
        `stage or a single shot of one, not an individual asset ` +
        `(expected "animatic", "video", or "<stage>:shot.<id>").`,
    );
  }
  const stage = m[1] as ShotStage;
  return m[2] ? { stage, shotId: m[2] } : { stage };
}

// A stage is grouped by the SHAPE of the addresses it owns, which is what decides whether a given
// formatter can produce a readable one. Three shapes, and every stage is in exactly one:
//
//   ShotStage   `shot.<id>.<name>` / `timeline.<name>`   animatic, video
//   flat name   `reference:<name>`                       reference
//   field path  `direction:brief.logline`, …             direction
//
// Without this split every formatter takes the full `Stage`, so `formatAssetPath("direction", …)`
// type-checks and returns `direction:shot.01.x` — a string `parseAddress` rejects. The types below
// are what make "which stage can be spelled this way" a fact the compiler holds rather than a
// convention each call site is trusted to remember.
export type ShotStage = "animatic" | "video";

/**
 * The stages that own an asset address at all, in any shape.
 */
export type AssetStage = ShotStage | "reference";

type StageScope = { stage: Stage };

// A stage-scope names a single stage — the granularity at which reviews and generation operate.
// Unlike an address-scope (a prefix that *filters* many addresses and can narrow to a shot or
// asset), it resolves to exactly one stage.
const STAGE_SCOPE_PATTERN = /^(animatic|video|reference|direction)$/;

// Whether a string names a stage konte can be told to act on. The pattern above is the one source
// of truth for that.
export function isStageScope(value: string): boolean {
  return STAGE_SCOPE_PATTERN.test(value);
}

export function parseStageScope(scope: string): StageScope {
  const m = STAGE_SCOPE_PATTERN.exec(scope);
  if (!m) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Invalid stage-scope: "${scope}" (expected <stage>: one of animatic, video, reference, direction)`,
    );
  }
  return { stage: m[1] as Stage };
}

export function formatAssetPath(stage: ShotStage, shotId: string, assetName: string): string {
  return `${stage}:${joinAssetName(`shot.${shotId}`, assetName)}`;
}

export function formatTimelineAssetPath(stage: ShotStage, assetName: string): string {
  return `${stage}:${joinAssetName("timeline", assetName)}`;
}

// A setup's plate. No stage parameter: only the animatic owns one.
export function formatPlateAssetPath(setupId: string): string {
  return `animatic:plate.${setupId}`;
}

// A step of the patch chain declared in `patches/<sourceVariantId>.ts`. The stage is the source
// take's, so a patch step is cleaned, pruned and grouped alongside the stage it corrects.
export function formatPatchAssetPath(
  stage: AssetStage,
  sourceVariantId: string,
  assetName: string,
): string {
  return `${stage}:patch.${sourceVariantId}.${assetName}`;
}

export function isPatchAddress(address: string): boolean {
  return PATCH_ADDRESS_PATTERN.test(address);
}

// Whether a scope narrows to the patch axis — the whole axis, one chain, or one step. Unlike every
// other scope this one names nothing a stage definition declares, so callers that validate a scope
// against the definition must let it through and let state answer.
export function isPatchScope(scope: string): boolean {
  return new RegExp(`^(?:animatic|video|reference):${PATCH_SCOPE_BODY}$`).test(scope);
}

// The variant whose patch script declares this step, i.e. which `patches/<id>.ts` owns it.
// Null for every non-patch address.
export function patchSourceVariantIdOf(address: string): string | null {
  const m = PATCH_ADDRESS_PATTERN.exec(address);
  return m ? m[1]! : null;
}

// Address and asset path are the same form, so `formatAddress` === `formatAssetPath`; kept as a
// distinct name for call sites that speak in "addresses".
export const formatAddress = formatAssetPath;
export const formatTimelineAddress = formatTimelineAssetPath;

export function formatCompositionAddress(stage: ShotStage, shotId: string): string {
  return formatAssetPath(stage, shotId, COMPOSITION_ASSET_NAME);
}

export function formatShotStemAddress(stage: ShotStage, shotId: string): string {
  return formatAssetPath(stage, shotId, STEM_ASSET_NAME);
}

export function formatNarrationStemAddress(shotId: string): string {
  return formatAssetPath("animatic", shotId, NARRATION_STEM_ASSET_NAME);
}

export function formatTimelineStemAddress(stage: ShotStage): string {
  return formatTimelineAssetPath(stage, STEM_ASSET_NAME);
}

// The bare shot-level address (`<stage>:shot.<id>`) — a feedback-only target with no asset name.
// Composite (whole-shot) feedback attaches here, so it has no variants and is never produced by
// listAddresses; it is valid only as long as the shot exists in the definition.
export function formatShotAddress(stage: ShotStage, shotId: string): string {
  return `${stage}:shot.${shotId}`;
}

const BARE_SHOT_PATTERN = /^(animatic|video):shot\.([a-zA-Z0-9_-]+)$/;

// The inverse of `formatShotAddress`: the stage and shot of a bare shot-level target, or null for
// anything else. `parseAddress` rejects these (they name no asset), so a reader that has to act on
// a whole-shot feedback target asks here.
export function parseShotAddress(address: string): { stage: ShotStage; shotId: string } | null {
  const m = BARE_SHOT_PATTERN.exec(address);
  return m ? { stage: m[1] as ShotStage, shotId: m[2]! } : null;
}

// A reference asset's path is a bare name under the `reference` stage; its address is the same form.
export function formatReferenceAssetPath(assetName: string): string {
  return `reference:${assetName}`;
}

export const formatReferenceAddress = formatReferenceAssetPath;

// The direction stage's reviewable parts — feedback attaches to one address per part, and a part is
// the field path of the thing it reviews (see DIRECTION_SCOPE_BODY). Every part of the arc tree hangs
// off a node path: `["sequence"]` at the root, one `["sequences", <id>]` pair deeper per level.
export const DIRECTION_ROOT_PATH: readonly string[] = ["sequence"];

export function directionChildNodePath(
  parentPath: readonly string[],
  sequenceId: string,
): string[] {
  return [...parentPath, "sequences", sequenceId];
}

function formatDirectionAddress(parts: readonly string[]): string {
  return `direction:${parts.join(".")}`;
}

export function formatDirectionSequenceAddress(nodePath: readonly string[]): string {
  return formatDirectionAddress(nodePath);
}

export function formatDirectionBriefAddress(field: DirectionBriefField): string {
  return formatDirectionAddress(["brief", field]);
}

export function formatDirectionPolicyAddress(field: DirectionPolicyField): string {
  return formatDirectionAddress(["policy", field]);
}

export function formatDirectionShotAddress(nodePath: readonly string[], shotId: string): string {
  return formatDirectionAddress([...nodePath, "shots", shotId]);
}

export function formatDirectionCharacterAddress(characterId: string): string {
  return formatDirectionAddress(["characters", characterId]);
}

// The character's voice, reviewed apart from their look (see `direction-hash.ts`).
export function formatDirectionCharacterVoiceAddress(characterId: string): string {
  return formatDirectionAddress(["characters", characterId, "voice"]);
}

// The narrator has no roster entry to hang a voice off, so its part is the bare field path.
export const DIRECTION_NARRATOR_ADDRESS = formatDirectionAddress(["narrator"]);

export function formatDirectionPropAddress(propId: string): string {
  return formatDirectionAddress(["props", propId]);
}

export function formatDirectionLocationAddress(locationId: string): string {
  return formatDirectionAddress(["locations", locationId]);
}

export function formatDirectionSetupAddress(setupId: string): string {
  return formatDirectionAddress(["setups", setupId]);
}

// A waiver is reviewable too — it is the author signing off a deviation, and the human may object.
// It lives in the `waivers` bag of the node whose finding it cancels, keyed `<code>[_<subject>]` (see
// `directionWaiverKey`) — one path segment, like every other key in the direction.
export function formatDirectionWaiverAddress(
  nodePath: readonly string[],
  waiverKey: string,
): string {
  return formatDirectionAddress([...nodePath, "waivers", waiverKey]);
}

// The leaf name of an address — what a listing labels it with, and the key a definition stores it
// under.
export function assetNameOf(parsed: ParsedAddress): string {
  return parsed.assetName;
}

// The suffix of an address — `shot.<id>.<name>`, `timeline.<name>`, or (reference) the bare
// `<name>`. The single source of truth for this three-way mapping: an exhaustive switch so a new
// `kind` is a compile error, never a forgotten `timeline.` fallback. Excludes the `#delivery`
// marker — callers append it where the display calls for it.
export function formatAssetPathSuffix(parsed: ParsedAddress): string {
  switch (parsed.kind) {
    case "shot":
      return joinAssetName(`shot.${parsed.shotId}`, parsed.assetName);
    case "timeline":
      return joinAssetName("timeline", parsed.assetName);
    case "plate":
      return `plate.${parsed.assetName}`;
    case "reference":
      return parsed.assetName;
    case "patch":
      return `patch.${parsed.sourceVariantId}.${parsed.assetName}`;
    default:
      return assertNever(parsed, "formatAssetPathSuffix");
  }
}

// Split an address into filesystem path segments at its structural delimiter `:` (reserved on
// Windows/NTFS). Every remaining character is `[a-zA-Z0-9_.#-]`, all path-safe. A full address
// yields exactly `[stage, suffix]` — always two, whatever the address's kind, which is what lets
// the URL and cache layouts split a path back at a fixed index (assetDir nests the patch axis
// deeper and is not reversed this way). Inverse: addressFromCacheSegments.
export function addressToCacheSegments(address: string): string[] {
  const idx = address.indexOf(":");
  if (idx === -1) return [address];
  return [address.slice(0, idx), address.slice(idx + 1)];
}

// Reconstruct the address from its cache-path segments (`<stage>/<suffix>`). The suffix never
// contains `:`, so a 2-segment join is exact.
export function addressFromCacheSegments(segments: string[]): string {
  const [stage, ...rest] = segments;
  return `${stage}:${rest.join(":")}`;
}

// Encode an address as the URL path used by the asset-serving routes — the same `:`-split segments
// as the cache layout, each percent-encoded. A decoding static file server (the capture workspace's)
// thus never materializes a `:` (Windows-reserved) directory. Parse it back with
// addressFromCacheSegments over the first two path segments.
export function addressToUrlPath(address: string): string {
  return addressToCacheSegments(address).map(encodeURIComponent).join("/");
}

// The delivery derivative address of a source video-layer address (appends the
// reserved `#delivery` suffix). `source` must be a bare address (no suffix).
export function deliveryAddressOf(source: string): string {
  return `${source}${DELIVERY_SUFFIX}`;
}

// The source address a delivery address derives from (strips `#delivery`). Returns
// the input unchanged if it carries no delivery suffix.
export function sourceAddressOfDelivery(deliveryAddress: string): string {
  return deliveryAddress.endsWith(DELIVERY_SUFFIX)
    ? deliveryAddress.slice(0, -DELIVERY_SUFFIX.length)
    : deliveryAddress;
}

// Whether an address (or asset path) names a delivery derivative. `#` cannot appear
// anywhere else in an address, so a suffix test is sufficient.
export function isDeliveryAddress(address: string): boolean {
  return address.endsWith(DELIVERY_SUFFIX);
}

// `parseAddress`, for callers that ask a question of an address rather than demand one — a bare
// feedback target (`video:shot.01`) or a direction part is a legitimate null here, not an error.
// Prefer this over matching an address's shape by hand: `.`-boundary string tests silently miss the
// reserved names, which are introduced by `#`.
export function tryParseAddress(address: string): ParsedAddress | null {
  try {
    return parseAddress(address);
  } catch {
    return null;
  }
}

// Both leaf predicates read the parse rather than re-matching the suffix, so the reserved name's
// two containers (a shot, the timeline) stay one rule. A delivery derivative is not the leaf
// itself — `video:shot.01#composition#delivery` is a generated upscale — so it is excluded.
export function isCompositionAddress(address: string): boolean {
  const parsed = tryParseAddress(address);
  if (!parsed || parsed.stage === "reference" || parsed.assetName !== COMPOSITION_ASSET_NAME) {
    return false;
  }
  return parsed.kind === "shot" && !parsed.delivery;
}

// A stem — the audio sign-off for its container (a shot, the timeline), on either composition
// stage, and so what decides whether a cascade rooted there may sign off audio. A board shot's
// `#narrationStem` is one too.
export function isStemAddress(address: string): boolean {
  const parsed = tryParseAddress(address);
  if (!parsed || parsed.stage === "reference" || parsed.delivery) return false;
  if (parsed.assetName === STEM_ASSET_NAME) {
    return parsed.kind === "shot" || parsed.kind === "timeline";
  }
  return isNarrationStemAddress(address);
}

export function isNarrationStemAddress(address: string): boolean {
  const parsed = tryParseAddress(address);
  return (
    parsed?.stage === "animatic" &&
    parsed.kind === "shot" &&
    parsed.assetName === NARRATION_STEM_ASSET_NAME &&
    !parsed.delivery
  );
}

// A composition or a leaf stem: both are synthesized, no-job leaves materialized from ready
// upstreams (never generated by a backend). The predicate the no-job handling keys on.
export function isMaterializedLeafAddress(address: string): boolean {
  return isCompositionAddress(address) || isStemAddress(address);
}

export const isMaterializedLeafAssetPath = isMaterializedLeafAddress;

interface StemShotLike {
  id: string;
  stemRefs?: readonly string[];
  narrationStemRefs?: readonly string[];
}

interface StemVideoLike {
  stage: ShotStage;
  shots: readonly StemShotLike[];
  timelineSoundtracks?: readonly unknown[];
}

/** One shot's stem leaves and the cues each is mixed from: `#stem`, then the board's `#narrationStem`. */
export function listShotStems(
  stage: ShotStage,
  shot: StemShotLike,
): Array<{ address: string; refs: readonly string[] }> {
  const stems: Array<{ address: string; refs: readonly string[] }> = [];
  if ((shot.stemRefs?.length ?? 0) > 0) {
    stems.push({ address: formatShotStemAddress(stage, shot.id), refs: shot.stemRefs! });
  }
  if (stage === "animatic" && (shot.narrationStemRefs?.length ?? 0) > 0) {
    stems.push({ address: formatNarrationStemAddress(shot.id), refs: shot.narrationStemRefs! });
  }
  return stems;
}

/** The reserved stem names a shot of this stage can carry. */
export function shotStemAssetNames(stage: ShotStage): string[] {
  return stage === "animatic" ? [STEM_ASSET_NAME, NARRATION_STEM_ASSET_NAME] : [STEM_ASSET_NAME];
}

/** Every audio cue a shot plays, across its stems. */
export function shotCueRefs(shot: StemShotLike): string[] {
  return [...(shot.stemRefs ?? []), ...(shot.narrationStemRefs ?? [])];
}

// The stem leaves a stage declares: each shot's stems (`listShotStems`), plus the timeline stem
// when the stage has soundtrack beds.
export function listStemAddresses(video: StemVideoLike): string[] {
  const addresses: string[] = [];
  for (const s of video.shots) {
    for (const stem of listShotStems(video.stage, s)) addresses.push(stem.address);
  }
  if ((video.timelineSoundtracks?.length ?? 0) > 0) {
    addresses.push(formatTimelineStemAddress(video.stage));
  }
  return addresses;
}

interface CompositionShotLike {
  id: string;
  shotFn?: unknown;
  assets?: Record<string, { kind?: string }>;
}

// Composition addresses for every developed shot of a stage — both composition stages build one per
// shot, so this takes the stage along with the shots rather than assuming video.
export function listCompositionAddresses(video: {
  stage: ShotStage;
  shots: readonly CompositionShotLike[];
}): string[] {
  const addresses: string[] = [];
  for (const s of video.shots) {
    if (s.shotFn) addresses.push(formatCompositionAddress(video.stage, s.id));
  }
  return addresses;
}

// Composition addresses usable as frame-delivery sources: every renderable shot — a shotFn
// composition, or a fallback shot (no shotFn) that can render a fallback (≥1 comfy/file asset).
// Superset of listCompositionAddresses; used to keep a fallback shot's `composition#delivery`
// target from being pruned as an orphan.
export function listFrameDeliverySources(video: {
  shots: readonly CompositionShotLike[];
}): string[] {
  const addresses: string[] = [];
  for (const s of video.shots) {
    if (s.shotFn || shotHasFallbackCandidate(s)) {
      addresses.push(formatCompositionAddress("video", s.id));
    }
  }
  return addresses;
}

function shotHasFallbackCandidate(shot: CompositionShotLike): boolean {
  return Object.values(shot.assets ?? {}).some((e) => e.kind === "comfy" || e.kind === "file");
}

// The existence half of `getAssetEntry`; delegate so the lookup logic lives in exactly one place.
export function validateAddress(address: string, definition: DefinitionLike): void {
  void getAssetEntry(definition, address);
}

export function listAssetPaths(definition: DefinitionLike, stage: AssetStage): string[] {
  const paths: string[] = [];
  // A reference asset lives in `topLevelAssets` with no shot axis, keyed by its bare name.
  if (stage === "reference") {
    for (const assetName of Object.keys(definition.topLevelAssets ?? {})) {
      paths.push(formatReferenceAssetPath(assetName));
    }
    return paths;
  }
  if (definition.topLevelAssets) {
    for (const assetName of Object.keys(definition.topLevelAssets)) {
      paths.push(formatTimelineAssetPath(stage, assetName));
    }
  }
  if (stage === "animatic") {
    for (const setupId of Object.keys(definition.plates ?? {})) {
      paths.push(formatPlateAssetPath(setupId));
    }
  }
  for (const s of definition.shots) {
    for (const assetName of Object.keys(s.assets)) {
      paths.push(formatAssetPath(stage, s.id, assetName));
    }
  }
  return paths;
}

// Address and asset path are the same form, so listing addresses for a stage is listing its asset
// paths; kept as a distinct name for call sites that speak in "addresses".
export const listAddresses = listAssetPaths;

// A reference definition's assets, as asset paths / addresses (the same form).
export function listReferenceAssetPaths(definition: DefinitionLike): string[] {
  return listAssetPaths(definition, "reference");
}

export const listReferenceAddresses = listReferenceAssetPaths;

// The reference assets the stage published — the ones its callback returned (`exposedAssetNames`).
// A declared-but-unreturned asset is an intermediate another reference asset consumes: generated and
// tracked like any other, but never review work — it is read through the asset that consumes it, the
// way a patch chain's earlier step is, and no accept is ever owed on it. The review surfaces and the
// accept accounting list this; `doctor`/`generate` keep listing them all.
export function listExposedReferenceAssetPaths(definition: DefinitionLike): string[] {
  const exposed = definition.exposedAssetNames;
  // Only a definition that never went through `defineReference` lacks the field; it published all.
  if (!exposed) return listReferenceAssetPaths(definition);
  const names = new Set(exposed.map(formatReferenceAssetPath));
  return listReferenceAssetPaths(definition).filter((p) => names.has(p));
}

// A plate the `plates` callback declared without returning it under a setup id: an intermediate the
// plates are built from, read through the plate that consumes it — an unexposed reference asset's
// terms.
export function isUnexposedPlateAddress(
  definition: DefinitionLike | null | undefined,
  address: string,
): boolean {
  const exposed = definition?.exposedPlateIds;
  // Only a definition that never went through `defineAnimatic` lacks the field; it filed all.
  if (!exposed) return false;
  const parsed = tryParseAddress(address);
  return parsed?.kind === "plate" && !exposed.includes(parsed.assetName);
}

// A plate: judged inside the panels drawn on it, never on its own.
export function isPlateAddress(address: string): boolean {
  return tryParseAddress(address)?.kind === "plate";
}

// The assets a review shows: every one but an intermediate read through what consumes it and a
// plate.
export function listReviewableAssetPaths(definition: DefinitionLike, stage: AssetStage): string[] {
  return stage === "reference"
    ? listExposedReferenceAssetPaths(definition)
    : listAssetPaths(definition, stage).filter((p) => !isPlateAddress(p));
}

export function getAssetEntry(definition: DefinitionLike, assetPath: string): AssetDefinition {
  const parsed = parseAssetPath(assetPath);

  if (parsed.kind === "plate") {
    const plate = definition.plates?.[parsed.assetName];
    if (!plate) {
      throw new KonteError(
        "ADDRESS_NOT_FOUND",
        `Setup "${parsed.assetName}" has no plate in animatic.tsx — declare it in \`plates\``,
      );
    }
    return plate;
  }

  if (parsed.kind === "timeline" || parsed.kind === "reference") {
    const topLevelAsset = definition.topLevelAssets?.[parsed.assetName];
    if (!topLevelAsset) {
      throw new KonteError(
        "ADDRESS_NOT_FOUND",
        `Timeline asset "${parsed.assetName}" not found in definition`,
      );
    }
    return topLevelAsset;
  }

  // A patch step is declared by `patches/<variantId>.ts`, never by a stage definition — its
  // definition comes from the patch catalog.
  if (parsed.kind === "patch") {
    throw new KonteError(
      "ADDRESS_NOT_FOUND",
      `"${assetPath}" is a patch step — its definition lives in patches/${parsed.sourceVariantId}.ts, not in the stage definition`,
    );
  }

  const foundShot = shotById(definition.shots, parsed.shotId);
  if (!foundShot) {
    throw new KonteError("ADDRESS_NOT_FOUND", `Shot "${parsed.shotId}" not found in definition`);
  }

  const shotAsset = foundShot.assets[parsed.assetName];
  if (!shotAsset) {
    throw new KonteError(
      "ADDRESS_NOT_FOUND",
      `Asset "${parsed.assetName}" not found in shot "${parsed.shotId}" of definition`,
    );
  }

  return shotAsset;
}

// An address is already the asset-path form, so looking up by address is the same lookup.
export const getAssetEntryByAddress = getAssetEntry;
