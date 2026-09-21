---
name: revision-guide
description: Reopen an accepted or exported piece — fix only the shots the human reopens, then re-export. Read when the human wants to improve, fix or redo parts of a finished piece.
user-invocable: false
---

Take an accepted or exported cut through the changes the human picks, and nothing else. Done = every shot accepted again, and a new export; making a take good is `generation-loop-guide`'s.

## Routing

- **They want to watch the cut and point at the changes themselves** → skip §2.
- **They already named the changes in chat** → skip §2 and §3; fix them (§4), then show them in one review.
- **They ask you for candidates** → §2, then §3.
- **They ask for a finishing pass on the compositions** — rhythm, text, sound → `polish-guide`.
- **A new shot, a cut shot, a restructure** → `drafting-guide`, then `layout-guide`.

## 1. Read what is already decided

- **`konte probe export`** — the last deliverable and whether it is out of date.
- **`konte review feedback list --verbose`** — every earlier comment, stale ones included. A stale comment that removed or changed something is still the human's decision.
- **A decision that lives only in a comment goes into the definition now** — the shot's `action` in `direction.ts`, the panel's prompt. A definition still describing what the human removed makes the audit or a critic flag it back; the decision wins over the finding.

## 2. Audit the reel

Only what can be counted.

- **Seams first** — `konte probe contact-sheet video` pairs each shot's out frame with the next one's in frame: a background, prop, mark or pose that differs across a cut the direction does not break.
- **Then each take against its shot** — `konte probe motion video`, `konte probe reel-audio video`.
- **Class each candidate by the cheapest layer that fixes it** — `generation-loop-guide` step 5's routing: composition (free), a take, the board and its take, the direction.
- **Generate nothing yet.**

## 3. Open the accepted cut in review

- **`review-guide`, scope `video`** — with candidates, one note per candidate on its shot, class and spend in the note; without, no handoff.
- **A candidate they leave accepted with no comment is kept.**

## 4. Fix in stage order

- **Direction first** — lines, `duration`, `telop`, what a shot shows → `direction-guide`.
- **Then the board for every shot whose panel or stem moved, then the motion.**
- **Then the composition** — `<Animate>`, text, windows, sound → `composition-guide`.
- **Touch only reopened shots** — an accepted take reading stale because a shared plate or stem moved under it stays accepted.
- **`Kept against newer upstream` in a record is the human's keep** — don't reroll it. Where the change breaks what it shows (a line its mouth no longer speaks), say so and ask.
- **A `duration` change moves the cut** — read the seam on both sides again.
- **Every reopened shot back through one review** — as in §3.

## 5. Re-export

- **`export-guide`.**
