# Seams

<!-- Generated from src/core/seam-doc.ts by `bun run build:generate-seam-doc`. Do not edit by hand: src/core/__tests__/seam-doc.test.ts fails when this file and the code disagree. -->

What konte demands at the boundary between two shots (`join`, the lineup across it, the previous panel, the video's pins), as the checker answers it over fixtures. Every row is one direction, with the board or video state the rule reads, run through `validateDirectionStructure` and `checkDirection`; Result is what came back. An `error` is structural and never waived; the rest are findings, waived by key. Not shown: findings outside the boundary rules, and the load-time rules a stage file trips on its own (`ANIMATIC_INVALID` on a landing panel that declares movement).

Fixtures: one room with `wide` (the axis root), `medium` (`within: "wide"`) and `reverse` (a second camera on its own axis), and `yard` in another place. `[a ⇒ b,a]` is a shot's `lineup` and `lineupTo`.

## Declaring the boundary

`join` is the boundary INTO a shot. Omitted is an ordinary cut; `jump-back` / `jump-forward` are cuts that move story time; `continuous` is one unbroken take with the shot before it. A take can run on only from the shot just before on the clock, narrative, on the same setup: there the boundary must be declared, and nowhere else can it be `continuous`. Both are structural errors, never waived; a literal `continuous` written elsewhere is refused by the type layer first.

| Case                                                        | Direction                                                                      | Board | Video | Result                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- | ----- | ----------------------------------- |
| Same setup, nothing declared                                | 01 wide [a] → 02 wide [a]                                                      | none  | none  | `join-undeclared` (02, error)       |
| Same setup, one take                                        | 01 wide [a] → 02 wide `continuous` [a]                                         | none  | none  | none                                |
| Same setup, a jump cut                                      | 01 wide [a] → 02 wide `jump-forward` [a]                                       | none  | none  | none                                |
| `continuous` across two setups                              | 01 wide [a] → 02 medium `continuous` [a]                                       | none  | none  | `join-impossible` (02, error)       |
| `continuous` opening the piece                              | 01 wide `continuous` [a]                                                       | none  | none  | `join-impossible` (01, error)       |
| `continuous` after an aside                                 | 01 wide [a] → ec (aside) → 02 wide `continuous` [a]                            | none  | none  | `join-impossible` (02, error)       |
| `continuous` after a graphic shot                           | 01 wide [a] → card (graphic) → 02 wide `continuous` [a]                        | none  | none  | `join-impossible` (02, error)       |
| A cutin runs on from the cutin before it                    | 01 wide [a] + cutin reverse [b] → 02 yard [a] + cutin reverse `continuous` [b] | none  | none  | none                                |
| A cutin `continuous` where the shot before carries no cutin | 01 wide [a] → 02 yard [a] + cutin reverse `continuous` [b]                     | none  | none  | `join-impossible` (02.cutin, error) |

## The lineup across the boundary

Who a frame holds, left to right, accumulates per place across ordinary cuts. A jump empties every place. One take has one frame at its seam, so the shot before's `lineupTo ?? lineup` must be the next shot's `lineup`.

| Case                                             | Direction                                      | Board | Video | Result                      |
| ------------------------------------------------ | ---------------------------------------------- | ----- | ----- | --------------------------- |
| One take, the seam agreed on                     | 01 wide [a ⇒ b,a] → 02 wide `continuous` [b,a] | none  | none  | none                        |
| One take, the two shots wanting different frames | 01 wide [a] → 02 wide `continuous` [b,a]       | none  | none  | `join-lineup-mismatch` (02) |
| An ordinary cut reversing a pair                 | 01 wide [a,b] → 02 medium [b,a]                | none  | none  | `lineup-flipped` (02)       |
| A jump reversing a pair                          | 01 wide [a,b] → 02 medium `jump-forward` [b,a] | none  | none  | none                        |

## The board's frame across a cut along one axis

An omitted join between two setups sharing a `within` root: the opening keyframe takes the previous shot's last panel in one of its image inputs. Judged where both shots are on the board and the keyframe's model reads a previous panel (`readsPrevPanel`), unless both frames hold subjects and share none. A long take asks the board for nothing.

| Case                                          | Direction                                  | Board                                             | Video | Result                          |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------- | ----- | ------------------------------- |
| Push in, handed the frame before              | 01 wide [a] → 02 medium [a]                | on the board: 01, 02; 02 previous panel ← 01.last | none  | none                            |
| Push in, handed no previous panel             | 01 wide [a] → 02 medium [a]                | on the board: 01, 02; 02 handed no previous panel | none  | `panel-unlinked` (01-02)        |
| Push in, handed another shot's frame          | 01 wide [a] → 02 medium [a]                | on the board: 01, 02; 02 previous panel ← 07.last | none  | `panel-unlinked` (01-02)        |
| Push in, a model that reads no previous panel | 01 wide [a] → 02 medium [a]                | on the board: 01, 02                              | none  | none                            |
| Push in, the shot before not yet on the board | 01 wide [a] → 02 medium [a]                | on the board: 02; 02 handed no previous panel     | none  | none                            |
| Push in across a story-time jump              | 01 wide [a] → 02 medium `jump-forward` [a] | on the board: 01, 02; 02 handed no previous panel | none  | none                            |
| Push in from one subject to another           | 01 wide [a] → 02 medium [b]                | on the board: 01, 02; 02 handed no previous panel | none  | none                            |
| Two cameras in one room                       | 01 wide [a] → 02 reverse [a]               | on the board: 01, 02; 02 handed no previous panel | none  | `undeclared-continuity` (01-02) |
| Push in with an aside between                 | 01 wide [a] → ec (aside) → 02 medium [a]   | on the board: 01, 02; 02 handed no previous panel | none  | `undeclared-continuity` (01-02) |
| One take, handed no previous panel            | 01 wide [a] → 02 wide `continuous` [a]     | on the board: 01, 02; 02 handed no previous panel | none  | none                            |

## The video's frame across a long take

The seam of a long take is the opening keyframe of the shot that declares it. The video take before must pin its end to that frame. Judged where the take before is developed, the board holds the seam frame, and the take before's model has an end slot; the take after need not exist yet.

| Case                                                       | Direction                              | Board                | Video                                                     | Result               |
| ---------------------------------------------------------- | -------------------------------------- | -------------------- | --------------------------------------------------------- | -------------------- |
| The take before pins its end to the seam frame             | 01 wide [a] → 02 wide `continuous` [a] | on the board: 01, 02 | developed: 01, 02; 01 end → 02.first                      | none                 |
| The take before pins its end to a resize of the seam frame | 01 wide [a] → 02 wide `continuous` [a] | on the board: 01, 02 | developed: 01, 02; 01 end → video:shot.01.seam → 02.first | none                 |
| The take before pins its end to its own last panel         | 01 wide [a] → 02 wide `continuous` [a] | on the board: 01, 02 | developed: 01, 02; 01 end → 01.last                       | `join-unpinned` (02) |
| The take before pins nothing                               | 01 wide [a] → 02 wide `continuous` [a] | on the board: 01, 02 | developed: 01, 02                                         | `join-unpinned` (02) |
| The take before's model has no end slot                    | 01 wide [a] → 02 wide `continuous` [a] | on the board: 01, 02 | developed: 01, 02; 01 has no end slot                     | none                 |
| The take after not yet developed                           | 01 wide [a] → 02 wide `continuous` [a] | on the board: 01, 02 | developed: 01                                             | `join-unpinned` (02) |

## The shot before a long take

The shot before a long take authors no closing keyframe: its `lineupTo` is read against the next shot's first panel.

| Case                                                                        | Direction                                        | Board                                                                    | Video | Result                        |
| --------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ | ----- | ----------------------------- |
| One take: the frame the `lineupTo` describes is the next shot's first panel | 01 wide [a ⇒ a,b] → 02 wide `continuous` [a,b]   | 01.first ← reference a; 01.last ← reference a; 02.first ← reference a, b | none  | none                          |
| A cut: the `lineupTo` is the shot's own last panel                          | 01 wide [a ⇒ a,b] → 02 wide `jump-forward` [a,b] | 01.first ← reference a; 01.last ← reference a; 02.first ← reference a, b | none  | `character-unconsumed` (01.b) |
