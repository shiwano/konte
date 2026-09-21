export type VariantStatus = "none" | "accepted";

export type MediaKind = "video" | "image" | "audio";

// The declaration one take was generated from — what `<stage>.tsx` handed the model then, read off
// the take's `definition.json` snapshot. Absent when the take has none (cleaned, a `file` mirror, a
// materialized leaf).
export interface AssetInfo {
  backend: "comfy" | "fal" | "local" | "file";
  // The backend's own identifier: a workflow filename, an endpoint id, an ffmpeg operation, a path.
  ref: string;
  deterministic: boolean;
  // The `"prompt"`/`"negativePrompt"`/`"spokenText"` inputs, split off so the text a model reads is
  // not buried among the numbers.
  prompts: AssetPromptInfo[];
  // Every other input, in declaration order.
  inputs: AssetInputInfo[];
}

export interface AssetPromptInfo {
  input: string;
  kind: "prompt" | "negative" | "spoken";
  value: string;
}

export interface AssetInputInfo {
  // The name the adapter declares this input under — never the backend's own key, which names
  // nothing a reviewer can act on.
  name: string;
  // Display form: a string as-is, anything else as indented JSON, with every `__konte:…__`
  // placeholder replaced by the address it names.
  value: string;
  // The addresses this input consumes, each with the still of the take it consumed when that take is
  // still in state.
  refs: AssetRefInfo[];
}

export interface AssetRefInfo {
  address: string;
  imageUrl: string | null;
}

export interface VideoAssetInfo {
  assetName: string;
  address: string;
  variantId: string | null;
  variantStatus: VariantStatus;
  // True when the accepted variant has a newer, ready, non-stale sibling (a reroll
  // finished after the accept) — surfaced so the reviewer knows to re-accept.
  hasNewerVariant: boolean;
  mediaKind: MediaKind;
  fileUrl?: string;
  variants: VariantInfo[];
}

// One composited media element on a shot's timeline (a Video or Audio layer), with
// its shot-local time range and audio routing — the data behind the video track's
// per-shot clips. `address`/`assetName` point at the owning asset (null when
// unmappable) so a clip can open that asset's variant gallery.
export interface ClipInfo {
  assetName: string | null;
  address: string | null;
  mediaType: "video" | "image" | "audio";
  start: number;
  end: number;
  mediaStart: number | null;
  volume: number | null;
  hasAudio: boolean;
  // The address this clip plays has no take yet, so it draws as a placeholder. Resolved
  // server-side (see `clipsFor`) — a clip may name an address the shot's assets do not carry.
  notReady: boolean;
}

// One placement of an audio asset on the global timeline (absolute seconds). The same
// asset may be placed multiple times (a reused SFX) — each is a separate cue. `cueId` labels a
// placement in the timeline; `shotId` is the shot whose composition placed it, absent
// only for a timeline bed. Accept and focus route through the cue's shot, so a reused asset needs
// no single owning shot.
export interface AudioCueInfo {
  start: number;
  end: number;
  cueId: string | null;
  volume: number | null;
  shotId?: string;
}

// An audio asset on the review timeline's audio track: per-shot `<Audio>` cues (kind "sound",
// each accepted with the shot that placed it) or a timeline-spanning bed (kind "soundtrack", i.e.
// BGM, accepted via `timeline#stem`). The accept affordance on a cue re-routes to the owning
// accept, never a standalone per-asset decision.
export interface AudioTrackAssetInfo {
  address: string;
  assetName: string;
  kind: "sound" | "soundtrack";
  variantId: string | null;
  variantStatus: VariantStatus;
  hasNewerVariant: boolean;
  fileUrl?: string;
  variants: VariantInfo[];
  // Every placement of this asset on the timeline, in absolute seconds.
  cues: AudioCueInfo[];
}

// One panel's declared movement, carried into the video review under the panel it moves out of.
export interface ShotMoveInfo {
  // The animatic panel's asset name — which board frame the prose starts from.
  panel: string;
  // The panel keys the shot's `<Cutin>`, the second camera frame over its picture.
  cutin: boolean;
  blocking: string;
  camera: string;
}

export interface ShotStemStatus {
  address: string;
  variantId: string | null;
  // The stem's live definition hash, snapshotted like compositionDefinitionHash so an audio-only
  // edit (a retime, a volume change) ages a shot comment out.
  definitionHash: string | null;
  needsReview: boolean;
}

