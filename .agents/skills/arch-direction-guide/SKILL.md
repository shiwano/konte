---
name: arch-direction-guide
description: Read when touching the direction — the arc checker and finding classes, roster anchoring, setups and plates, lineup, join and readsPrevPanel, per-part hashing, direction acceptance, and the machine-check + human-acceptance spend gates.
user-invocable: false
---

How konte turns `direction.ts` into two verdicts the spend gate acts on: a machine check over the arc and rosters, and a human acceptance recorded per reviewable part. `direction-check.ts` is the DSL-free engine, `direction.ts` the doctor + gate on top, `direction-hash.ts` / `direction-acceptance.ts` the per-part hashing and the human verdict. All of it keys off a part's address (`direction:<field-path>`) — the state key and the review target.

## The arc engine and finding classes

`checkArc` (`direction-check.ts`) is the one engine at every scale of the arc tree (a run of shots, of sequences, of runs), generic over the role string: it reads each item's `fn` off the matched lens role (no global role vocabulary) and reports `DirectionFinding`s — it never throws and never decides severity. `walkArcTree` (`direction.ts`) runs it once per node with a resolvable lens (a leaf's shots, a branch's meta-arc over children); every finding then folds against `direction.waivers`.

`ConstrainIds` (`dsl/direction.ts`) settles six in the type, each blamed in the field written:

- `off-grid-duration` — asides outside it, as in `checkDurations`
- `empty-synopsis` — `action` / `synopsis`
- `lineup-vacuous`, `unexpected-script`
- `join-impossible` — `ConstrainJoin` / `ConstrainCutinJoin` read the shot before on the clock off `DirectionShotTuple`
- `lens-role-mismatch` — `LensRolesOf` reads the node's own `lens`; a child node's `role` answers to its PARENT's; `defineLens` widens so a custom lens passes through
- Write the `DirectionViolation<M>` inline — behind an alias the compiler prints the alias name, not the advice. A widened value passes through to the finding.
- Only a direction-LOCAL demand that fires on a value WRITTEN belongs in the type — the startup type-check aborts every command (`arch-cli-guide`), so a demand naming another stage's file, or one an unfinished direction fails, stops `preview direction` itself.

What a code clears by, holds and sets in with is the finding registry's (`findingTraits`, `finding.ts`); `directionFindings` hands the check's result to it, each finding with the file it is fixed in (`findingFixStage`) and, for one to fix, the part it sits on (`findingPart`), whose accept it holds.

- Clears — `waive` only where following the rule can hurt a piece (the arc heuristics, `off-beat-cut`, …); a contradiction, an empty field or a declaration naming nothing (`unexpected-script`, `lineup-vacuous`, `off-grid-duration`, the `unused-*`, …) is `fix`: a waiver of one is reported stale (`fixOnly`).
- Onset — the roster wiring (`*-unreferenced`, the setups class bar `unused-setup` and `view-unanchored`) waits for the direction's acceptance (`reportableDirectionFindings`). The `unused-*` report always, bar a shotless direction.
- Holds — a direction finding holds the two shot stages, never `reference`; one fixed in a stage file reaches from there (`spendStages`).
- `pendingShot` — an address into one is minted unchecked; the graph records what is built on it (`pending-reference`, an `edge` hold).
- Used — a setup a shot stands on, or a master a used setup is a window of (`usedSetupIds`); a character a frame holds, whatever the action names.

A structural error (`validateDirectionStructure`, `DirectionErrorCode`) is a fix finding with no one part: it holds every direction accept, bar `empty-direction`.

`DirectionFindingClass` says what a pass must have read to evaluate a code: stale-waiver detection covers only the classes a pass evaluated. A waiver is keyed `<code>` or `<code>_<subject>` (`directionWaiverKey`); the first `_` splits it back (no code contains one). All share the top-level `direction.waivers`, so below the root a `NODE_SCOPED_CODES` subject is prefixed with the node id (`missing-role_act1.disruption`).

## Asides

`NarrativeShot` is the default (`role`/`action`/`setup`, `kind` omitted); `AsideShot` (`kind: "aside"` — a title card, an eyecatch, an OP) carries `{ id, label, duration, telop? }` only.

