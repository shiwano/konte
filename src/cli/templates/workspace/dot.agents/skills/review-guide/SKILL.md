---
name: review-guide
description: Put work in front of a human and get a decision back — write the handoff, open the preview, read the submitted record. Read whenever you are about to show the human something to accept (the direction or a stage's assets), and when their review comes back.
user-invocable: false
---

Every human review runs the same three steps — hand off, preview, read the record — for the direction or a stage's assets. Done = the submitted decisions read back and reported to the human; acting on the feedback belongs to whoever sent you here (`drafting-guide` for direction, `generation-loop-guide` for a stage).

## 1. Hand off

Leave a note the reviewer reads inline next to each changed item — what you changed and why.

- **One shot: `konte review handoff new <scope> --summary "<line>" --note <address>=<text> …`** — writes the whole handoff. `--note` repeats and splits on the first `=`; an unknown address is rejected, listing the changed assets.
- **Or omit `--note`** — writes `review/<stage>/handoffs/<ts>.json` with an empty `text` per changed asset; fill each `text` and `summary`, drop rows you have nothing to add. Nothing changed → no file.
- **Write summary and notes in the human's language** — they show in the review UI.
- **Never delete or overwrite an earlier handoff file** — each run writes a new timestamped one and preview auto-loads only the newest for the stage (override with `--handoff <path>`).

## 2. Preview

- **Before the first preview, ask once per session whether they review on this machine or another device** — preview opens its browser on this machine. Their answer holds for the session.
- **This machine → no flag; another device → `--tunnel`** — a public https URL on the startup line, with a 4-digit PIN they must enter. Hand them both; it dies with the command.
- **`konte preview <scope>` opens the browser itself and runs until the human submits or closes it** — run it in the background without extra confirmation; never open a browser yourself or start a second one while it's up.
- **Then run the `konte review wait` command it prints** — returns once the review ends; if interrupted, rerun it. Background it if your harness notifies you when a background command exits; otherwise **never close a turn while it has not returned**.
- **An idle, unanswered preview is normal** — don't kill it, and don't `konte job wait` on it.
- **What the human sees** — per part for `direction`; a flat pool grouped by media kind for `reference`; per shot for `animatic`/`video` (accept toggle + pin/text comments; a pin (`x`/`y` 0-1 of the frame) captures the frame as `[image: <path>]`). The soundtrack is its own target: comments land on `timeline#stem`, timed, never pinned.
- **A video shot badged `Animatic: not made yet` is standing in with the board** — its picture has not been generated, so it has nothing to sign off and its toggle is closed. Comments stay on the shot and survive into the finished take.

## 3. Read the record

- **Once `review wait` returns, read the backgrounded `konte preview`'s exit line** — one of `submitted` (followed by the `konte review record show` command that reads it, then any `konte generate` to run), `submitted, but nothing to record (no changes)`, or `not submitted (closed without submitting)`.
- **`konte review record show <file>`** — every decision the review made, plus any target the submit could not settle and, for `direction`, where the acceptance gate stood at submit.
- **Read it whole** — never `head`/`tail` it; a cut drops the human's comments silently.
- **`--contact-sheet` tiles every commented frame into one image** — cells captioned with comment id + shot-local time. Triage only: judge any single comment off its own `[image: <path>]`.
- **Report the decisions — accepts, feedback, pin coordinates — to the human before acting.**

## What a submitted review means

- **It may be partial** — targets the human didn't touch are unchanged, **not** implicitly accepted; reconcile with `konte status`.
- **A stage accept signs off the direction** — accepting a shot accepts the `direction:` parts describing it (its own, and the acts bracketing it), shown under Accepted as `direction:… (via <stage>:shot.<id>)`.
- **There is no "reject"** — a target needing work is one they left **feedback** on and did **not** accept. The comment is the instruction; act on it.
- **Accepted with a comment on it — read the comment, not the toggle** — an accept also releases what waits on it (a spend gate), so it is pushed to keep work moving as often as to mean "going with this". A comment asking for a change is the instruction, accept or no; one that only reacts leaves the accept as the verdict. `konte status` stops counting it either way.
- **An `Overall:` comment belongs to no target** — it is an instruction like any other; act on it.
- **Unaccepted with no comment is a deliberate hold** — submit listed it and the human went ahead anyway. Don't regenerate or guess: ask, or carry it forward.