export interface ShotInfo {
  shotId: string;
  startTime: number;
  duration: number;
  action: string;
  // The shot's spoken/narrated lines, from the direction. Empty when the shot has none.
  script: ScriptLineView[];
  // The boundary into this shot, from the direction. Null on an ordinary cut.
  join: "continuous" | "jump-back" | "jump-forward" | null;
  // The movement the board declared for this shot, one entry per panel that carries one, in panel
  // order. `video.tsx` wrote its motion prompt from this prose, so it is the claim the motion is
  // watched against. Empty when the board has no shot of this id or none of its panels declares one.
  moves: ShotMoveInfo[];
  assets: VideoAssetInfo[];
  // Composited clips on this shot's timeline, in document order.
  clips: ClipInfo[];
  feedback: FeedbackInfo[];
  // Handoff notes (AI -> reviewer) for this shot's assets, shown inline always.
  handoffNotes: Array<{ assetName: string; text: string }>;
  allAccepted: boolean;
  /** Whether this shot's shown half still holds a verdict — the server's one answer (`shotNeedsVerdict`). */
  needsVerdict: boolean;
  /** The gallery-backed addresses that verdict lands on, over the half being shown. */
  verdictAddresses: string[];
  hasComposition: boolean;
  // True for an undeveloped shot (the injected pendingShot): no composition/asset, rendered as a
  // black frame carrying the shot's `action`. Export refuses while any remain.
  pending: boolean;
  // True for an aside — a shot that occupies the clock without being a shot of the arc. On the board
  // it has no composition either (konte fills its span with a labelled slug), but unlike a pending
  // shot it is finished business: export never refuses over it, and it owes no accept here.
  aside: boolean;
  // The composition target address (when the shot has a shotFn), the currently
  // accepted composition variant, and whether that accepted variant is stale.
  compositionAddress: string | null;
  compositionVariantId: string | null;
  // The composition's live definition hash, snapshotted with a shot comment so it goes stale on a
  // shotFn edit (a transition) that mints no variant. null when the shot has no composition.
  compositionDefinitionHash: string | null;
  compositionNeedsReview: boolean;
  // The shot's audio stems (`#stem`, and a board shot's `#narrationStem`), accepted with the shot.
  // Empty when the shot has no audio. A stem's `needsReview` re-opens the shot just like
  // `compositionNeedsReview`.
  stems: ShotStemStatus[];
  // Whether this shot is standing in with the board of the same id — its delivered picture is not
  // made yet. Display only: the shot carries no verdict while it is true, so the accept toggle is
  // closed and a decision on it is dropped at submit.
  showingStandIn: boolean;
  // A track of this shot has no take yet (the timeline's dashed "Not ready" clip), so it is drawn
  // over a placeholder and its accept toggle is closed. See `shotNotReady`.
  notReady: boolean;
}

export interface TimelineNote {
  id: string;
  time: number;
  shotId?: string;
  text: string;
  x?: number;
  y?: number;
  stale?: boolean;
}

export interface VideoPreviewState {
  // One page for both composition stages; the mode says which reel it is playing.
  mode: "video-preview" | "animatic-preview";
  fps: number;
  shots: ShotInfo[];
  totalDuration: number;
  size: { width: number; height: number };
  // Every audio asset placed on the timeline — per-shot cues and timeline beds (BGM) — each
  // with its placements in absolute time. Drives the audio track; per-shot cues accept with their
  // shot, beds via the timeline stem below.
  audioAssets: AudioTrackAssetInfo[];
  // The take every address a composition CONSUMES was rendered from, keyed by address. Holds what
  // the page's own arrays cannot name — an `animatic:` panel, a `reference:` sheet, another shot's
  // frame — all of it on screen inside a composite. Carried back at submit so a comment's subject
  // covers everything the reviewer perceived, with a gallery pick overriding.
  compositionRefVariants: Record<string, string>;
  // The timeline audio stem (soundtrack beds) — the single in-context accept for the beds.
  // Absent when the video has no soundtracks.
  timelineStem?: TimelineStemInfo;
  keep: KeepGraphInfo;
  handoffSummary?: string;
}

