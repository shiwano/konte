// Each direction finding code's standing, one entry per code: its traits, the class a pass must read
// to evaluate it, where a waiver of it plays, the stage its fix is written in, its remedy, and the
// waiver key that cancels it.

import {
  DIRECTION_NARRATOR_ADDRESS,
  formatDirectionCharacterAddress,
  formatDirectionCharacterVoiceAddress,
  formatDirectionLocationAddress,
  formatDirectionPolicyAddress,
  formatDirectionPropAddress,
  formatDirectionSetupAddress,
  formatDirectionWaiverAddress,
} from "./address.js";
import { ATOMIZED_LOCATION_SHOTS, type DirectionFinding } from "./direction-check.js";
import { type FindingTraits, ROSTER, fixDirection, judged, waive } from "./finding-traits.js";
import { type Accepted, signedOffBy, withAwaitingAccept } from "./sign-off.js";

// A finding's class: what a pass must have read to evaluate it, so its waivers may be called stale.
export type DirectionFindingClass =
  | "arc"
  | "pacing"
  | "characters"
  | "props"
  | "locations"
  | "setups"
  | "staging"
  | "typesetting"
  | "song";

type DirectionFindingSpec<Clears extends "fix" | "waive", SignsOff extends boolean> = {
  traits: FindingTraits & { clears: Clears; signsOff: SignsOff };
  class: DirectionFindingClass;
  // Where what a waiver of it lets through plays, read off its subject: inside one shot (the shot,
  // one of its frames, or a subject in one), across the boundary `<from>.<to>` between two, in every
  // shot with a frame on the setup it names, or in no one shot (null).
  waiverScope: "shot" | "boundary" | "setup" | null;
  // The stage entry file its fix is written in. A declared entity — a look or a cast voice — with no
  // reference asset is answered in `reference.tsx`; a setup the board realizes wrongly is answered by
  // its plates and keyframes in `animatic.tsx`, and a take or composition by `video.tsx`. The
  // direction entry naming any of them is edited only to waive one.
  fixStage: "direction" | "reference" | "animatic" | "video";
  // What clears every finding of the code, printed once over its findings.
  remedy: string;
  // Its subject is a role of the node's own lens, or none: two sequences on one lens both fire
  // `missing-role_disruption`, so below the root the subject is qualified with the node's id
  // (`missing-role_theft.disruption`, `no-payoff_theft`).
  nodeScoped?: true;
  // A roster entry no shot uses: before any shot is written it is only not reached yet.
  awaitsShots?: true;
  // The direction part a finding to fix sits on, from its subject; absent, the shot, frame of one
  // (`<id>.cutin`) or child node its subject opens with.
  part?: (subject: string) => string;
};

const spec = <Clears extends "fix" | "waive", SignsOff extends boolean>(
  s: DirectionFindingSpec<Clears, SignsOff>,
) => s;

