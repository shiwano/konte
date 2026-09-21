---
name: arch-review-system-guide
description: Read when touching reviews, feedback comments or handoffs — how each is stored, snapshotted per stage, and goes stale.
user-invocable: false
---

## Reviews

A review is a snapshot of one `stage` at preview time — the variants shown plus the human's decisions and feedback — stored under `review/<stage>/records/` (its file id elides that segment, e.g. `video/<timestamp>`) and read with `konte review record list` / `review record show`.

A verdict can fail to land — an unwritten review prerequisite, a variant pruned since the page loaded, a cast reference (which the board locks in both directions, an un-accept included). Every submit handler returns those as `skippedDecisions` and the client **throws on a 200 carrying any**: unsaved keeps the page open to retry, saved ends the session with drafts cleared. The record names them beside the decisions even when a skip is its only outcome, and the dropped accept's own entry carries no status.

Every submit passes through one dialog (`review-shell.tsx`); the button only raises it, and an empty review disables the dialog's Submit rather than that one. It names what was left with neither an accept nor a live comment (`undecided.ts`) and never blocks on it, by the reviewer's unit — a shot on the reels, a section on the direction — one live comment inside the unit settling it, accepts staying per target. So an unaccepted, uncommented target is a **deliberate hold**: re-preview or ask, don't regenerate. It also takes the **overall comment** (`overallComment`), which hangs off no address and alone makes a review worth saving.

## Keep or regenerate

An accept moving accepted takes' upstream asks Keep or Regenerate (`review/keep-or-regenerate.ts`): one **row** per accepted unit made from what it changes, Keep by default. Submit keeps a Keep's takes while the upstream it saw stands and dismisses a Regenerate's for `generate`, with the row's **follows**: the accepted same-stage units made from it through no other row. A row made from a Regenerate row keeps and is asked again at that row's accept, or regenerates and waits on it. The list's Regenerate mark is taken back by its x; a follow's title names its row.

## UI text

No em dash (`—`) in what a human reads on screen: JSX text and `title` / `aria-label` / `placeholder` under `src/pages/`. Use `:` between a name and its detail (`Shot 01: 3s`), a full stop between sentences, a comma for an apposition. Comments and CLI output are exempt.

## Reachability

**Every address `status` asks a verdict on is one some surface lands.** `shotAcceptTargets` (`core/shot-accept-targets.ts`) is the one enumeration of what a shot's decision covers on either reel stage — picture takes, stem sources, materialized leaves, and (on the animatic) its mixed-down stem. The submit accepts from it, its post-condition reads back against it, and an address outside `stageReviewDecidableAddresses` is reported under **Problems** as a konte bug.

Two rules keep it true. A cascade walks **through** an accepted dep instead of stopping at it (`accept-cascade.ts`), so a sign-off never depends on the order takes happened to be accepted in — after the audio, cast and prerequisite exclusions, which mark subtrees another surface owns and which an accept on the boundary must not open. And a verdict is only ever offered where it lands: a video shot standing in with the board carries none, since what is on screen belongs to the stage upstream.

**Tested as a loop, never one pass** (`preview/__tests__/review-closure.test.ts`): review everything on offer, generate what that releases, repeat, and demand nothing is left under "Needs review" and no shot behind the gate.

## Which take a surface shows