// What the Keep-or-regenerate prompt reads: the accepted takes standing downstream of an accept on
// this page, across stages, and what each was made from.
export interface KeepGraphInfo {
  // Every address an accept here can change or a prompt can name, keyed by address.
  addresses: Record<string, KeepAddressInfo>;
  // Every unit those addresses belong to, keyed by unit — a reel shot's address or a reference
  // asset's.
  units: Record<string, KeepUnitInfo>;
}

export interface KeepAddressInfo {
  unit: string;
  // A generation or patch output: what Keep keeps and Regenerate rerolls. False for a take konte
  // re-makes itself or a `file`, listed as an upstream an accept can change.
  rerollable: boolean;
  acceptedVariantId: string | null;
  takes: Record<string, KeepTakeInfo>;
  // The rerollable addresses made from this one: directly (`via` is this address), or through takes
  // konte re-makes on its own — a deterministic intermediate, a stem (`via` is the one they consume).
  consumers: Array<{ address: string; via: string }>;
}

export interface KeepTakeInfo {
  outputHash: string | null;
  // Per upstream address, what this take reads current against once accepted: the output hash it
  // was made from, and what an accept kept it against (a hash, or a `via:` marker).
  inputs: Record<string, string[]>;
}

export interface KeepUnitInfo {
  stage: "reference" | "animatic" | "video";
  label: string;
}

// The timeline audio stem (soundtrack beds): the beds' one accept, and the one reviewable
// target in the video review whose feedback is not shot-scoped — a bed spans the timeline, so
// its comments hang off the stem address and carry a playhead time but no pin.
export interface TimelineStemInfo {
  address: string;
  variantId: string | null;
  // The stem's live definition hash, snapshotted with a soundtrack comment so a bed edit (a
  // retime, an added bed) ages it out even without a take switch. null when it has no definition.
  definitionHash: string | null;
  needsReview: boolean;
  feedback: FeedbackInfo[];
}

export interface FeedbackInfo {
  id: string;
  address: string;
  displayedVariants: Record<string, string>;
  annotation: { kind: "pin"; x: number; y: number } | null;
  text: string;
  time?: number;
  createdAt: string;
  createdBy: string;
  stale: boolean;
}

// The take a patched variant corrects. It is not a candidate of its own — a patched take is a
// "before", not an alternative — so this is the only handle the gallery has on it.
export interface VariantBeforeInfo {
  variantId: string;
  variantStatus: VariantStatus;
  imageUrl: string | null;
  fileUrl?: string | null;
}

// One take in a gallery — the card the reviewer picks among, on any stage.
export interface VariantInfo {
  variantId: string;
  variantStatus: VariantStatus;
  stale: boolean;
  // An undecided, non-stale variant standing beside an accepted one (a reroll or a patch output
  // with no verdict) — badged "New" so it's findable beside the accepted take.
  isNew: boolean;
  // The reviewer decided against this take (badged "not used"). Still listed at full weight,
  // sorted out of the live candidates.
  dismissed?: boolean;
  // Generated on its adapter's turbo inputs: coarser than a later take would be.
  turbo?: boolean;
  createdAt: string;
  imageUrl: string | null;
  fileUrl?: string | null;
  before?: VariantBeforeInfo | null;
  info?: AssetInfo;
}

// One rendered script line: the speaker's display label (a resolved character name or a mob label,
// null for narration) and the line's text. Shared by direction shots and animatic panels.
export interface ScriptLineView {
  speaker: string | null;
  text: string;
  // How the line is said — one line of direction, written once and read by everyone. Null when the
  // shot leaves it to the performer.
  acting: string | null;
}