// Fixed contract, like KonteErrorCode: doctor / waiver keys / scripts branch on these codes. The
// same codes are reused at both scales — the subject (role / id / range) distinguishes instances.
// Listed in the order FINDINGS.md lists them.
const DIRECTION_FINDINGS = {
  "missing-role": spec({
    traits: waive("stage+downstream"),
    class: "arc",
    waiverScope: null,
    fixStage: "direction",
    nodeScoped: true,
    remedy:
      "give the role to an item of the arc, or waive it by its key where the arc goes without it",
  }),
  "no-payoff": spec({
    traits: waive("stage+downstream"),
    class: "arc",
    waiverScope: null,
    fixStage: "direction",
    nodeScoped: true,
    remedy:
      "mark an item of the arc with the lens's payoff role, or waive it by its key where the arc " +
      "has no payoff",
  }),
  "role-out-of-order": spec({
    traits: waive("stage+downstream"),
    class: "arc",
    waiverScope: null,
    fixStage: "direction",
    nodeScoped: true,
    remedy:
      "reorder the arc's items to the lens's role order, or waive it by its key where the order " +
      "is meant",
  }),
  "lens-role-mismatch": spec({
    traits: fixDirection,
    class: "arc",
    waiverScope: null,
    fixStage: "direction",
    remedy: "give the item a role its lens declares, or change the lens",
  }),
  "too-few-consecutive": spec({
    traits: waive("stage+downstream"),
    class: "arc",
    waiverScope: null,
    fixStage: "direction",
    nodeScoped: true,
    remedy:
      "extend the role's longest run of consecutive items to the lens's minimum, or waive it by its " +
      "key where the role lands once",
  }),
  "empty-synopsis": spec({
    traits: fixDirection,
    class: "arc",
    waiverScope: null,
    fixStage: "direction",
    remedy: "write the item's action or synopsis",
  }),
  "unearned-payoff": spec({
    traits: waive("stage+downstream"),
    class: "arc",
    waiverScope: null,
    fixStage: "direction",
    nodeScoped: true,
    remedy:
      "place an item that grounds, turns or builds before the payoff, or waive it by its key where " +
      "the arc is meant to open on its payoff",
  }),
  "role-overweight": spec({
    traits: waive("stage+downstream"),
    class: "pacing",
    waiverScope: null,
    fixStage: "direction",
    nodeScoped: true,
    remedy:
      "shorten the role's items or lengthen the others' to bring its share within the lens's " +
      "budget, or waive it by its key",
  }),
  "role-underweight": spec({
    traits: waive("stage+downstream"),
    class: "pacing",
    waiverScope: null,
    fixStage: "direction",
    nodeScoped: true,
    remedy:
      "lengthen the role's items or shorten the others' to bring its share up to the lens's " +
      "minimum, or waive it by its key",
  }),
  "character-unreferenced": spec({
    traits: waive("downstream", ROSTER),
    class: "characters",
    waiverScope: null,
    fixStage: "reference",
    remedy:
      "expose `reference:<id>` in reference.tsx, or waive it by its key where the character is " +
      "drawn from no reference",
  }),
  "unused-character": spec({
    traits: fixDirection,
    class: "characters",
    waiverScope: null,
    fixStage: "direction",
    awaitsShots: true,
    part: formatDirectionCharacterAddress,
    remedy:
      "put the character in a frame's `lineup`, `lineupTo` or `passing`, or give them a script or " +
      "lyric line, or remove them from `characters`",
  }),
  // The voice checks are cast drift like their look siblings, so they ride the same class: deferred
  // until the direction is accepted (they point at reference wiring, not at the shots under review),
  // then gating every spend — which is what puts them in front of a TTS bill.
  "character-voice-missing": spec({
    traits: waive("stage+downstream", ROSTER),
    class: "characters",
    waiverScope: null,
    fixStage: "direction",
    remedy:
      "declare `voice` on the character's roster entry, or waive it by its key where the lines are " +
      "not spoken aloud",
  }),
  "character-voice-unreferenced": spec({
    traits: waive("downstream", ROSTER),
    class: "characters",
    waiverScope: null,
    fixStage: "reference",
    remedy:
      "expose the voice named as a `reference:<voiceId>` in reference.tsx, or waive it by its key",
  }),
  "unused-character-voice": spec({
    traits: fixDirection,
    class: "characters",
    waiverScope: null,
    fixStage: "direction",
    awaitsShots: true,
    part: formatDirectionCharacterVoiceAddress,
    remedy: "give the character a script line, or drop their `voice`",
  }),
  "narrator-missing": spec({
    traits: waive("stage+downstream", ROSTER),
    class: "characters",
    waiverScope: null,
    fixStage: "direction",
    remedy: "declare `narrator`, or waive it by its key where the narration is not read aloud",
  }),
  "narrator-unreferenced": spec({
    traits: waive("downstream", ROSTER),
    class: "characters",
    waiverScope: null,
    fixStage: "reference",
    remedy:
      "expose the voice named as a `reference:<voiceId>` in reference.tsx, or waive it by its key",
  }),
  "unused-narrator": spec({
    traits: fixDirection,
    class: "characters",
    waiverScope: null,
    fixStage: "direction",
    awaitsShots: true,
    part: () => DIRECTION_NARRATOR_ADDRESS,
    remedy: "give a shot a narration line, or drop `narrator`",
  }),
  "prop-unreferenced": spec({
    traits: waive("downstream", ROSTER),
    class: "props",
    waiverScope: null,
    fixStage: "reference",
    remedy:
      "expose `reference:<id>` in reference.tsx, or waive it by its key where the prop is drawn " +
      "from no reference",
  }),
  "unused-prop": spec({
    traits: fixDirection,
    class: "props",
    waiverScope: null,
    fixStage: "direction",
    awaitsShots: true,
    part: formatDirectionPropAddress,
    remedy: "put the prop in the `props` of the frames that show it, or remove it from `props`",
  }),
  "location-unreferenced": spec({
    traits: waive("downstream", ROSTER),
    class: "locations",
    waiverScope: null,
    fixStage: "reference",
    remedy:
      "expose `reference:<id>` in reference.tsx, or waive it by its key where the place is drawn " +
      "from no reference",
  }),
  "unused-location": spec({
    traits: fixDirection,
    class: "locations",
    waiverScope: null,
    fixStage: "direction",
    awaitsShots: true,
    part: formatDirectionLocationAddress,
    remedy: "set a setup in the location, or remove it from `locations`",
  }),
  "setup-unrealized": spec({
    traits: judged(waive("stage+downstream", ROSTER)),
    class: "setups",
    waiverScope: null,
    fixStage: "animatic",
    remedy:
      "declare the setup in `plates` in animatic.tsx for its shots to build their frame on, or " +
      "waive it by its key where its shots are not to share one frame",
  }),
  "plate-unanchored": spec({
    traits: waive("stage+downstream", ROSTER),
    class: "setups",
    waiverScope: null,
    fixStage: "animatic",
    remedy:
      "take the place reference named as an input image of the plate, or waive it by its key where " +
      "the plate invents its frame",
  }),
  // A window's plate cut outside the plate of the frame it declares itself a window of.
  "plate-unnested": spec({
    traits: waive("stage+downstream", ROSTER),
    class: "setups",
    waiverScope: null,
    fixStage: "animatic",
    remedy:
      "pass the wider plate's image named as is to a model that reads a previous frame (`cut` in " +
      "`konte adapter show`) and write the step in as a cut from it, or crop inside that plate's " +
      "window with `adapters.imageCrop`; waive it by its key where the frame does not nest in the " +
      "wider one",
  }),
  // The axis read as a shared frame: a cut along one, with no plate holding its two ends to one
  // master.
  "axis-unrealized": spec({
    traits: judged(waive("stage+downstream", ROSTER)),
    class: "setups",
    waiverScope: null,
    fixStage: "animatic",
    remedy:
      "the two setups are cut between along one camera axis: declare each setup named in `plates` " +
      "in animatic.tsx, or waive the pair by its key to cut it as two separate frames",
  }),
  // A plate neither `plate-unnested` nor `axis-unrealized` asks for.
  "plate-unowed": spec({
    traits: waive("stage+downstream", ROSTER),
    class: "setups",
    waiverScope: null,
    fixStage: "animatic",
    remedy:
      "a plate holds two or more generated shots to one frame, or nests a frame cut along a " +
      "`within` axis: drop it from `plates` in animatic.tsx and build the setup's keyframe from the " +
      "place reference named; where another plate is built from it, keep it as an intermediate " +
      "under a name that is no setup id; or waive it by its key to keep it as the setup's plate",
  }),
  "setup-unconsumed": spec({
    traits: judged(waive("stage+downstream", ROSTER)),
    class: "setups",
    waiverScope: "setup",
    fixStage: "animatic",
    remedy:
      "take the anchor named — the setup's plate, else its place reference — as an input image of " +
      "the shot's keyframe, or waive it by its key where the shot is not to stand on it",
  }),
  "unused-setup": spec({
    traits: fixDirection,
    class: "setups",
    waiverScope: null,
    fixStage: "direction",
    awaitsShots: true,
    part: formatDirectionSetupAddress,
    remedy: "point a shot's `setup` at it, or remove it from `setups`",
  }),
  "setup-atomized": spec({
    traits: judged(waive("stage+downstream", ROSTER)),
    class: "setups",
    waiverScope: null,
    fixStage: "direction",
    remedy:
      `a location holding ${ATOMIZED_LOCATION_SHOTS} or more shots needs at least half of them on ` +
      "a frame another shot stands on too: put a second shot on a frame the piece returns to, or " +
      "waive it by its key where the place is covered in one-off frames",
  }),
  // The views: a way a setup faces with no image of it, a plate standing on another view's image,
  // a view image drawn from nothing of its location, and an image of a view whose prompt does not
  // ask for a landmark a setup facing that way holds.
  "view-unrealized": spec({
    traits: waive("downstream", ROSTER),
    class: "locations",
    waiverScope: null,
    fixStage: "reference",
    remedy:
      "return `<locationId>: { <view>: asset(…) }` from `views` in reference.tsx, made from " +
      "`reference.<locationId>`; drop the view from the location's `views` where no setup faces " +
      "it; or waive it by its key where the setups facing it stand on the location's master",
  }),
  "plate-unviewed": spec({
    traits: waive("stage+downstream", ROSTER),
    class: "setups",
    waiverScope: null,
    fixStage: "animatic",
    remedy:
      "build the plate, or a plate-less setup's keyframe, from the image of the view the setup " +
      "faces (named) — a plate may instead be cut in from a plate that is — or waive it by its key " +
      "where the frame stands on the other view",
  }),
  "view-unanchored": spec({
    traits: waive("stage+downstream"),
    class: "setups",
    waiverScope: null,
    fixStage: "reference",
    remedy:
      "take the location's master named as an input image of the view image, or waive it by its " +
      "key where the view is not drawn from the master",
  }),
  "view-unnamed": spec({
    traits: judged(waive("stage+downstream", ROSTER)),
    class: "setups",
    waiverScope: null,
    fixStage: "reference",
    remedy:
      "ask for the landmark by that noun in the image's prompt, drawing the image from that view " +
      "— `front` is the way the master faces — or take it out of the view's `holds` where it does " +
      "not see it; to call it by other words, change " +
      "`locations.<locationId>.landmarks.<landmarkId>.promptDepiction`; or waive it by its key",
  }),
  // A fused-shot content check on the action prose (like empty-synopsis): it gates generate and is
  // never deferred.
  "multi-sentence-action": spec({
    traits: waive("stage+downstream"),
    class: "arc",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      "land one action per shot: split the shot into two, or waive it by its key where the action " +
      "is meant as more than one sentence",
  }),
  "off-grid-duration": spec({
    traits: fixDirection,
    class: "pacing",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      "give the shot a positive span: in seconds a multiple of its grid, on the song a positive " +
      "number of `beats`",
  }),
  "off-beat-cut": spec({
    traits: waive("stage+downstream"),
    class: "pacing",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      "round the shot's `beats` to a whole number, or waive it by its key where the off-beat cut is " +
      "meant",
  }),
  "fonts-undeclared": spec({
    traits: waive("stage+downstream"),
    class: "typesetting",
    waiverScope: null,
    fixStage: "direction",
    remedy:
      'declare a family in `policy.fonts` that carries the script (e.g. "Noto Sans JP"), or waive ' +
      "it by its key where the piece typesets no text",
  }),
  // The staging class: who the frame holds, left to right, declared per shot and accumulated per
  // place. Four settle a RELATION between two subjects across two shots; the two the board feeds
  // settle the declared frame against what the keyframe was conditioned on — who it took
  // (`character-unconsumed`) and in what order (`slot-order-mismatch`). The last settles the frame
  // itself: a keyframe that crops the plate it stands on.
  "lineup-flipped": spec({
    traits: waive("stage+downstream"),
    class: "staging",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      "no shot between the two declares the change: write the move as the `lineupTo` of the shot " +
      'it happens in, or `join: "jump-back" | "jump-forward"` where story time has moved; waive it ' +
      "by its key where the camera crosses the line",
  }),
  "lineup-gap": spec({
    traits: waive("stage+downstream"),
    class: "staging",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      "the frame does not hold who stands between its outer subjects: add them to the `lineup`, " +
      "or, where they walked out of frame, say so in the `lineupTo` of the shot they leave in; " +
      "waive it by its key where the frame leaves them out",
  }),
  "lineup-vacuous": spec({
    traits: fixDirection,
    class: "staging",
    waiverScope: "shot",
    fixStage: "direction",
    remedy: "drop the `lineupTo`, or write the order the shot actually leaves behind",
  }),
  "lineup-inconsistent": spec({
    traits: waive("stage+downstream"),
    class: "staging",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      "the place's order cannot be laid out on a line: correct the `lineup` or `lineupTo` that " +
      "has the seating wrong, or waive it by its key",
  }),
  // A character's route: a frame back in a place they left, with no jump between.
  "location-backtrack": spec({
    traits: waive("stage+downstream"),
    class: "staging",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      'no `join: "jump-back" | "jump-forward"` since moves story time: stage the detour in the ' +
      "place they are in, or declare the jump where story time moves; waive it by its key where the " +
      "return needs no jump",
  }),
  "character-unconsumed": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "animatic",
    remedy:
      "take `reference.<characterId>` as an input image of the keyframe holding them, or waive it " +
      "by its key where they are drawn from no reference",
  }),
  "slot-order-mismatch": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "animatic",
    remedy:
      "pass the keyframe's reference images in the frame's declared left-to-right order; a take " +
      "that came back with the wrong person on the wrong side is a slot fix, not a waiver",
  }),
  "plate-recropped": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      "declare a setup for that frame, holding what it shows, and move the shot onto it; one shot " +
      "alone needs no plate, and stands on a crop of the place reference named. Waive it by its key " +
      "where the frame is meant as a crop of the plate",
  }),
  // `landmark-flipped` is the `lineup-flipped` of things that do not move, read across the setups
  // of one place. Each `-unnamed` asks whether the text calls a thing by the name the direction
  // declared: a frame's subjects and props in its keyframes' prompts, a passer in the take's, and a
  // landmark the frame holds in the prompt that first draws the frame — its plate's, or its
  // keyframes' where the setup has none.
  "landmark-flipped": spec({
    traits: waive("stage+downstream"),
    class: "staging",
    waiverScope: null,
    fixStage: "direction",
    remedy:
      "a landmark does not move: correct the `holds` order of the wrong setup, or waive it by its " +
      "key where the camera crosses the set's line",
  }),
  "subject-unnamed": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "animatic",
    remedy:
      "name every subject the frame holds by its promptDepiction (verbatim, case-insensitive) in a " +
      "prompt behind the keyframe; to call them by other words, change " +
      "`characters.<id>.promptDepiction`; or waive it by its key",
  }),
  "prop-unnamed": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "animatic",
    remedy:
      "call the prop by its promptDepiction (verbatim, case-insensitive) in a prompt behind the " +
      "frame's keyframes, or drop it from the frame's `props`; to call it by other words, change " +
      "`props.<id>.promptDepiction`; or waive it by its key",
  }),
  "passer-unconsumed": spec({
    traits: judged(waive("stage")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "video",
    remedy: "pass the passer's character reference to the take, or waive it by its key",
  }),
  "passer-unnamed": spec({
    traits: judged(waive("stage")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "video",
    remedy:
      "name the passer by its promptDepiction (verbatim, case-insensitive) in the take's positive " +
      "prompts, or waive it by its key",
  }),
  "plate-unnamed": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: null,
    fixStage: "animatic",
    remedy:
      "ask for the landmark by that noun in the plate's prompt, or take it out of `holds` where " +
      "the frame does not carry it; to call it by other words, change " +
      "`locations.<locationId>.landmarks.<landmarkId>.promptDepiction`; or waive it by its key",
  }),
  "landmark-unnamed": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "animatic",
    remedy:
      "the frame's setup has no plate, so its keyframe draws the set: ask for the landmark by that " +
      "noun (verbatim, case-insensitive); to call it by other words, change " +
      "`locations.<locationId>.landmarks.<landmarkId>.promptDepiction`; or waive it by its key",
  }),
  // The seam a `continuous` join declares: one take across a shot boundary, so the frame at the end
  // of the one and the start of the next is a single frame — the opening keyframe of the shot that
  // owns the boundary. The two shots must agree on who it holds, and the take before must land on
  // it.
  "join-lineup-mismatch": spec({
    traits: fixDirection,
    class: "staging",
    waiverScope: "shot",
    fixStage: "direction",
    remedy:
      "make the two frames agree, or declare the boundary a cut in its `join` (`cutin.join` for a " +
      "cutin)",
  }),
  "join-unpinned": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "video",
    remedy:
      "pin the end of the take before the seam to the seam frame named in video.tsx, or waive it by " +
      "its key where the boundary may jump",
  }),
  // The seam frame is pinned, and the composition's window over the take leaves it out.
  "join-unshown": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "video",
    remedy:
      "play the take so the cut shows the seam frame: the take before ends the shot on its landing, " +
      "the take after opens the shot on its first frame. Where the moment inside the take is what " +
      "is off, regenerate the take or change the shot's duration in direction.ts — the seam is not " +
      "the place to move it. Waive it by its key where the human judges the jump worth it",
  }),
  // A frame's key pinned as the first frame of a take whose model could have taken it as a reference.
  "opening-key": spec({
    traits: judged(waive("stage", "always", "take")),
    class: "staging",
    waiverScope: "shot",
    fixStage: "video",
    remedy:
      "the take moves past the moment its key holds: pass the key to a reference input alone, or " +
      "waive it by its key where the take is meant to open on it",
  }),
  // A cut along one camera axis: the camera does not move, so the frame does not restart.
  "panel-unlinked": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "boundary",
    fixStage: "animatic",
    remedy:
      "the shot cuts from the shot before (`<from>-<id>`) along one camera axis, so the frame " +
      "carries across. Pass the panel named to one of the opening keyframe's image inputs and name " +
      "it `[Shot 1]` in the prompt. Where story time moves between the two, declare " +
      '`join: "jump-back" | "jump-forward"`; waive the seam by its key only where time runs on and ' +
      "nothing of the frame before is meant to carry",
  }),
  // A cut back to a setup across a cutaway.
  "return-unlinked": spec({
    traits: judged(waive("stage+downstream")),
    class: "staging",
    waiverScope: "boundary",
    fixStage: "animatic",
    remedy:
      "the shot returns across a cutaway to the setup of an earlier shot (`<from>-<id>`), so it " +
      "opens where that shot left the subject. Pass the panel named to one of the opening " +
      "keyframe's image inputs and name it `[Shot 1]` in the prompt, writing in the prompt what " +
      "changed while the camera was away; declare `jump-forward` or waive the return by its key " +
      "where nothing carries across",
  }),
  // The song's, never deferred: the song the piece is cut to is not a reference asset, and a lyric
  // line no reading of the take places.
  "song-unreferenced": spec({
    traits: { ...fixDirection, holds: { spend: { reach: "downstream" }, accept: true } },
    class: "song",
    waiverScope: null,
    fixStage: "reference",
    part: () => formatDirectionPolicyAddress("song"),
    remedy: "declare the song as `reference:<song>` in reference.tsx",
  }),
  "lyric-unplaced": spec({
    traits: waive("stage+downstream", "always", "take"),
    class: "song",
    waiverScope: null,
    fixStage: "direction",
    remedy:
      "a person places the line on the song's review page (`konte preview reference`), or run " +
      "`konte song set <variantId> --line <key> --start <sec> --end <sec>`; waive it by its key " +
      "where the line is not sung",
  }),
  // The timeline runs on past the end of the take of the song.
  "song-overrun": spec({
    traits: waive("stage+downstream", "always", "take"),
    class: "song",
    waiverScope: null,
    fixStage: "direction",
    remedy:
      "shorten the cut, or accept a longer take of the song; waive it by its key where the timeline " +
      "outruns the song",
  }),
};