The server sends the take each address resolves to, so `variantStatus` reads `accepted` only when that take is the accepted one (konte's own accept stops resolving once stale). The browser swaps in the newest undecided take beside an accept; a gallery pick beats both, and an accept acts on the take shown.

## Feedback

Human comments attach to any target, with or without variants, and snapshot what the reviewer perceived there. Managed with `konte review feedback`, stored per stream in `review/<stage>/feedback.json`.

The reel client sends only WHERE one was written plus what it displayed page-wide — `compositionRefVariants` included, the take behind every address a composite draws, which the page's own asset arrays cannot name. The handler derives the subject (`commentSubjectAddresses`): a shot's `compositionRefs` — what it REFERENCES, not what it declares, which both misses a frame drawn from elsewhere and holds an `asset()` never placed — plus its composition and stem; `timeline#stem`'s is `timelineStemRefs`, the beds. A video shot showing the board derives from the ANIMATIC's shot, since that is what is drawn.

A target the stage does not hold fails the submit. A leaf the definition holds that the page reported no hash for records `null` (the definition moved mid-review), read as `unknown`; one the page showed that the definition has since dropped keeps the hash it reported, which finds no current value and reads stale.

A timed video shot note carries a composition frame, cached in the shot composition's own thumbnail dir: notes at one instant share a frame, and `clean` / `prune` reclaim them with that cache. Nothing records the path — `feedbackFramePath` derives it, and the composition hash covers the HTML **and** its inputs' `outputHash`, so a frame found is of the shot as it stands. Only `review record show` renders a missing one (`resolveShotFeedbackFrames`, a session per shot, tiled by `--contact-sheet`).

A comment **stops standing** two ways, and no reader distinguishes them: `status`, `inspect`, `feedback list` (`--verbose` keeps it, printing text, pin and time) and the review UI all drop it. Both read as `stale` from `feedbackStaleness`, which answers **three** ways — the third is `unknown`, an axis the caller supplied no context for. Only `stale` answers a comment: a reader that collapses `unknown` into `fresh` reports one as still standing however far its subject has moved, and one that collapses it into `stale` drops what nobody answered.

- **Its subject moved.** The variants shown no longer match its snapshot, or — where a fix moves no take, a rewritten panel `blocking`/`camera` or a composition edit — the live hash it also snapshotted in `displayedDefinitionHashes` no longer does (a video leaf's definition, a panel's movement per `panel-move-hash`). One map for both (`liveDefinitionHashes`), supplied whole or not at all; no context makes the axis `unknown`, as does a take whose own `definitionHash` no registered definitions can be measured against.
- **The reviewer signed off over it** (`acceptedOver`): the target carries an accept stamped at or after the comment. A review has no "reject" — a target needing work is left unaccepted — so accepting over a standing comment is the verdict "going with this". A whole-shot target has no variant: its sign-off is EVERY half it has — the composition, and the stem where the shot sounds anything (read off the comment's own `displayedDefinitionHashes`, which carries the stem address exactly when the shot sounded something as it was written). Both, because nothing says which half a comment is about. The direction reads its per-part acceptance. One review stamps its comments with one timestamp taken before its accepts (`applyFeedbackMutations`), so a comment submitted with an accept compares as written first. The record's `stale` is snapshotted before those decisions too (`staleFlagsBeforeDecisions`), so it still shows the comment its accept was made against.

Movement is a **review axis, never a generation one**: it stays out of `definitionHash`, whose change means "remake this take". A rewrite asks for no decision — no "Needs review", no staleness, no re-accept. Only a comment written on the panel reads it.

The direction stage is media-less, so its comments snapshot a `subjectHash` instead — the content hash of the direction part they were written on (`directionPartHashes`, which unlike the acceptance hash covers prose too). A direction comment goes stale once that shot / act / roster entry / waiver reads differently, or leaves the direction; a reader with no part hashes reads it `unknown`, so every command judging one loads the direction.

## Handoff

A handoff's per-asset notes (plain JSON under `review/<stage>/handoffs/<ts>.json`, one stream per review, validated by `HandoffSchema` on load) record _why_ a revision was made — address + text. `konte review handoff new <stage-scope>` writes one, authored from `--note` or scaffolded by diffing the latest review against current state; the preview UI surfaces them in the review stream.

Notes route by **address** against what each surface draws — a `<Panel>`'s is its captured asset path, so a note on a shared plate or reference image lands on the panel drawing it. One nothing drew (a plate consumed only as a generation input) rides the summary banner rather than being dropped.

## Audio accept (stems)

Audio is signed off **in context**, never on its own asset. A picture composition accept skips audio deps; audio is accepted through **stems** (see `arch-audio-guide` for what a stem is):

- **Per-shot audio** (`shot.<id>#stem`) folds into the shot accept — one gesture takes the composition and the stem, and the stem accept **cascades its audio sources** (the shot's `<Audio>`/`<Video hasAudio>` takes), giving each a staleness baseline. So in the UI an audio cue reads its shot's accept, exactly like a visual clip.
- **Timeline beds** (`timeline#stem`) get one accept, which cascades the `soundtrack()` sources — **including a reference bgm bed** — so accepting the soundtrack in the video review signs off the bgm at its asset level too.
- **Take-selection stays in the reference review**: accepting a bgm reference there picks the take; it is not the in-context sign-off (which is the stem accept). Characters remain the one consumed dep never cascaded — accepted only in `konte preview reference`.

Because a stem tracks its resolved sources, changing one re-opens the shot (or timeline stem): the stem accept is the in-context sign-off, the source accept the take pick. Removing a shot's last cue re-opens it too, until the shot's accept releases the stem.

Comments follow the same routing. A per-shot audio note goes on its shot; a bed note goes on `timeline#stem` — the video review's one comment target that is not shot-scoped, selected in the UI by picking the Soundtrack card or a bed clip. It carries a playhead time but no pin (there is no frame position in a bed), and its subject is the mix's own inputs, so it goes stale when a bed switches take.
