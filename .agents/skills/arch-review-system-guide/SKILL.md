---
name: arch-review-system-guide
description: Read when touching reviews, feedback comments or handoffs — how each is stored, snapshotted per stage, and goes stale.
user-invocable: false
---

## Reviews

- A review is a snapshot of one `stage` at preview time — the variants shown plus the human's decisions and feedback — stored under `review/<stage>/records/` (its file id elides that segment, e.g. `video/<timestamp>`), read with `konte review record list` / `review record show`.
- A verdict can fail to land — an unwritten review prerequisite, a variant pruned since the page loaded, a cast reference (which the board locks in both directions, an un-accept included). Every submit handler returns those as `skippedDecisions`, and the client throws on a 200 carrying any: unsaved keeps the page open to retry, saved ends the session with drafts cleared.
- The record names skipped decisions beside the decisions even when a skip is its only outcome; the dropped accept's own entry carries no status.
- Every submit passes through one dialog (`review-shell.tsx`); the button only raises it, and an empty review disables the dialog's Submit, not the button.
- The dialog names what was left with neither an accept nor a live comment (`undecided.ts`), by the reviewer's unit — a shot on the reels, a section on the direction — and never blocks on it. One live comment inside the unit settles it; accepts stay per target.
- An unaccepted, uncommented target is a deliberate hold: re-preview or ask, don't regenerate.
- The dialog also takes the overall comment (`overallComment`), which alone makes a review worth saving and stands as feedback on the bare stage (`video`) until its next review.

## Keep or regenerate

- An accept moving accepted takes' upstream asks Keep or Regenerate (`review/keep-or-regenerate.ts`): one row per accepted unit made from what it changes, Keep by default.
- Submit keeps a Keep row's takes while the upstream it saw stands, and dismisses a Regenerate row's for `generate`, with the row's follows: the accepted same-stage units made from it through no other row.
- A row made from a Regenerate row keeps and is asked again at that row's accept, or regenerates and waits on it.
- The list's Regenerate mark is taken back by its x; a follow's title names its row.

## UI text

- No em dash (`—`) in what a human reads on screen: JSX text and `title` / `aria-label` / `placeholder` under `src/pages/`.
- Use `:` between a name and its detail (`Shot 01: 3s`), a full stop between sentences, a comma for an apposition.
- Comments and CLI output are exempt.

## Reachability

- Every address `status` asks a verdict on is one some surface lands.
- `shotAcceptTargets` (`core/shot-accept-targets.ts`) is the one enumeration of what a shot's decision covers on either reel stage — picture takes, stem sources, materialized leaves, and (on the animatic) its mixed-down stem. The submit accepts from it and its post-condition reads back against it; an address outside `stageReviewDecidableAddresses` is reported under Problems as a konte bug.
- A cascade walks through an accepted dep instead of stopping at it (`accept-cascade.ts`) — a sign-off never depends on the order takes were accepted in. This holds after the audio, cast, prerequisite and finding exclusions, which mark subtrees another surface owns and an accept on the boundary must not open.
- A stale deterministic accept is no verdict — the take the root consumed replaces it.
- A verdict is only offered where it lands: a video shot standing in with the board carries none.
- Tested as a loop (`preview/__tests__/review-closure.test.ts`): review everything on offer, generate what that releases, repeat; nothing may be left under "Needs review" and no shot behind the gate.

## Which take a surface shows