type DirectionFindings = typeof DIRECTION_FINDINGS;

export type DirectionFindingCode = keyof DirectionFindings;

// A code a waiver can cancel: one whose rule a work may rightly break.
export type WaivableCode = {
  [K in DirectionFindingCode]: DirectionFindings[K]["traits"]["clears"] extends "waive" ? K : never;
}[DirectionFindingCode];

// A code an accept of the addresses it is judged by signs off.
export type DirectionJudgedCode = {
  [K in DirectionFindingCode]: DirectionFindings[K]["traits"]["signsOff"] extends true ? K : never;
}[DirectionFindingCode];

export const DIRECTION_FINDING_CODES = Object.keys(DIRECTION_FINDINGS) as DirectionFindingCode[];

export function directionFindingSpec(
  code: DirectionFindingCode,
): DirectionFindingSpec<"fix" | "waive", boolean> {
  return DIRECTION_FINDINGS[code];
}

export function isDirectionFindingCode(code: string): code is DirectionFindingCode {
  return Object.hasOwn(DIRECTION_FINDINGS, code);
}

// A waiver naming any other code cancels nothing, and is stale.
export function isWaivableCode(code: string): code is WaivableCode {
  return isDirectionFindingCode(code) && DIRECTION_FINDINGS[code].traits.clears === "waive";
}

