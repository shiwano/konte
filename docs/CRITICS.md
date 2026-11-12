# Critics

<!-- Generated from src/core/critic-checks.ts by `bun run build:generate-critics-doc`. Do not edit by hand: src/core/__tests__/critics-doc.test.ts fails when this file, the code or a critic contract disagree. -->

Every problem code a shipped critic subagent reports. Each contract is `src/cli/templates/agents/<critic>.md`.

- **Machine** — the findings ([FINDINGS.md](FINDINGS.md)) that settle the formal half of the check on the artifact the critic reads; the critic judges what they leave.

## konte-direction-critic

Reviews `direction.ts`, before any stage content is written.

| Code                    | Checks                                                                                                             | Machine                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `late-hook`             | The first shot does not put `brief.hook` on screen.                                                                | —                                                                                                                |
| `redundant-exposition`  | An explanatory shot that can be deleted.                                                                           | —                                                                                                                |
| `possible-overcut`      | A trigger and its reaction split where one readable action would do.                                               | —                                                                                                                |
| `broken-causality`      | Position, possession, movement or state does not connect across a continuity run.                                  | —                                                                                                                |
| `contrived-causality`   | A physical chain that exists only to reach the last image.                                                         | —                                                                                                                |
| `orphaned-setup`        | A plant never collected.                                                                                           | —                                                                                                                |
| `illegible-action`      | An `action`'s subject, change or result is ambiguous without sound.                                                | —                                                                                                                |
| `flat-escalation`       | A repetition that raises nothing.                                                                                  | —                                                                                                                |
| `risk-concentration`    | The payoff rests on one shot with no reading left if its takes don't land.                                         | —                                                                                                                |
| `undivided-motion`      | One take carries a motion its frame cannot show, or a hinge's whole transit.                                       | —                                                                                                                |
| `continuity-exposure`   | An adjacent same-location pair changes size by one step with no job for the cut.                                   | —                                                                                                                |
| `unsupported-long-take` | A `continuous` join whose `action` carries nothing across the seam, or whose shots want different frames.          | [`join-impossible`](FINDINGS.md#direction-structure)<br>[`join-lineup-mismatch`](FINDINGS.md#direction-findings) |
| `missed-long-take`      | A beat or event that lives on uncut time is cut across shots.                                                      | [`join-undeclared`](FINDINGS.md#direction-structure)                                                             |
| `missed-coverage`       | An unbroken exchange split into a shot per setup.                                                                  | —                                                                                                                |
| `unsupported-coverage`  | A `coverage: true` shot holding one act or a quiet beat.                                                           | —                                                                                                                |
| `overloaded-coverage`   | A coverage shot with more beats than its span carries, or a broken cause.                                          | —                                                                                                                |
| `weak-payoff`           | The payoff doesn't land, or the final image does not carry `brief.audience`'s takeaway.                            | [`no-payoff`](FINDINGS.md#direction-findings)<br>[`unearned-payoff`](FINDINGS.md#direction-findings)             |
| `unrostered-recurrence` | A noun several shots' `action` names has no roster entry.                                                          | —                                                                                                                |
| `view-mismatch`         | A setup's `view` is not the way its `description` faces, or its screen sides contradict the master's.              | [`view-undeclared`](FINDINGS.md#direction-structure)<br>[`holds-outside-view`](FINDINGS.md#direction-structure)  |
| `absent-subject`        | A subject missing from its endpoint `lineup` / `lineupTo` or from `passing`, or a shown prop missing from `props`. | [`lineup-gap`](FINDINGS.md#direction-findings)<br>[`props-missing`](FINDINGS.md#direction-structure)             |
| `illegible-jump`        | A `jump-back` / `jump-forward` join no neighbouring shot lets a viewer read.                                       | [`location-backtrack`](FINDINGS.md#direction-findings)                                                           |
| `unrostered-set`        | An `action` names a thing of the set its location's `landmarks` does not hold.                                     | —                                                                                                                |
| `unnamed-presence`      | The staging requires a figure no shot names and no roster holds.                                                   | —                                                                                                                |
| `out-of-scope`          | An `action` asks for what `brief.outOfScope` bans.                                                                 | —                                                                                                                |
| `lost-keep`             | An item of `brief.source.keep` no shot puts on screen.                                                             | —                                                                                                                |

## konte-staging-critic

Reviews Pending panel prompts in `animatic.tsx`, against their action, plates and neighbours.

| Code               | Checks                                                                                                           | Machine                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `lineup-only`      | The prompt says only who is on which side, leaving facing and the rest of the frame to the model.                | —                                                        |
| `hides-action`     | A `hinge:` is peripheral, hidden, too small, off-path or implausibly placed.                                     | —                                                        |
| `flat-run`         | Adjacent panels repeat size, height, placement and facing with no job, or a run uses one formula.                | —                                                        |
| `direction-break`  | A side or facing flips across a cut with no move or jump join, or a gaze misses its target or `offscreen:` side. | —                                                        |
| `set-clash`        | A figure placed where the plate's landmark stands, or a part of the place the plate does not show.               | [`landmark-unheld`](FINDINGS.md#stage-and-take-findings) |
| `view-turned`      | The plate faces another way than the view image its setup stands on.                                             | —                                                        |
| `off-plate-camera` | The prompt names a size or camera height the plate does not have.                                                | —                                                        |
| `contact-unsaid`   | The parts where one object meets another are unsaid.                                                             | —                                                        |
| `contradiction`    | Two parts of the prompt place or turn the same figure differently.                                               | —                                                        |

## konte-prompt-critic

Reviews one stage's pending prompts, as text, before the first spend on it.

| Code                       | Checks                                                                                           | Machine                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `named-exclusion`          | A prompt names something to leave out, in a model that does not read it as an omission.          | [`prompt-negation`](FINDINGS.md#stage-and-take-findings)<br>[`prompt-double-negative`](FINDINGS.md#stage-and-take-findings) |
| `inconsistent-description` | The same prop, surface, costume or movement is worded differently in two shots.                  | —                                                                                                                           |
| `reference-contradicted`   | A reference held as it stands, then its subject written in another state, count or size.         | —                                                                                                                           |
| `size-unmeasured`          | A recurring object a character meets is not sized against the body.                              | —                                                                                                                           |
| `restated-frame`           | A motion prompt re-describes the composition its keyframe fixes.                                 | —                                                                                                                           |
| `model-pitfall`            | The prompt asks for what the model is known to drop.                                             | —                                                                                                                           |
| `time-talk`                | A still's prompt describes what has yet to happen.                                               | [`prompt-not-yet`](FINDINGS.md#stage-and-take-findings)                                                                     |
| `landed-opening`           | An `opening` keyframe already holds the change the shot's `action` lands.                        | —                                                                                                                           |
| `under-directed-voice`     | A spoken line's manner is listed as acoustics, or left to its voice reference.                   | —                                                                                                                           |
| `undetermined-reading`     | A line's written form leaves open a reading orthography settles.                                 | —                                                                                                                           |
| `unstable-reading`         | A word no reliable reading attaches to, not respelled at the take.                               | —                                                                                                                           |
| `unexpanded-token`         | A numeral, date, unit or abbreviation not spelled out at the take.                               | —                                                                                                                           |
| `lineup-mismatch`          | A subject written into another place than the `lineup:` line puts them, or one it does not hold. | [`subject-unnamed`](FINDINGS.md#direction-findings)                                                                         |
| `set-mismatch`             | A subject on the wrong side of the `set:` line's landmarks, or a listed landmark moved.          | [`landmark-unheld`](FINDINGS.md#stage-and-take-findings)<br>[`landmark-unnamed`](FINDINGS.md#direction-findings)            |
| `body-relative-side`       | A worn or carried object placed by the figure's own left or right.                               | —                                                                                                                           |
| `acting-dropped`           | A spoken line's prompt drops the delivery its `acting:` note asks for.                           | —                                                                                                                           |
| `out-of-scope-object`      | The prompt names a thing `brief.outOfScope` keeps off screen, even as unseen.                    | —                                                                                                                           |
| `unchained-beat`           | In a coverage take, a beat that does not open on where the last one lands.                       | —                                                                                                                           |
| `missing-detail-cuts`      | In a coverage take, the quick detail cuts are not written as a beat of the body.                 | —                                                                                                                           |
| `unwritten-grammar`        | In a coverage take, the piece's own motion grammar is not written in.                            | —                                                                                                                           |
| `contact-unmarked`         | In a coverage take, a contact does not restate the feature telling the two figures apart.        | —                                                                                                                           |
| `off-length`               | A coverage take outside the adapter guide's length range.                                        | —                                                                                                                           |
| `view-instant-missing`     | A view entry's `summary` is not that picture's instant.                                          | —                                                                                                                           |
| `view-unmeasured`          | A view's camera height and what is in frame are not written in things the master shows.          | [`view-unnamed`](FINDINGS.md#direction-findings)                                                                            |
| `view-relaid`              | A view lays the room out again wall by wall.                                                     | —                                                                                                                           |
| `view-unbuilt`             | A view does not write the build of what the master does not show.                                | —                                                                                                                           |
| `occupied-plate`           | A `plates` entry's prompt puts a subject, a pose or an action in the frame.                      | —                                                                                                                           |

## konte-animatic-critic

Reviews one board's panels and lines, as a first-time viewer, and its plates.

| Code                 | Checks                                                                                                               | Machine                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `weak-hook`          | Nothing to want answered in the first panel.                                                                         | —                                                           |
| `misread-shot`       | A panel reads as another subject or event than its `action`, or a passer at an endpoint.                             | —                                                           |
| `invisible-change`   | No panel shows the shot's change landed, or starting where it should.                                                | —                                                           |
| `absent-subject`     | A panel does not hold someone its `lineup` / `lineupTo` or `action` needs.                                           | —                                                           |
| `lineup-misplaced`   | The frame holds them in another order than the `lineup`.                                                             | —                                                           |
| `jump-cut`           | An adjacent pair changing neither size nor angle, with no job and no `join`.                                         | —                                                           |
| `axis-break`         | An adjacent pair swapping a subject's side or direction.                                                             | —                                                           |
| `continuity-drift`   | A recurring thing that changes across panels — possession, holding hand, size against the body, posture, the ledger. | —                                                           |
| `contact-off`        | The part a contact needs faces away, falls short or sits elsewhere.                                                  | —                                                           |
| `look-drift`         | A panel whose palette, register or scale breaks from the board.                                                      | —                                                           |
| `wrong-speaker`      | A line playing over a picture that does not carry its speaker or its shot.                                           | —                                                           |
| `line-misplaced`     | A line outside its shot's window, or on the wrong instant of it.                                                     | [`line-truncated`](FINDINGS.md#stage-and-take-findings)     |
| `flat-ending`        | A last panel that carries nothing.                                                                                   | —                                                           |
| `fabricated-ui`      | A real product's screen showing what that product never displays.                                                    | —                                                           |
| `thin-coverage-note` | A coverage shot's `blocking` / `camera` stops short of the shot.                                                     | [`movement-unwritten`](FINDINGS.md#stage-and-take-findings) |
| `plate-mismatch`     | A plate misses a landmark its `set:` line lists, or holds another of the place.                                      | —                                                           |
| `unplaced`           | Nothing in a plate fixes the location.                                                                               | —                                                           |
| `occupied`           | A figure or a pose in a plate.                                                                                       | —                                                           |
| `unstyled`           | A plate with no line, texture or object of the piece's look.                                                         | —                                                           |
| `off-framing`        | A plate is not the size its setup declares.                                                                          | —                                                           |
| `view-drift`         | A view image builds, places or lights the location differently from its master.                                      | —                                                           |

## konte-video-critic

Reviews motion takes and compositions against their action and accepted board.

| Code             | Checks                                                                                         | Machine |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------- |
| `never-moved`    | The ask moved and no tile differs.                                                             | —       |
| `action-missed`  | The change the `action` names is on no tile, or another event is.                              | —       |
| `wrong-mover`    | Wrong mover, an unexplained appearance, disappearance or doubling, or a passer at an endpoint. | —       |
| `hinge-lost`     | A required `hinge` is absent.                                                                  | —       |
| `eyeline-off`    | A gaze toward a figure out of frame turned to another side than `offscreen`, or into the lens. | —       |
| `camera-off`     | The camera does other than `camera` asks, or the picture cuts inside a non-coverage take.      | —       |
| `endpoint-off`   | The first or last tile is not the panel the take was built on.                                 | —       |
| `contact-off`    | At the contact's tile, the part it needs is turned away, short, or moved on the object.        | —       |
| `morph`          | An identity, a hand or an object changing through the tiles.                                   | —       |
| `seam-break`     | Across a boundary, a change its `join` does not allow.                                         | —       |
| `beat-dropped`   | On a coverage shot, an `action` beat on no tile.                                               | —       |
| `frozen-stretch` | On a coverage shot, a stretch of tiles that stops moving.                                      | —       |
| `identity-swap`  | On a coverage shot, the two figures' telling feature swaps or doubles at a contact.            | —       |
| `insert-flood`   | Inserts crowd out the exchange.                                                                | —       |
| `tail-damage`    | The last tiles smear.                                                                          | —       |
| `half-speed`     | The action slower than life.                                                                   | —       |
| `drift`          | A camera floating where `camera` asked for a lock.                                             | —       |
