import { ATOMIZED_LOCATION_SHOTS, type DirectionFindingCode } from "../direction-check.js";

export const DIRECTION_FINDING_REMEDY: Record<DirectionFindingCode, string> = {
  "missing-role":
    "give the role to an item of the arc, or waive it by its key where the arc goes without it",
  "no-payoff":
    "mark an item of the arc with the lens's payoff role, or waive it by its key where the arc " +
    "has no payoff",
  "role-out-of-order":
    "reorder the arc's items to the lens's role order, or waive it by its key where the order " +
    "is meant",
  "lens-role-mismatch": "give the item a role its lens declares, or change the lens",
  "too-few-consecutive":
    "extend the role's longest run of consecutive items to the lens's minimum, or waive it by its " +
    "key where the role lands once",
  "empty-synopsis": "write the item's action or synopsis",
  "unearned-payoff":
    "place an item that grounds, turns or builds before the payoff, or waive it by its key where " +
    "the arc is meant to open on its payoff",
  "role-overweight":
    "shorten the role's items or lengthen the others' to bring its share within the lens's " +
    "budget, or waive it by its key",
  "role-underweight":
    "lengthen the role's items or shorten the others' to bring its share up to the lens's " +
    "minimum, or waive it by its key",
  "character-unreferenced":
    "expose `reference:<id>` in reference.tsx, or waive it by its key where the character is " +
    "drawn from no reference",
  "unused-character":
    "put the character in a frame's `lineup`, `lineupTo` or `passing`, or give them a script or " +
    "lyric line, or remove them from `characters`",
  "character-voice-missing":
    "declare `voice` on the character's roster entry, or waive it by its key where the lines are " +
    "not spoken aloud",
  "character-voice-unreferenced":
    "expose the voice named as a `reference:<voiceId>` in reference.tsx, or waive it by its key",
  "unused-character-voice": "give the character a script line, or drop their `voice`",
  "narrator-missing":
    "declare `narrator`, or waive it by its key where the narration is not read aloud",
  "narrator-unreferenced":
    "expose the voice named as a `reference:<voiceId>` in reference.tsx, or waive it by its key",
  "unused-narrator": "give a shot a narration line, or drop `narrator`",
  "prop-unreferenced":
    "expose `reference:<id>` in reference.tsx, or waive it by its key where the prop is drawn " +
    "from no reference",
  "unused-prop":
    "put the prop in the `props` of the frames that show it, or remove it from `props`",
  "location-unreferenced":
    "expose `reference:<id>` in reference.tsx, or waive it by its key where the place is drawn " +
    "from no reference",
  "unused-location": "set a setup in the location, or remove it from `locations`",
  "setup-unrealized":
    "declare the setup in `plates` in animatic.tsx for its shots to build their frame on, or " +
    "waive it by its key where its shots are not to share one frame",
  "plate-unanchored":
    "take the place reference named as an input image of the plate, or waive it by its key where " +
    "the plate invents its frame",
  "setup-unconsumed":
    "take the anchor named — the setup's plate, else its place reference — as an input image of " +
    "the shot's keyframe, or waive it by its key where the shot is not to stand on it",
  "plate-unnested":
    "pass the wider plate's image named as is to a model that reads a previous frame (`cut` in " +
    "`konte adapter show`) and write the step in as a cut from it, or crop inside that plate's " +
    "window with `adapters.imageCrop`; waive it by its key where the frame does not nest in the " +
    "wider one",
  "axis-unrealized":
    "the two setups are cut between along one camera axis: declare each setup named in `plates` " +
    "in animatic.tsx, or waive the pair by its key to cut it as two separate frames",
  "plate-unowed":
    "a plate holds two or more generated shots to one frame, or nests a frame cut along a " +
    "`within` axis: drop it from `plates` in animatic.tsx and build the setup's keyframe from the " +
    "place reference named; where another plate is built from it, keep it as an intermediate " +
    "under a name that is no setup id; or waive it by its key to keep it as the setup's plate",
  "unused-setup": "point a shot's `setup` at it, or remove it from `setups`",
  "setup-atomized":
    `a location holding ${ATOMIZED_LOCATION_SHOTS} or more shots needs at least half of them on ` +
    "a frame another shot stands on too: put a second shot on a frame the piece returns to, or " +
    "waive it by its key where the place is covered in one-off frames",
  "view-unrealized":
    "return `<locationId>: { <view>: asset(…) }` from `views` in reference.tsx, made from " +
    "`reference.<locationId>`, or waive it by its key where the setup stands on the location's " +
    "master",
  "plate-unviewed":
    "build the plate, or a plate-less setup's keyframe, from the image of the view the setup " +
    "faces (named) — a plate may instead be cut in from a plate that is — or waive it by its key " +
    "where the frame stands on the other view",
  "view-unanchored":
    "take the location's master named as an input image of the view image, or waive it by its " +
    "key where the view is not drawn from the master",
  "view-unnamed":
    "ask for the landmark by that noun in the image's prompt, drawing the image from the way " +
    "those setups face — `front` is the way the master faces — or take it out of their `holds` " +
    "where the frame does not carry it; to call it by other words, change " +
    "`locations.<locationId>.landmarks.<landmarkId>.promptDepiction`; or waive it by its key",
  "multi-sentence-action":
    "land one action per shot: split the shot into two, or waive it by its key where the action " +
    "is meant as more than one sentence",
  "off-grid-duration":
    "give the shot a positive span: in seconds a multiple of its grid, on the song a positive " +
    "number of `beats`",
  "off-beat-cut":
    "round the shot's `beats` to a whole number, or waive it by its key where the off-beat cut is " +
    "meant",
  "fonts-undeclared":
    'declare a family in `policy.fonts` that carries the script (e.g. "Noto Sans JP"), or waive ' +
    "it by its key where the piece typesets no text",
  "lineup-flipped":
    "no shot between the two declares the change: write the move as the `lineupTo` of the shot " +
    'it happens in, or `join: "jump-back" | "jump-forward"` where story time has moved; waive it ' +
    "by its key where the camera crosses the line",
  "lineup-gap":
    "the frame does not hold who stands between its outer subjects: add them to the `lineup`, " +
    "or, where they walked out of frame, say so in the `lineupTo` of the shot they leave in; " +
    "waive it by its key where the frame leaves them out",
  "lineup-vacuous": "drop the `lineupTo`, or write the order the shot actually leaves behind",
  "lineup-inconsistent":
    "the place's order cannot be laid out on a line: correct the `lineup` or `lineupTo` that " +
    "has the seating wrong, or waive it by its key",
  "location-backtrack":
    'no `join: "jump-back" | "jump-forward"` since moves story time: stage the detour in the ' +
    "place they are in, or declare the jump where story time moves; waive it by its key where the " +
    "return needs no jump",
  "character-unconsumed":
    "take `reference.<characterId>` as an input image of the keyframe holding them, or waive it " +
    "by its key where they are drawn from no reference",
  "slot-order-mismatch":
    "pass the keyframe's reference images in the frame's declared left-to-right order; a take " +
    "that came back with the wrong person on the wrong side is a slot fix, not a waiver",
  "plate-recropped":
    "declare a setup for that frame, holding what it shows, and move the shot onto it; one shot " +
    "alone needs no plate, and stands on a crop of the place reference named. Waive it by its key " +
    "where the frame is meant as a crop of the plate",
  "landmark-flipped":
    "a landmark does not move: correct the `holds` order of the wrong setup, or waive it by its " +
    "key where the camera crosses the set's line",
  "subject-unnamed":
    "name every subject the frame holds by its promptDepiction (verbatim, case-insensitive) in a " +
    "prompt behind the keyframe; to call them by other words, change " +
    "`characters.<id>.promptDepiction`; or waive it by its key",
  "prop-unnamed":
    "call the prop by its promptDepiction (verbatim, case-insensitive) in a prompt behind the " +
    "frame's keyframes, or drop it from the frame's `props`; to call it by other words, change " +
    "`props.<id>.promptDepiction`; or waive it by its key",
  "passer-unconsumed": "pass the passer's character reference to the take, or waive it by its key",
  "passer-unnamed":
    "name the passer by its promptDepiction (verbatim, case-insensitive) in the take's positive " +
    "prompts, or waive it by its key",
  "plate-unnamed":
    "ask for the landmark by that noun in the plate's prompt, or take it out of `holds` where " +
    "the frame does not carry it; to call it by other words, change " +
    "`locations.<locationId>.landmarks.<landmarkId>.promptDepiction`; or waive it by its key",
  "landmark-unnamed":
    "the frame's setup has no plate, so its keyframe draws the set: ask for the landmark by that " +
    "noun (verbatim, case-insensitive); to call it by other words, change " +
    "`locations.<locationId>.landmarks.<landmarkId>.promptDepiction`; or waive it by its key",
  "join-lineup-mismatch":
    "make the two frames agree, or declare the boundary a cut in its `join` (`cutin.join` for a " +
    "cutin)",
  "join-unpinned":
    "pin the end of the take before the seam to the seam frame named in video.tsx, or waive it by " +
    "its key where the boundary may jump",
  "join-unshown":
    "play the take so the cut shows the seam frame: the take before ends the shot on its landing, " +
    "the take after opens the shot on its first frame. Where the moment inside the take is what " +
    "is off, regenerate the take or change the shot's duration in direction.ts — the seam is not " +
    "the place to move it. Waive it by its key where the human judges the jump worth it",
  "opening-key":
    "the take moves past the moment its key holds: pass the key to a reference input alone, or " +
    "waive it by its key where the take is meant to open on it",
  "panel-unlinked":
    "the shot cuts from the shot before (`<from>-<id>`) along one camera axis, so the frame " +
    "carries across. Pass the panel named to one of the opening keyframe's image inputs and name " +
    "it `[Shot 1]` in the prompt, or waive the seam by its key where the cut is meant to re-open " +
    "the frame",
  "return-unlinked":
    "the shot returns across a cutaway to the setup of an earlier shot (`<from>-<id>`), so it " +
    "opens where that shot left the subject. Pass the panel named to one of the opening " +
    "keyframe's image inputs and name it `[Shot 1]` in the prompt, writing in the prompt what " +
    "changed while the camera was away; declare `jump-forward` or waive the return by its key " +
    "where nothing carries across",
  "song-unreferenced": "declare the song as `reference:<song>` in reference.tsx",
  "lyric-unplaced":
    "a person places the line on the song's review page (`konte preview reference`), or run " +
    "`konte song set <variantId> --line <key> --start <sec> --end <sec>`; waive it by its key " +
    "where the line is not sung",
  "song-overrun":
    "shorten the cut, or accept a longer take of the song; waive it by its key where the timeline " +
    "outruns the song",
};
