# Findings

<!-- Generated from src/core/findings-doc.ts by `bun run build:generate-findings-doc`. Do not edit by hand: src/core/__tests__/findings-doc.test.ts fails when this file and the code disagree. -->

Every machine finding konte reports. An unwaived one aborts a spend; clearing it means fixing it, or waiving it with the reason it is right, which a reviewer reads.

## Direction findings

Reported by the direction check over `direction.ts` and the stages built on it. An unwaived one aborts a spend with `DIRECTION_CHECK_FAILED`. A waiver sits in the `waivers` of the arc node the finding fired on, keyed `<code>` or `<code>_<subject>`.

- **Deferred** — silent until the direction is accepted.
- **Fix in `reference.tsx`** — the roster entry is right; a reference asset is missing.
- **Fix in `animatic.tsx`** — the direction is right; a keyframe's input is missing.
- **Type-level** — a literal value is also a type error, so it stops at the startup type-check; a computed value reaches the finding instead.

### arc (10)

Gates: every spend.

| Code                    | Flags                                                                                                    | Waiver subject          | Notes      |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------- | ---------- |
| `missing-role`          | A role its lens requires has no item.                                                                    | role                    | —          |
| `no-payoff`             | No item takes the lens's payoff role.                                                                    | —                       | —          |
| `role-out-of-order`     | A role appears before one its lens places earlier.                                                       | role that arrived early | —          |
| `lens-role-mismatch`    | An item's role is not one its node's lens declares.                                                      | item id                 | Type-level |
| `too-many-consecutive`  | More items of one role in a row than its `maxConsecutive`.                                               | role                    | —          |
| `too-few-consecutive`   | A role's longest run is shorter than its `minConsecutive`.                                               | role                    | —          |
| `empty-synopsis`        | A shot's `action` or a child node's `synopsis` is empty.                                                 | item id                 | Type-level |
| `unearned-payoff`       | The payoff lands before any item grounds, turns or builds toward it.                                     | payoff role             | —          |
| `unexpected-script`     | A shot's `script` contradicts `policy.speech`: any line under `none`, a spoken line under `no-dialogue`. | shot id                 | Type-level |
| `multi-sentence-action` | A shot's `action` reads as two or more sentences.                                                        | shot id                 | —          |

### pacing (4)

Gates: every spend.

| Code                  | Flags                                                                                                                   | Waiver subject | Notes      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- |
| `role-overweight`     | A role holds more of the runtime than its `maxShare`.                                                                   | role           | —          |
| `role-underweight`    | A role holds less of the runtime than its `minShare`.                                                                   | role           | —          |
| `off-grid-duration`   | A shot's `duration` is not a positive multiple of 0.5s, or on `policy.song` its `beats` is not a positive whole number. | shot id        | Type-level |
| `re-established-wide` | A shot re-establishes a location already shown wide.                                                                    | shot id        | —          |

### stage (2)

Gates: every spend.

| Code                   | Flags                                                        | Waiver subject | Notes      |
| ---------------------- | ------------------------------------------------------------ | -------------- | ---------- |
| `stage-order-mismatch` | A stage realizes the direction's shots in a different order. | —              | Type-level |
| `song-overrun`         | The timeline runs on past the end of the take of the song.   | —              | —          |

### completeness (1)

Gates: `export` (video).

| Code         | Flags                                         | Waiver subject | Notes      |
| ------------ | --------------------------------------------- | -------------- | ---------- |
| `unrealized` | A direction shot that no stage shot realizes. | shot id        | Type-level |

### characters (8)

Gates: every spend. Deferred.

| Code                           | Flags                                                             | Waiver subject | Notes                  |
| ------------------------------ | ----------------------------------------------------------------- | -------------- | ---------------------- |
| `character-unreferenced`       | A character a frame's lineup holds has no `reference:<id>` asset. | character id   | Fix in `reference.tsx` |
| `unused-character`             | A character is named in no shot action and speaks no line.        | character id   | —                      |
| `character-voice-missing`      | A character speaks but casts no `voice`.                          | character id   | —                      |
| `character-voice-unreferenced` | A character's voice has no `reference:<id>` sample.               | character id   | Fix in `reference.tsx` |
| `unused-character-voice`       | A character has a voice but no script line.                       | character id   | —                      |
| `narrator-missing`             | The direction has narration lines but casts no `narrator`.        | —              | —                      |
| `narrator-unreferenced`        | The narrator's voice has no `reference:<id>` sample.              | —              | Fix in `reference.tsx` |
| `unused-narrator`              | A narrator is cast but no shot declares a narration line.         | —              | —                      |