// One asset in the flat reference pool. Reference has no shots/compositions — so a reference
// asset is just a named card with a variant gallery, feedback, and an accept toggle.
export interface ReferenceAssetInfo {
  assetName: string;
  address: string;
  variantId: string | null;
  variantStatus: VariantStatus;
  mediaKind: MediaKind;
  // Card preview: the variant's image (image kind), first thumbnail (video), or null (audio).
  imageUrl: string | null;
  // Playable media URL for video/audio variants.
  fileUrl?: string;
  variants: VariantInfo[];
  feedback: FeedbackInfo[];
  handoffNote?: string;
  // The direction parts this asset anchors, when it anchors any. Their prose describes the very
  // media on the card, so accepting the media signs them off too — printing them here is what makes
  // that a read rather than an assumption. Absent for a plain reference asset (a BGM bed, a texture)
  // that no part claims. More than one when a sample is cast twice (a narrator who is the
  // protagonist, twins): each cast slot brings its own brief for the same audio. A voice kind carries
  // the voice brief, not the character's visual one.
  directionRoster?: {
    kind: DirectionRosterKind;
    name: string;
    description: string;
    // The part's own acceptance standing. True when its prose is stale or was never signed off —
    // the accept decision is keyed on the variant, so a reword against an unchanged image would
    // otherwise leave the row reading "accepted" with nothing to press and no decision to send.
    needsReview: boolean;
  }[];
}

// What a reference asset anchors in the direction: a roster entry's look, a cast voice's sample, or
// the narrator's.
export type DirectionRosterKind =
  | "character"
  | "character-voice"
  | "narrator-voice"
  | "prop"
  | "location";

export interface ReferencePreviewState {
  mode: "reference-preview";
  assets: ReferenceAssetInfo[];
  size: { width: number; height: number };
  keep: KeepGraphInfo;
  handoffSummary?: string;
}

// One reviewable part of the direction — feedback attaches to a synthetic
// `direction:<part>` address (no variants, so `displayedVariants` is always empty).
export interface DirectionPartInfo {
  address: string;
  feedback: FeedbackInfo[];
  handoffNote?: string;
}

// A role's dramatic function in its lens — the vocabulary the direction map's colors and arc
// line derive from. Null when the shot's role is not one its lens declares (see core/lenses.ts).
export type BeatFunction = "ground" | "turn" | "build" | "payoff" | "settle";

// A shot's framing size — mirrors `Framing` in core/dsl/direction.ts. Shown as a chip in the shot
// table so the size cadence reads at a glance beside the durations.
export type Framing = "wide" | "medium" | "close" | "insert";

// The feeling a stretch of the piece aims for. The only controlled vocabulary the page prints in
// full, because it is the only one a reviewer can take a position on.
export interface DirectionPleasureInfo {
  name: string;
  gloss: string;
}

// No `role`: the shot's craft vocabulary (`method`, `peak`) stays server-side. `beatFunctionLabel`
// is what the reviewer sees — "rising", "payoff" — a claim they can dispute without the vocabulary.
// Both are null when the shot's role is not one its node's lens declares.
export interface DirectionShotInfo extends DirectionPartInfo {
  id: string;
  // An aside — a shot that occupies the clock without being a shot of the arc (a title card, an
  // eyecatch, an OP). It is reviewed like any other shot (is it there, is it that long) but every
  // column the arc reads is null on one, so the row prints as its label and its span alone.
  aside: boolean;
  // A shot of the arc with no camera — a UI screen, a motion graphic. It has a role, an action and
  // lines, and the frame columns (setup, framing, location, lineup, join) are null/empty on it.
  graphic: boolean;
  beatFunction: BeatFunction | null;
  beatFunctionLabel: string | null;
  // The shot's prose: a narrative shot's `action`, an aside's label.
  action: string;
  // The frame this shot is taken from — the declared setup's name, shown under the space chip so the
  // coverage (which shots share a frame) reads down the same column as the space. Null on an aside,
  // which is taken from no camera.
  setup: string | null;
  // The shot's framing size (wide/medium/close/insert) — the size cadence, shown as a chip. Read
  // through the setup, so null when the setup is not a declared one.
  framing: Framing | null;
  // The place this shot happens in — the declared location's name, shown as a chip so the space
  // continuity (which shots share a set) reads down the column. Read through the setup, so null when
  // the setup is not a declared one.
  location: string | null;
  // The shot's spoken/narrated lines — reviewed alongside the action. Empty when none.
  script: ScriptLineView[];
  // Who this frame holds, left to right, and the order the shot leaves behind, resolved to roster
  // NAMES. Both empty on a shot that declares none; `lineupTo` alone is empty when the frame does
  // not change inside the shot.
  lineup: string[];
  lineupTo: string[];
  // What the boundary into this shot is — `continuous` for one unbroken take across it, `jump-back`
  // into a flashback, `jump-forward` out of one or past a gap. Null is an ordinary cut. Drawn
  // between the rows, since it is about the boundary rather than the shot.
  join: "continuous" | "jump-back" | "jump-forward" | null;
  // The second camera frame laid over the shot (a wipe), read through its own setup like the shot's
  // frame, with who it holds as names and its own boundary. Null where the shot declares none.
  cutin: {
    setup: string;
    framing: Framing | null;
    location: string | null;
    lineup: string[];
    lineupTo: string[];
    join: "continuous" | "jump-back" | "jump-forward" | null;
  } | null;
  // The shot's unspoken on-screen text (titles, lower thirds, speaker-less captions). Bare strings:
  // telop has no speaker to attribute. Empty when none.
  telop: string[];
  duration: number;
}