// The findings a surface reports or gates on: a finding whose onset is the direction's acceptance
// (the roster wiring) waits for it. Waiver reconciliation is untouched: a waived roster finding still
// counts as waived, never as stale.
export function reportableDirectionFindings<F extends { code: DirectionFindingCode }>(
  active: F[],
  directionAccepted: boolean,
): F[] {
  if (directionAccepted) return active;
  return active.filter(
    (f) => DIRECTION_FINDINGS[f.code].traits.onset !== "after-direction-accepted",
  );
}
// The waiver key that cancels a finding: `<code>` for subject-less findings (no-payoff) or
// `<code>_<subject>` for an instance (missing-role_disruption, lens-role-mismatch_08). No finding
// code contains an underscore (they are all hyphenated), so the first one splits the key back apart
// however the subject (role / shot id / id-range / stage) is spelled — and the key stays a single
// segment of its review address (`waivers.<key>`), where a `:` would need escaping and a
// `-` would be indistinguishable from the hyphens inside a code.
const WAIVER_KEY_SEPARATOR = "_";

export function directionWaiverKey(finding: Pick<DirectionFinding, "code" | "subject">): string {
  return finding.subject
    ? `${finding.code}${WAIVER_KEY_SEPARATOR}${finding.subject}`
    : finding.code;
}