### props (2)

Gates: every spend. Deferred.

| Code                | Flags                                 | Waiver subject | Notes                  |
| ------------------- | ------------------------------------- | -------------- | ---------------------- |
| `prop-unreferenced` | A prop has no `reference:<id>` asset. | prop id        | Fix in `reference.tsx` |
| `unused-prop`       | A prop is named in no shot action.    | prop id        | —                      |

### locations (2)

Gates: every spend. Deferred.

| Code                    | Flags                                           | Waiver subject | Notes                  |
| ----------------------- | ----------------------------------------------- | -------------- | ---------------------- |
| `location-unreferenced` | A location has no `reference:<id>` asset.       | location id    | Fix in `reference.tsx` |
| `unused-location`       | No setup a shot points at is set in a location. | location id    | —                      |

### setups (2)

Gates: every spend. Deferred.

| Code               | Flags                                                            | Waiver subject           | Notes |
| ------------------ | ---------------------------------------------------------------- | ------------------------ | ----- |
| `unused-setup`     | No shot points at a setup.                                       | setup id                 | —     |
| `setup-indistinct` | Two setups declare the same location, framing and `holds` order. | setup id (the later one) | —     |

### staging (12)

Gates: every spend.

| Code                   | Flags                                                                                                                                                                                                              | Waiver subject                         | Notes                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | --------------------- |
| `lineup-flipped`       | A `lineup` reverses a left-to-right order an earlier shot set in that location, and no shot between them declares the move.                                                                                        | frame (`<shotId>` or `<shotId>.cutin`) | —                     |
| `lineup-gap`           | A frame's two ends skip someone the location places between them.                                                                                                                                                  | frame                                  | —                     |
| `lineup-vacuous`       | A `lineupTo` repeats its `lineup`.                                                                                                                                                                                 | frame                                  | Type-level            |
| `lineup-inconsistent`  | The order accumulated in a location forms a cycle.                                                                                                                                                                 | frame                                  | —                     |
| `character-unconsumed` | A keyframe framing a character is built from no reference to them.                                                                                                                                                 | `<frame>.<characterId>`                | —                     |
| `location-unconsumed`  | No keyframe of a frame is built from a reference to the location it is set in.                                                                                                                                     | frame                                  | Fix in `animatic.tsx` |
| `slot-order-mismatch`  | A keyframe passes its reference images in an order its `lineup` does not declare.                                                                                                                                  | frame                                  | —                     |
| `landmark-flipped`     | Two setups of one location disagree on the left-to-right order of its landmarks.                                                                                                                                   | setup id                               | —                     |
| `subject-unnamed`      | No prompt behind a keyframe contains the `promptDepiction` of a subject it frames, verbatim (case-insensitive).                                                                                                    | `<frame>.<characterId>`                | —                     |
| `join-lineup-mismatch` | A `continuous` shot opens on a different order than the shot before it leaves.                                                                                                                                     | frame                                  | —                     |
| `join-unpinned`        | The video take before a `continuous` seam does not pin its end to the opening keyframe of the shot after it, where its model has an end slot.                                                                      | frame                                  | —                     |
| `join-unshown`         | A take pinned to a `continuous` seam is played off that frame: the take before does not cut on the frame its end image lands on, or the take after does not open its shot on its first (`mediaStart`, `duration`). | frame                                  | —                     |

### typesetting (1)

Gates: every spend.

| Code               | Flags                                                                             | Waiver subject | Notes |
| ------------------ | --------------------------------------------------------------------------------- | -------------- | ----- |
| `fonts-undeclared` | `policy.lang` is in a script no default face covers, and `policy.fonts` is empty. | —              | —     |

## Stage findings

Reported over the prompt and pin inputs a stage or a patch declares. An unwaived prompt finding aborts a spend with `PROMPT_CHECK_FAILED`, a pin finding with `PIN_CHECK_FAILED`. A waiver sits in the `waivers` of `defineReference`, `defineAnimatic` or `defineVideo`, keyed `<code>:<hash>` as `konte status` prints it.

| Code                     | Flags                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `prompt-negation`        | A prompt names something to leave out.                                                                                 |
| `prompt-not-yet`         | A prompt describes what has not happened: time talk in a still, or a state to hold where a motion prompt needs a move. |
| `prompt-double-negative` | A `negativePrompt` names an exclusion negatively, which cancels it.                                                    |
| `pin-unanchored`         | A pin input takes a reference sheet instead of a frame of the picture.                                                 |