// A node of the arc tree below the root: an act. A leaf act carries `shots`; a branch act carries
// child `sequences` (recursively), so the tree nests to any depth. Exactly one of the two is present.
export interface DirectionSequenceInfo extends DirectionPartInfo {
  id: string;
  // Null for a container role with no dramatic function, or a role its lens does not declare.
  beatFunction: BeatFunction | null;
  beatFunctionLabel: string | null;
  synopsis: string;
  pleasure: DirectionPleasureInfo;
  shots?: DirectionShotInfo[];
  sequences?: DirectionSequenceInfo[];
}

export interface DirectionCharacterInfo extends DirectionPartInfo {
  id: string;
  name: string;
  description: string;
  // The voice cast for them, when there is one — a part of its own, with its own address, feedback
  // and acceptance standing.
  voice?: DirectionVoiceInfo;
}

// A cast voice: the brief describing how someone sounds — a character's, or the narrator's. The
// `reference:<id>` sample it is judged against is deliberately absent: this page reviews the brief,
// and the sample has its own card in `konte preview reference`.
export interface DirectionVoiceInfo extends DirectionPartInfo {
  description: string;
}

// A recurring prop, reviewed in its own box below the characters. Same shape as a character — anchored to a
// reference asset and named in synopses — but it never speaks, so it carries no script.
export interface DirectionPropInfo extends DirectionPartInfo {
  id: string;
  name: string;
  description: string;
}

// A recurring location (a set/place), reviewed in its own box below the props. Same shape as a
// character/prop — anchored to a reference asset — but reached through a setup rather than named in
// the action prose, so it drives the shot table's space column.
export interface DirectionLocationInfo extends DirectionPartInfo {
  id: string;
  name: string;
  description: string;
  // What only this place has, in roster order — the things a setup's `holds` names and a plate's
  // sentence must say.
  landmarks: DirectionLandmarkInfo[];
}

// One landmark, shown under the location that declares it. It is no part of its own: what a place is
// made of is reviewed with the place, so it carries no address and no notes.
export interface DirectionLandmarkInfo {
  id: string;
  name: string;
  description: string;
}

// A camera setup, reviewed under the location it is set in. Unlike the three identity rosters it
// anchors to no reference asset — what realizes it is an animatic plate — so it carries the frame's
// place and size instead, which is what the shot table's two cadence columns are read through.
export interface DirectionSetupInfo extends DirectionPartInfo {
  id: string;
  name: string;
  description: string;
  // The roster key of the location this frame is set in — what the Locations box groups by. Not a
  // declared id when the checker's `setup-unknown-location` is live, so the grouping must not assume
  // a match.
  locationId: string;
  // The location's NAME (not its id) — the same word the space column shows. Falls back to the id
  // when the roster has no such entry.
  location: string;
  framing: Framing;
  // What this frame carries of its place, left to right on screen, resolved to landmark NAMES.
  // Empty on an `insert`.
  holds: string[];
  // The wider frame this one steps in from, resolved to that setup's NAME; `null` where the
  // author declared this frame a root (`within: null`). ABSENT is a frame that declares neither —
  // legal only where no wider frame could be its parent, and `within-undeclared` otherwise, so the
  // page must not read it back as a root the author never wrote.
  within?: string | null;
}

export type DirectionBriefField =
  | "logline"
  | "hook"
  | "audience"
  | "tone"
  | "look"
  | "outOfScope"
  | "tolerances";

export type DirectionBriefListField = "outOfScope" | "tolerances";