- The server sends the take each address resolves to, so `variantStatus` reads `accepted` only when that take is the accepted one (konte's own accept stops resolving once stale).
- The browser swaps in the newest undecided take beside an accept; a gallery pick beats both, and an accept acts on the take shown.

## Feedback

- Human comments attach to any target, with or without variants, and snapshot what the reviewer perceived there. Managed with `konte review feedback`, stored per stream in `review/<stage>/feedback.json`.
- The reel client sends only where one was written plus what it displayed page-wide — `compositionRefVariants` included, the take behind every address a composite draws, which the page's own asset arrays cannot name.
- The handler derives the subject (`commentSubjectAddresses`): a shot's `compositionRefs` (what it references, not what it declares) plus its composition and stem; `timeline#stem`'s is `timelineStemRefs`, the beds. A video shot showing the board derives from the animatic's shot.
- A target the stage does not hold fails the submit.
- A leaf the definition holds that the page reported no hash for records `null` (the definition moved mid-review), read as `unknown`; one the page showed that the definition has since dropped keeps the hash it reported, which finds no current value and reads stale.
- A timed video shot note carries a composition frame, cached in the shot composition's own thumbnail dir: notes at one instant share a frame, and `clean` / `prune` reclaim them with that cache.
- Nothing records the frame's path — `feedbackFramePath` derives it; the composition hash covers the HTML and its inputs' `outputHash`, so a frame found is of the shot as it stands. Only `review record show` renders a missing one (`resolveShotFeedbackFrames`, a session per shot, tiled by `--contact-sheet`).

### When a comment stops standing

`status`, `inspect`, `feedback list` (`--verbose` keeps it) and the review UI all drop a comment `feedbackStaleness` reads `stale`. It answers `fresh`, `stale` or `unknown` (an axis the caller supplied no context for); never collapse `unknown` — into `fresh` it reports a comment standing however far its subject moved, into `stale` it drops what nobody answered.

A comment goes stale two ways:

- Its subject moved — the variants shown no longer match its snapshot, or, where a fix moves no take (a rewritten panel `blocking`/`camera`, a composition edit), the live hash it also snapshotted in `displayedDefinitionHashes` no longer does (a video leaf's definition, a panel's movement per `panel-move-hash`). One map holds both (`liveDefinitionHashes`), supplied whole or not at all; no context makes the axis `unknown`, as does a take whose own `definitionHash` no registered definition can be measured against.
- The reviewer signed off over it (`signedOffOver`) — the target carries an accept stamped at or after the comment. A review has no "reject"; accepting over a standing comment is the verdict "going with this".

Sign-off details:

- A whole-shot target has no variant: its sign-off is every half it has — the composition, and the stem where the shot sounds anything (read off the comment's own `displayedDefinitionHashes`, which carries the stem address exactly when the shot sounded something as written). Both, since nothing says which half a comment is about.
- The direction reads its per-part acceptance.
- A review stamps its comments and record with one `reviewedAt` before its accepts, so its comments compare as written first. Off the review UI (`reviewerView`) they stand until the stage's next review.
- A `konte accept` from the CLI closes each standing comment it signs off over (`closedAt`) and names it.
- The record's `stale` is snapshotted before the decisions too (`staleFlagsBeforeDecisions`), so it still shows the comment its accept was made against.

A direction comment snapshots a `subjectHash` (the stage is media-less) — the content hash of the direction part it was written on (`directionPartHashes`, which unlike the acceptance hash covers prose too). It goes stale once that shot / act / roster entry / waiver reads differently or leaves the direction; a reader with no part hashes reads it `unknown`, so every command judging one loads the direction.

## Handoff

- A handoff's notes (`review/<stage>/handoffs/<ts>.json`, `HandoffSchema`) record why a revision was made — address + text.
- `konte preview <stage> --note <address>=<text>` writes one before the server starts, and refuses an address the stage does not hold.
- A reel stage's shot note is keyed by the shot (`<stage>:shot.<id>`); an address naming one of the shot's assets is filed under it. A note no shot shows (a plate's, the timeline's) rides the summary banner under its address.
- Without `--note`, preview shows the newest handoff unless a record already holds its `handoffId`, and reloads it on edit; a submit copies it into the record.

## Audio accept (stems)

Audio is signed off in context, through stems (what a stem is: `arch-audio-guide`); a picture composition accept skips audio deps.

- Per-shot audio (`shot.<id>#stem`) folds into the shot accept — one gesture takes the composition and the stem, and the stem accept cascades its audio sources (the shot's `<Audio>`/`<Video hasAudio>` takes), giving each a staleness baseline. In the UI an audio cue reads its shot's accept, like a visual clip.
- Timeline beds (`timeline#stem`) get one accept, which cascades the `soundtrack()` sources — a reference bgm bed included, so the soundtrack accept in the video review signs off the bgm at its asset level too.
- Take selection stays in the reference review: accepting a bgm reference there picks the take; the stem accept is the in-context sign-off.
- Characters are the one consumed dep never cascaded — accepted only in `konte preview reference`.
- Comments route the same way: a per-shot audio note goes on its shot, a bed note on `timeline#stem` — the video review's one comment target that is not shot-scoped, selected by picking the Soundtrack card or a bed clip. It carries a playhead time but no pin, and its subject is the mix's own inputs, so it goes stale when a bed switches take.