- `buildArcNode` splits the arc's two questions: `items` holds the arc shots only, so every role, `fn` and share check skips an aside, and `nodeDuration` sums `items` — an aside's span is outside the share denominator at every scale. `coverageIds` holds every shot, read by `checkArc` for `unrealized` / `stage-order-mismatch` alone, so an unrealized aside is still caught at export. Don't collapse the two — filtering asides out of `items` without `coverageIds` silently drops their coverage.
- Readers: `collectArcShots` (narrative + graphic; the default), `collectCameraShots` (narrative; for `setup` / `lineup` / `join`), `collectShots` (every shot; the clock, the id namespace, the stage's coverage).
- Structural: `aside-empty-label`, `run-aside-shot` (a continuity run binds backgrounds; an aside has none).
- A reviewable part: `projectShotShape` hashes `kind` and `duration`, `projectShot` adds its label, `directionPartContents` emits a `kind: "aside"` content with the arc's columns absent. `directionShotCascadeTargets` gives it only its own part (no setup, no act chain).

## Graphic shots and cutins

A `GraphicShot` (`kind: "graphic"`) is an arc shot with no camera: it stays in `items` for role and share checks. The main lane's `axisCuts` and seams break on it as on an aside.

A `cutin` (`cutin: { setup, lineup, lineupTo?, join? }` on a narrative or graphic shot) is a second camera frame, so the camera readers take frames: `collectShotFrames` yields a shot's main frame then its cutin (`lane`), and `setup-unknown`, the lineup errors, the plate counts and `listSetupAnchorGaps` read frames. `joinBoundaries` pairs each frame with the previous clock shot's frame in the same lane, so the join errors, `panelSeams`, a cutin's `axisCuts`, `cutin.join`, the seam frame and the previous panel are per lane. `checkLineups` keeps one accumulation per place across both lanes, empties every place when either frame of a shot jumps, and reads a seam against the previous entry of the same `frame`; every board reading carries `lane`. A cutin's subject is `<shotId>.cutin`, so neither frame's waiver cancels the other's. `cutin.setup` / `join` ride `projectShotShape`, its lineup `projectShot`.

## The three anchored rosters

`characters` (required), `props` (optional) and `locations` (required, non-empty) are `Record<id, { name, description }>`, each id anchored to a `reference:<id>` asset. A character and a prop add a required `promptDepiction`, a character an optional `voice` (Casting voices), a location a required, non-empty `landmarks` roster (Setups). `checkAnchoredEntities` (`direction-check.ts`) sits behind `checkCharacters` / `checkProps` / `checkLocations`, two exact-match findings per roster:

- `<noun>-unreferenced` — no exposed `reference:<id>` matches the `id`. A character only off screen (in no `lineup` / `lineupTo`) owes none.
- `unused-<noun>` — no shot uses the entity:
  - character / prop — the `name` is a literal substring of no shot `action`. One-directional: the reverse (a prose noun with no declared entity) needs NL parsing. A character with a `{ character }` script line is exempt (the "always used" set); a prop never speaks, so its set is empty.
  - location — exact id membership in the locations the used setups are set in (passed as the always-used set, with an empty `actions` list).

The cross-reference runs only when `checkDirection` supplies `referenceAssetNames`, so the roster classes are silent — and their waivers never flagged stale — when the reference stage can't be read.

The three rosters share the `reference:<id>` namespace: an id in two is `reference-id-conflict`. Landmark ids join no arm of it (nothing exposes `reference:<landmarkId>`), but the direction keeps ONE id space, so a landmark colliding with a roster id or another place's landmark is `landmark-id-conflict`.

`promptDepiction` (required on a character, a prop and a landmark) is a noun the model can draw, where `name` is the piece's word; it carries the least that separates this one from the rest. konte only scans for it, never writes it into a prompt. Its namespace spans the characters, the props and every place's landmarks (a panel's prompt chain carries its plate's prompt too); a noun containing another is a pair neither naming scan separates — `prompt-depiction-conflict`, keyed by the contained entry.

## The fourth roster: setups

`setups` (required, non-empty) is `Record<id, { name, description, location, framing, holds, within?, view? }>`; every shot names one in its required `setup` and carries neither `framing` nor `location`. `DirectionIndex` resolves both, so every reader (the shot contexts, `buildArcNode`'s items) sees a resolved value; an unresolvable one throws in `stageShotContext`, since a stage's builds run before the gate. `Setup` and `Landmark` are exported from both DSL entries.

- A landmark is `{ name, promptDepiction, description }` under a location's `landmarks`: what only that place has. It anchors on no `reference:<id>` — its setup's plate is the frame's anchor.
- `holds` — landmark ids of its own location, left to right, required and non-empty unless `framing` is `"insert"`; a shot never restates it. `ConstrainSetupHolds` reaches the ids through the setup's `location` literal, re-blames each element, and asks an empty non-insert tuple for a first element it cannot supply. `landmarks` non-emptiness has no type, so `landmarks-empty` is structural, beside `holds-empty` / `holds-unknown-id`. `holds` reaches no `ctx` — the build receives the frame as a plate, and the order is the prompt critic's.
- `within` — the setup this frame is a window cut out of, `null` at a root; konte never derives it (the same shape is as often a reverse or a second axis). `ConstrainSetupWithin` blames the `within` position for an unknown id, another `location`, a `framing` not strictly wider (`WiderThan`, `wide` < `medium` < `close`), and any `within` on an `insert`; widened types pass to the runtime. `withinErrors` re-checks all four as `within-impossible`, adds `within-cyclic` (reachable only past the type layer), and demands `within-undeclared` wherever a strictly wider setup of the same place carries this frame's `holds` as an ordered subsequence. That subsequence is the CANDIDATE test alone — a window may hold a landmark the wider frame was too wide to declare, so a `within` outside the candidates is legal. `within` rides `projectSetups` and the setup's part hash, not `projectSetupShape` — it moves neither the size cadence nor the place.

- `view` — the way the camera faces (`VIEWS`: `front` is the master's, `back`, `side`, `top`). The `Setup` union requires it where `within` is not a string and forbids it on a window, which inherits its root's (`setupView`); `view-missing` / `view-on-window` / `view-unknown` are its structural twins. It rides `projectSetups` and the part hash, not the shape.
- A view other than `front` is realized by a view image, `reference:view.<locationId>.<view>` — returned from `defineReference`'s `views` (declaration site `view`) and filed by its key: `fileViews` renames the asset and rewrites every placeholder, prompt and pin naming it. The ref's `reference.view.<locationId>.<view>` is built from the direction alone, so a view `views` has not returned is still reachable. `walkPictureChain` reads a view image as its location, so `plate-unanchored` / `setup-unconsumed` count it; `reachedView` is the exact match `plate-unviewed` reads.

A setup is realized by a plate (`animatic:plate.<setupId>`, from `defineAnimatic`'s `plates` callback), not `checkAnchoredEntities`: its id joins no arm of `reference-id-conflict` and no `directionReferenceCascadeTargets` / `referenceRosterEntries` loop, a setup implies no spend until the board exists, and `checkSetups` takes `shotsPerSetup` plus the board's state.

Plates are keyed by roster id, each returned as its image asset; `timeline` receives them unchanged. konte writes no prompt text; a keyframe on the plate restates nothing the picture shows. Returning files one under a setup; an asset declared and not returned is an intermediate and may not take a roster id. Being returned makes each a usage root, so `konte generate animatic` bakes them while every shot is still a `pendingShot`. `animatic:plate` is an address-scope (`probe` reads them all).

`checkSetups` emits six. Four per setup, each checked only where the one before is satisfied — so waiving a setup out of owing a plate waives its shots out of consuming one: `unused-setup` (no shot names it), then for a setup two or more shots name `setup-unrealized` (no plate), then `plate-unnested` and `setup-unconsumed` (a plate no developed shot on it builds from). One rule — a developed shot reaches its setup's anchor, and the anchor reaches the place (`plate-unanchored`) — at three points:

- Reach is per shot, not per panel; `setup-unrealized` counts generated shots; both anchor findings wait on `reference:<location>` existing.
- A shot with no generative step is outside all three; a plate is exempt only when it touches no reference at all (a file handed over whole), whatever its chain generates.
- `axis-unrealized` reads along `within` (Join).
- `plate-unnested`: `listSetupNestGaps` (graph.ts) walks the child's plate chain for a cut — a `readsPrevPanel` step handed the parent plate as is (`imageInputs`) — or a window: an `imageCrop` straight out of the parent plate, or out of the master the parent plate cuts, strictly inside the parent's rectangle. Windows nest by induction; the crop nearest the parent plate is the parent's window. Silent where either plate is absent.
- The views ride `checkViews` and the plate loop, board- and reference-gated: `view-unrealized` (a used setup's non-`front` view with no image, keyed `<locationId>.<view>`), `plate-unviewed` (a plate — or, plate-less, a shot's keyframe chain — reaching the place through another view only; silent until its own view's image exists), `view-unanchored` (`listViewAnchorGaps`: a view image built from no master, a `file` exempt — reported off the reference pool alone, before the board and the acceptance). `placeRefOf` makes `setup-unconsumed` / `plate-unanchored` / `plate-recropped` name `views.<locationId>.<view>` for a setup not facing `front`.
- `setup-atomized` reads the roster whole, on a direction-only pass, per LOCATION: `ATOMIZED_LOCATION_SHOTS` (8) shots, fewer than half on a shared frame.

The board state is `checkDirection`'s `animaticSetups` (`AnimaticSetupState`: `plateIds` + `unconsumedBy` + the two gap lists), undefined meaning "no board yet"; every reader must pass it (`loadAnimaticSetupState`) or the demand is dead. Stale-waiver detection is per class, so the class enters `evaluatedClasses` only WITH it — otherwise a live `setup-unrealized` waiver reads stale.

`unconsumedBy` is `listSetupAnchorGaps(...).unanchoredShots` (graph.ts), a walk over the animatic's OWN refs rooted at each developed shot's PANELS only — the keyframes are what the finding is about. Not the declared pool (an unrendered asset taking the plate would clear it for a keyframe built from nothing), not `compositionRefs` (an overlay or sound taking the plate says nothing about the keyframe's frame). A plate reaching a keyframe through a shot asset, a timeline asset or a `shot(…)` chain is found from the panel. Whether the prompt names that picture is the prompt critic's.

The plate is neither acceptance-gated (`unacceptedUpstreamDeps` walks self-stage nodes through) nor review work: no page shows it alone, so it is judged inside its panels. It sits one level below the composition, reached through the KEYFRAME's job provenance rather than `compositionRefs`, so accepting the first panel on it cascades onto it. `listReviewableAssetPaths` / `print-status` keep it out of "Needs review" and the accept ratio; `computeExportReadiness` still counts an unbaked or stale one as `generate` work. A handoff note may name it (`collectAllAddresses`).

## Lineup: the staging class

A narrative shot's `lineup` names the `characters` ids the frame holds, left to right — a sleeve in frame counts, there is no off-frame axis, a prop is never lined up. `lineupTo` is the frame at the shot's end, in full, declared wherever the frame changes inside the shot: whoever it leaves out has walked out. Both reach the build as `ctx.lineup` / `ctx.lineupTo`, and `inspect --prompts` prints a `lineup:` line above each prompt, the setup's `holds` as `set:` beneath it, a declared `join` as `join:` above it; konte never expands any into prompt text. `lineup-vacuous` is a `lineupTo` equal to the `lineup`.

- `lineup` is REQUIRED on a narrative shot (`[]` for no one); one missing is `lineup-missing`, structural, reachable only by a computed direction.
- `ConstrainIds` re-blames each element as `SubjectIdOf<D>`. A bad id maps to `LineupSubjectViolation<T>`, an OBJECT — a `never` element would collapse the tuple it is intersected with and blame every id in it.
- `checkLineups` (`direction-check.ts`): one `Map` of pairs per LOCATION ("a is left of b" plus the shot that said so), walked in direction order. A shot's `lineup` is checked against it (`lineup-flipped`, then `lineup-gap`), then written in; a `lineupTo` first DROPS the pairs of whoever the opening frame held and it does not, then writes its own. A `jump-back`/`jump-forward` join clears every place.
- `skippedBetween` reads the OUTERMOST pair, not each neighbouring one — someone whose place beside the middle was never declared is inside the span anyway. Dropping on `lineupTo` means no presence guard is needed: a subject with no pairs is never between anything. `findCycle` after each write is `lineup-inconsistent`; on a ring the place restarts from that shot's exit order, or every later shot repeats it.
- `checkRoutes` walks the same frames per CHARACTER: one held in a place they left, with no jump since, is `location-backtrack`, keyed `<frame>.<characterId>`. A frame not holding them moves nothing, so a cutaway is no detour.

`checkStaging` (`direction.ts`) projects the direction into `LineupShot[]` — each location resolved through its setup (undefined files it under no place), carrying `join`, which `join-lineup-mismatch` reads against the previous shot's `lineupTo ?? lineup` and `checkJoinPins` against `videoPins`. The board half is `stagingStage` (`loadStagingStageState`) on `animaticSetups`' contract (undefined = no board; the class enters `evaluatedClasses` only with it), three readings of the same panels in panel order:

- `listPanelReferenceSlots` — each panel's OWN inputs, read by `checkSlotOrder` (`slot-order-mismatch`: inputs in an order the shot does not declare).
- `listPanelReferenceReach` — the CHAIN behind it, read by `checkCharacterAnchors`: one `character-unconsumed` per subject, keyed `<shotId>.<characterId>`, held back for a character with no `reference:<id>` and a panel that generates nothing.
- `panelPrompts` (`listPanelPromptText`) — the positive prompts of a panel and every step behind it, read by `checkSubjectNaming` for each subject's `promptDepiction` (`subject-unnamed`). The text half of `character-unconsumed`'s demand, with its panel rule and shape: first panel for the `lineup`, last for the `lineupTo`, same key, silent on a non-generative panel. Matching is a case-blind substring: a noun is found inside "the desk", and a prompt that opens on a subject and goes on with "she" has named them.

Prompt naming beyond characters:

- `prop-unnamed` (`checkPropNaming`) — an `action` naming a prop (`unused-prop`'s scan) is its declaration; any one generative keyframe chain of the shot, either lane, must carry its `promptDepiction`. A prop whose `reference:<propId>` reaches the shot's `pictureRefs` through deterministic steps only (`listShownReferences` — a `jsxImage` screen, a resize) is on screen as its own picture and owes none. Keyed `<shotId>.<propId>`.
- `plate-unnamed` — `plateTexts` (`listPlateTexts`), the positive prompts on a returned plate's own chain, stopping at another returned plate, must carry the `promptDepiction` of every landmark in its setup's `holds`; keyed `<setupId>.<landmarkId>`. A chain reading no prompt (a crop of the master, a file) has an empty entry and is not read.
- `landmark-unnamed` (`checkLandmarkNaming`) — the same of the keyframes on a setup with no returned plate (the key `plateTexts` lacks), over the `panelPrompts` chain of each panel that reads a prompt; a frame on a plate owes nothing. Keyed `<frame>.<landmarkId>`.
- `landmark-flipped` (`checkLandmarkOrder`, no board) — accumulates pairs per location as `checkLineups` does, where two frames of one place disagree about an axis nothing on it can move. Since a landmark does not move: setups are read sorted BY ID (a roster is a set whose record order moves no hash and must not decide which frame a waiver key names), and the first frame to state a pair fixes it — overwriting would make one waived reverse angle report every frame after it.
- `plate-recropped` — `plateRecrops` (`listPlateRecrops`), each panel whose path back to its plate crops it, per frame.

## Join

A narrative shot's `join` states the boundary INTO it. Omitted is an ordinary cut with story time running on; `"jump-back"` / `"jump-forward"` are cuts that move story time; `"continuous"` is no cut — this shot and the one before are one unbroken take. The four are exclusive, so a jump inside a long take is not expressible.

- A long take is possible only where the shot before on the clock (asides included) is a narrative shot on the same setup — one take is one camera position, so a hold that moves is two panels in one shot. Elsewhere `"continuous"` is `join-impossible` (a literal is refused by the type first); where possible, omission is `join-undeclared`. Both structural; konte never derives the join. Validated over `collectShots`, not `collectArcShots` — the boundary an aside sits at is a cut, invisible to the narrative-only walk. `join` rides `projectShotShape`, so an edit ages out the shot's part and the root `sequence` part.
- The seam is ONE frame: the opening keyframe of the shot owning the boundary. The shot before authors no closing keyframe — its last panel moves into that keyframe (`DirectionIndex.continuedById`, a clock walk over `runOn`, stored as `ShotDefinition.continuedBy` per lane, is what `defineAnimatic` reads to lift the landing-frame rule — `assertPanelMoves`, `collectPanelMovement`). Its `lineupTo` is read against no panel of its own: `LineupShot.continuedBy` makes `character-unconsumed` / `slot-order-mismatch` / `subject-unnamed` skip the last-panel reading, and `join-lineup-mismatch` (the previous shot's `lineupTo ?? lineup` is this shot's `lineup`) reads it at the next shot's first panel.
- `join-unpinned` — the take BEFORE the seam does not pin its `end` to that frame (`checkJoinPins`, over `videoPins` and `shotPanels.firstPanel`), judged where that take is developed and the board holds the frame, before the take after exists; nothing is demanded of the take after. `VideoShotPins.pins` carries what each pin reaches (the source and its chain through the video's own declarations, so a resize still pins) beside `slots`, what its model could take (`recordPinInputs` records an empty slot too): a model with no `end` slot is silent, as for `panel-unlinked`. `load-definition` reads video.tsx for this alone, only where the direction declares a `continuous`.
- Axis cut — an omitted join across two setups sharing a `within` root, siblings included, does not restart the frame: the previous shot's last panel is the new frame's light, size and place. The opening keyframe takes it in any image input of a `readsPrevPanel` adapter, found by value (another shot's panel, passed unwrapped). `panel-unlinked` (waivable) fires where it took another frame, unless both lineups hold subjects and share none, judged only where both shots are on the board (`panelSeams` / `isAxisCut`); `promptReferenceTags({ prevPanel })` refuses at load a second one, or one the prompt does not name as the source. An aside between the shots breaks the pair.
- `axis-unrealized` — a `wide`↔`medium` pair of one axis owes a plate at each end and up to the frame they share, so `plate-unnested` holds them to one master.

## Coverage shots

A narrative shot with `coverage: true` is one take the model cuts inside: `setup` and `lineup` are its opening frame, later camera positions the model's. It declares no `lineupTo` or `cutin`, and no take runs on from it — `ConstrainCoverage` / `ConstrainJoin` refuse a literal, `coverage-overdeclared` / `join-impossible` a computed one. Readers branch on `ShotFrame.coverage`: `joinBoundaries` gives the frame after it no `runOn` (no `join-undeclared`), `panelSeams` skips it as the frame before, `checkLineups` empties its place after its opening frame (`LineupShot.coverage`), `checkFusedShots` reads no `multi-sentence-action` off its `action`. Everything read off the opening frame (`slot-order-mismatch`, `character-unconsumed`, `subject-unnamed`, the setup counts) stands. `coverage` rides `projectShotShape`; the board holds it to one `<Panel>` (`DirectionIndex.coverageIds`).

`docs/SEAMS.md` is every rule above run over fixtures (`seam-doc.ts`, regenerated or the test fails).

## Words

- `telop` — unspoken text over the picture, read from the direction by `preview` / `inspect`, passed to no stage.
- `script` — the spoken lines. A character line takes an optional one-line `acting` note (the delivery, hashed with the shot's prose, shown on both review surfaces); a mob or narration line takes none (typed `never`). Every line demands a cast voice and an `<Audio>` on the animatic shot carrying its words, or a `respell()` of them.
- `scriptFindings` (`dsl/animatic-builders.ts`) finds `script-unvoiced` per LINE, off the `"spokenText"` reachable from each `stemRef` — a build finding. A cue yielding none is a recording, and ONE drops the shot to the whole-shot rule — counting them as a line each would refuse a single recording of a two-hander.

## The song

`policy.song` (a `reference:<id>` id) cuts the piece to a song: every span is `beats`, never `duration` (`ConstrainSpan`, `shot-span-mismatch` past it); `off-grid-duration` asks for a positive number of beats, and `off-beat-cut` (waivable) for a whole one. A beat falls where the injected take plays it (`songBeatSec`); the first shot holds the take's lead before beat 0, each cut lands on its beat's frame. Unread, a shot holds only beats and a build needing seconds stops on `SONG_UNREAD`. `DirectionIndex.timeline` carries it to every stage; `ctx.beat(n)` is beat `n` of the shot's span, in seconds. The song is the part `direction:policy.song`; a span rides `projectSpan`.

`lyrics` (`[{ label, singer, lines }]`): `singer` is a character id or list; a line is text or `{ text, singer }`. Structural: `lyrics-without-song`, `lyrics-singer-unknown`, `lyrics-singer-empty`, `lyrics-empty-line`. `direction:lyrics` is one piece-wide part with its own section: a lyric edit holds a spend after `whole`.

`placeDirectionLyrics` puts each line on the take's clock — where a person placed it (`SongAnalysis.lines`), else `placeLyricLines` (`song-lyrics.ts`), matching against the words heard and leaving a line unplaced where its opening is not heard. `lyricsInSpan` hands a shot or overlay the lines under its span as `ctx.lyrics`, frame-rounded so an unmoved placement hashes the same. The definition loader injects each video's song take (`withSongTakes`, under the definition import's lock); `definition-source.ts` folds its reading into the source fingerprint.

The `song` class reads the take the piece is cut against (`resolveSongTake`: the accepted take, else the newest analyzed one not dismissed; staleness not asked), as `SongTakeState` (`loadSongTakeState`) on `animaticSetups`' contract, never deferred:

- `song-unreferenced` — `policy.song` names no exposed `reference:<id>`; fixed in the reference stage (`findingFixStage`).
- `lyric-unplaced` — a line nobody places, keyed `<section>.<line>`; its take refuses accept (`SONG_LINES_UNPLACED`).
- `song-overrun` (`stage`) — the timeline outlasts the take.

A `song-analysis` job reads a take into `song.json` beside it, hashed in the variant's `song`, once per bytes and `policy.lang`: beats and bar heads by Beat This! (`beat-this.ts`), the meter and beat 0 from them, sung stretches and words off the vocal track sherpa-onnx separates. A generated take is queued as it lands; `konte song analyze` reads the current take and every unread one in place. `song set --first-beat` picks which read beat is beat 0 (`firstBeatSet`), kept over a re-read.

## Casting voices

A `Voice` is `{ id, description }`: `id` is its own exposed `reference:<id>` sample, never the look anchor; `description` is how the member sounds. A `Character` carries an optional one; `direction.narrator` is a bare `Voice`, singular because a `{ narration }` line names no speaker — two voices over picture means `{ speaker }` lines, which anchor to nothing and are unchecked.

- `checkCharacterVoices` / `checkNarrator` (`direction-check.ts`): `character-voice-missing` / `narrator-missing` on a speaking part with no voice, `*-unreferenced` on a sample not exposed, `unused-character-voice` / `unused-narrator` on a voice nobody speaks with. A piece of subtitles, or a TTS taking a preset voice name, waives the first four; the two `unused-*` are fixed. `character-voice-empty-description` is structural.
- `reference-id-conflict` covers a voice id colliding with a roster id only: two cast members may share a voice id (a narrator who is the protagonist, twins), so a reference id resolves to a LIST of parts — `directionReferenceCascadeTargets` and `referenceRosterEntries` are many-valued, one accept settles every brief cast on that sample, and the card prints them all.
- An unaccepted cast voice holds both composition stages' spend, like a look. The sample is in the cast exclusion set beside the looks: it is audio, so a stem-rooted accept walk (which allows audio) would otherwise reach the sample a line was cloned from.

## Per-part hashing

`directionPartHashes` (`direction-hash.ts`) IS the set of reviewable parts: what it emits is what the review page must offer an Accept for and the gate demands. Key: the part's `direction:<field-path>`; value: everything a reviewer sees on it. One part per: the root arc (`sequence`), each filled brief field, each policy field (`policy.format`/`policy.lang`/`policy.fonts`/`policy.speech`, always), each shot, each non-root node, each waiver, each roster entry (`setups` included), each cast character voice (`characters.<id>.voice`, only while cast) and `narrator`.

- A character's hash excludes `voice` — look and voice are two assets accepted separately, each aging out on its own edit.
- A shot's hash excludes its setup's framing/location and hashes the `setup` id — re-pointing a shot ages it out, re-describing a frame ages out only that setup's part.
- The root `sequence` hashes `projectShape` (shots, order, lengths, the roster ids), not prose, so an arc note survives a brief reword. `setups` enters as `projectSetupShape` — ids plus `location`/`framing`, the piece's size and space cadence. Every other part hashes its prose too.
- `directionPartContents` (`direction-parts.ts`) is the read side over the same key set; a part with a hash and no content is one the gate demands and no reader renders — keep the two walks in step.
- A media-less comment and an acceptance both snapshot the part's hash and age out on the same edit (comments: `arch-review-system-guide`).
- `directionHash` (`projectDirection`) is the whole-direction short-circuit; it holds only because `projectDirection` is a superset of every part hash's input. When adding a part hash, extend `projectDirection` too — otherwise an edit can leave an acceptance standing that no human gave.

## Human acceptance

`direction-acceptance.ts` is the single reader of the acceptance record (gate, `status`, `doctor`, review page). A part's `DirectionPartStatus`: `accepted` (recorded hash matches live), `stale` (part changed), `unaccepted`.

Reporting and gating are two questions. `complete`/`blocking` are the page's and `status`'s — every live part at its accepted hash, no orphans. `gateSatisfied`/`gateBlocking` are the spend gate's, and narrower: the record's `whole` (`{ hash, acceptedAt } | null`) marks one end-to-end sign-off; while null the gate IS the full comparison, after it only `PIECE_WIDE_SECTIONS` (`brief`, `policy`, `waivers`) hold a spend — everything else reaches a human as a panel, a shot or a `reference:<id>` image. A shot's waiver (`directionShotWaivers`) rides its review. `directionGatingSections` is the same split, for the page's button wording.

The page accepts per section. `DIRECTION_SECTIONS` (`address.ts`): `brief`, `policy`, `characters`, `props`, `locations`, `shots`, `waivers`; `directionSectionOf` routes every part to exactly one, guaranteeing every part an Accept. `characters` also takes a character's voice part and `narrator`; `locations` takes `setups.<id>` (the Locations & Setups box). A section's status is its weakest part's. The whole arc tree (root arc, child acts, every shot) is inseparable — splitting a shot re-shapes the arc — so it is one Flow & Shots box (`shots`).

Orphans — a part accepted and since deleted (the comparison is over the key set):

- One counts against its own section (that box reads not-`accepted` even empty), since only that box's Accept drops it (`applyDirectionSectionDecisions` clears a decided box's own orphans, never another's).
- Once `whole` stands, orphans outside the piece-wide sections are swept by the next write — leaving one would keep `complete` false forever.
- A deleted waiver is no orphan (`orphanOwesReview`): removing one only hands its finding back to the machine check, so it never blocks and any write sweeps it, before `whole` too. Waivers sit in `projectNode`, not `projectNodeShape`, so `sequence` does not move either.
- `isDirectionSpendGateSatisfied` short-circuits on `whole.hash === directionHash` only while `parts` is non-empty.

Three writers, all ending on `finalizeAcceptance` (sweep, then re-derive `whole`, never on a shotless direction); emptying `parts` (`konte accept direction --off`) is the one way back to never-accepted. No writer stamps a `shots` part on a shotless direction (`directionSectionAcceptable`): the page disables that box's Accept, and `konte accept direction` holds the root arc back, refusing a scope naming only it (`DIRECTION_SHOTS_UNWRITTEN`).

- `applyDirectionSectionDecisions` (the direction review) stamps each decided part at its live hash, carries undecided parts forward, drops rejected ones. Accept is a toggle (un-toggling revokes); there is no Reject — "what's wrong" lives in the notes. A box with neither an accept nor a live note is named in the submit confirmation, a pause not a block (`pages/preview/review/undecided.ts`).
- `applyDirectionPartDecisions` (`konte accept direction[:<scope>]...`) expands each scope to its parts, keyed by part address, orphans included — one decided `false` is dropped, which is how `--off` clears it. A part a fix finding sits on is refused (the review gate); a waivable one holds no accept.
- The media → direction cascade: an animatic/video shot accept signs off the direction shot, its frames' `setups.<id>`, its acts, its waivers and the roster entries it declares; a `reference:<id>` accept signs off the part(s) it anchors (an identity-roster entry, or a cast sample's voice parts). Before `whole` stands it only moves a part `stale` → `accepted` (R1); after, it signs off never-read parts too. Touching either: read `references/cascades.md`.

The spend gate (`judgeSpend`, `cli/finding-gates.ts`) names every reason at once, the unaccepted ones only at the upstream-most rank: the direction's blocking parts, then the cast (the characters a `lineup` / `lineupTo` holds, every voice), then the consumed upstream. The reference stage is exempt from acceptance, bar the song: a run submitting `clock.song`'s take needs `brief`, `policy` and `lyrics` accepted. A part a fix finding sits on is held from `konte accept direction` and the page's section Accept alike.

## Policy fields

`format`, `fonts` and `speech` are machine-checked, each in the acceptance hash and its own feedback part (`direction:policy.<field>`), each enforcing only what konte can check:

- `policy.format` (`{ fps, size: { megapixels, delivery } }`) — the canvas is derived. `deriveCanvasBase` (`core/canvas.ts`) resolves the budget against the delivery's aspect to the nearest 32-grid size, ranking aspect error above area error. `resolveDirectionFormat` is the one caller; `DirectionIndex.format` is the resolved form (`ResolvedDirectionFormat`), and every reader holding a bare `Direction` (`projectFormat`, `direction-parts`, `patch.ts`, the review page) goes through it. `assertCanvasFormat` checks only what is authored — a positive `delivery`, `megapixels` under `MAX_MEGAPIXELS` (unit-slip guard), a positive finite `fps`; no grid or aspect check. `DELIVERY_UPSCALE_REQUIRED` fires only above `UPSCALER_REQUIRED_ABOVE` (1.2×). The hash takes the derived canvas, never the budget, so a budget edit landing on the same canvas ages nothing. The grid remainder is cropped from the centre at export, never upscaled. A reference sheet is sized off the canvas' long edge: portrait for a character, a landscape master at twice it for a location, square otherwise. Changing the derivation moves every existing piece's canvas and stales what was built on it, so it needs a version pinned in `direction.ts` to opt into — none exists today.
- `policy.lang` (one of the closed `LANGUAGES`, a script or region may ride along) + `policy.fonts` (Google Fonts family names) — the typesetting all three stages read, one `Typography` on `DirectionIndex`: `lang` on the document root, the fonts as one stylesheet `<link>` and the composition body's fallback stack. The preview loads the faces from that link; every capture and render first embeds each `font-family` the page names as `@font-face` data URIs (`embedFontFaces`), and a family that cannot be fetched refuses it with `FRAME_CAPTURE_FAILED`. `checkTypesetting` raises the waivable `fonts-undeclared` when `fonts` is empty and `scriptOf(lang)` (the tag's script subtag, else the language's `DEFAULT_SCRIPT`) is in `SCRIPTS_NEEDING_A_DECLARED_FACE`.
- `policy.speech` (`"none"` / `"no-dialogue"` / `"free"`) — the waivable `unexpected-script` on a shot whose `script` contradicts it (`none` forbids any line, `no-dialogue` spoken lines but allows narration, `free` nothing).