// One field of the agreed concept — prose, reviewed at the top of the page as its own feedback
// part. The two standing-verdict fields are list-valued, so `field` discriminates the two shapes. A
// prose field the author left out is absent rather than empty; a list field is always here, empty
// included, so a reviewer can ask for an entry the piece does not have yet.
export type DirectionBriefFieldInfo = DirectionPartInfo &
  (
    | { field: Exclude<DirectionBriefField, DirectionBriefListField>; text: string }
    | { field: DirectionBriefListField; items: string[] }
  );

export type DirectionPolicyField = "format" | "lang" | "fonts" | "speech";

// One machine-checked policy field — the canvas, the typesetting, the speech rule — reviewed as its
// own feedback part below the brief. Structured rather than pre-formatted so the UI owns the labels
// and glosses (as it does for the brief): `format` is the canvas, `lang` the BCP-47 language tag the
// compositions render under, `fonts` the families they are set in, `speech` the declared speech rule.
export type DirectionPolicyFieldInfo = DirectionPartInfo &
  (
    | {
        field: "format";
        aspects: string[];
        fps: number;
        // The DERIVED working canvas. The author states `megapixels` and `delivery`; showing what
        // those resolved to is the only place the number every stage generates at is visible.
        base: { width: number; height: number };
        megapixels: number;
        delivery: { width: number; height: number };
      }
    | { field: "lang"; lang: string }
    | { field: "fonts"; fonts: string[] }
    | { field: "speech"; speech: "none" | "no-dialogue" | "free" }
  );

// A finding a `waivers` entry has cleared: what was flagged, plus the reason it was signed off.
// Reviewable in its own right — the human may disagree with the waiver, so it takes feedback.
//
// Only *waived* findings cross the wire. An unwaived one blocks generation until the author clears
// it, so it is the author's problem, not the reviewer's: showing it would ask a person to arbitrate
// a rule they cannot read about a state that cannot survive.
export interface DirectionWaiverInfo extends DirectionPartInfo {
  code: string;
  subject: string | null;
  message: string;
  reason: string;
}

// The page's boxes — the unit a reviewer accepts in — in the order the page reads them. State is
// finer (one entry per part, so a logline rewrite ages out the logline alone), but a person reads a
// box and takes a position on it, so the Accept sits there and fans out to the parts underneath.
// Mirrors `DIRECTION_SECTIONS` in core/address.ts, which is what the server keys its state by.
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

// A box's standing: `accepted` when every part in it is signed off at its current content, `stale`
// when something in it was rewritten since, `unaccepted` when it was never read. A box with nothing
// in it (an empty roster, no waivers) reads as accepted and is not rendered.
export type DirectionSectionStatus = "accepted" | "stale" | "unaccepted";

// A media-less review of the direction: what the piece aims for, every shot (and long-form
// act), the characters, the rules the author waived, and how much of it a human has signed off
// (`sections`). One Accept per box, plus per-part feedback.
export interface DirectionPreviewState {
  mode: "direction-preview";
  pleasure: DirectionPleasureInfo;
  directionHash: string;
  // Every section, including the ones this direction has no content for — the page renders a box only
  // when it has rows, so an entry with no box is simply never read.
  sections: Record<DirectionSection, DirectionSectionStatus>;
  // The sections whose sign-off the spend gate is still waiting on. Every section until the piece has
  // been accepted whole once; after that only the ones no downstream review re-reads. A box outside
  // this set still reads and still accepts — it no longer stops a generation.
  gatingSections: DirectionSection[];
  // One entry per prose field the author filled in, plus both list fields — always, empty included.
  brief: DirectionBriefFieldInfo[];
  // The always-declared policy fields (format, lang, speech), each reviewed on its own.
  policy: DirectionPolicyFieldInfo[];
  sequence: DirectionPartInfo;
  characters: DirectionCharacterInfo[];
  // Absent when the direction casts none. Reviewed inside the Characters box.
  narrator?: DirectionVoiceInfo;
  props: DirectionPropInfo[];
  locations: DirectionLocationInfo[];
  setups: DirectionSetupInfo[];
  waivers: DirectionWaiverInfo[];
  handoffSummary?: string;
  kind: "flat" | "sequenced";
  shots?: DirectionShotInfo[];
  sequences?: DirectionSequenceInfo[];
}

export type PreviewState = VideoPreviewState | ReferencePreviewState | DirectionPreviewState;