export function splitWaiverKey(key: string): { code: string; subject?: string } {
  const sep = key.indexOf(WAIVER_KEY_SEPARATOR);
  return sep === -1 ? { code: key } : { code: key.slice(0, sep), subject: key.slice(sep + 1) };
}

// The findings the direction's waivers and accepts leave active. One signed off by the accept of
// every address it is judged by holds nothing and keeps its waiver in use; one a waiver names is
// waived; `matched` is every waiver key in use, and `covers` what each waiver lets through, by its
// review address.
export function foldWaivers(
  findings: readonly DirectionFinding[],
  waivers: Readonly<Record<string, string>>,
  accepted: Accepted | undefined,
): {
  active: DirectionFinding[];
  waived: DirectionFinding[];
  matched: Set<string>;
  covers: Map<string, readonly string[]>;
} {
  const active: DirectionFinding[] = [];
  const waived: DirectionFinding[] = [];
  const matched = new Set<string>();
  const covers = new Map<string, readonly string[]>();
  for (const finding of findings) {
    const key = directionWaiverKey(finding);
    const waivable = key in waivers && isWaivableCode(finding.code);
    if (finding.covers && waivable) {
      const address = formatDirectionWaiverAddress(key);
      covers.set(address, [...new Set([...(covers.get(address) ?? []), ...finding.covers])]);
    }
    if (signedOffBy(finding.judgedBy, accepted)) {
      if (key in waivers) matched.add(key);
    } else if (waivable) {
      matched.add(key);
      waived.push(finding);
    } else {
      active.push({
        ...finding,
        message: withAwaitingAccept(finding.message, finding.judgedBy, accepted),
      });
    }
  }
  return { active, waived, matched, covers };
}
