---
name: generation-loop-guide
description: Drive one stage — reference pool, animatic, or video — through generate → wait → self-review → human review → iterate until every reviewable asset is accepted. Read when the user wants to build the reference pool, complete the animatic, complete/refine the video shots, run a stage, or whenever you reach a generate/wait/reroll step; developing a pendingShot is layout-guide's.
user-invocable: false
---

One loop drives every stage to "every reviewable asset has an accepted variant." Run it once per stage per direction sequence: the reference pool first, then a sequence's animatic and its video before the next sequence's animatic.

## Stage matrix

Substitute your stage's `<scope>` / `<address>` into every step below.

- `reference` — scope `reference`; upstream gate: none; self-review image, audio; done = every returned generative asset accepted → the animatic
- `animatic` — scope `animatic`; upstream gate: reference pool accepted; self-review image, audio; done = every developed shot accepted (`pendingShot` shots are undeveloped, not gaps) — an accepted sequence goes to `layout-guide` for that same sequence's video shots
- `video` — scope `video`; upstream gate: this sequence's animatic frames accepted; self-review video frames, motion, audio; done = every developed shot accepted → `layout-guide` for the next sequence, or `export-guide` when none is left

## 1. See what's missing

- `konte status` — your stage's Progress line; `all N [shots] accepted` → stage done.

## 2. Generate

- New or rewritten definitions clear `layout-guide`'s self-check before they meet a backend.
- Generating what has no accepted variant needs no go-ahead — on a paid vendor backend report batch size and expected cost in one line, then generate. Ask before invalidating accepted work.
- `konte generate <scope>` — submits all the stage's assets at once, async.
- `generate` regenerates a stale unaccepted take and skips an accepted generative one, even stale — after an edit, `generate` is the new take; `reroll` draws again on an unchanged definition, `--count N` for N takes at once. Follow the command's `accepted but stale` Next steps. Stale deterministic assets re-bake automatically unless their accepted take is a patch.
- Open on the cheap pass — `production-guide`'s cost ladder.

## 3. Wait for jobs

After `konte generate` or `konte reroll`:

- `konte job wait` — returns when the queue drains; run it on its own, in the background, without extra confirmation. Never close a turn with jobs in flight.
- Pending jobs wait for dependencies — including model downloads and node installation; do not reroll them.
- A job stuck running far too long → `konte job show <jobId>` — its diagnosis separates a slow model, a prompt ComfyUI lost in a crash, and a job no worker is watching.
- Failed job → `konte job show <jobId>`, then `konte job logs <jobId>`; fix the cause and `konte reroll <address>`. Several failed addresses → `konte reroll --failed --yes`.

## 4. Self-review before involving the human

Look at every generated asset before the human does, sampled by media kind — skip `file` assets and `pendingShot` shots.

Your eyes settle what can be counted, never whether it is good — the wrong subject, a figure too many or too few, an empty frame, a missing element, a take that never moved, a line not carried. A doubt you cannot name in those terms is a note in the handoff, not a reroll.

- A shared base image is reviewed before the panels built on it, and on its own terms — set state, realism register, scale, not "does the shot read". A defect there is the root's reroll, never a note on one shot.
- Image → `konte probe image <variantId|address|scope>...` — open the printed images; `probe crop` for detail. Judge against the shot's `action` (and `script`) — right subject, character consistency across shots, no artifacts. An opening panel's pixels hold the contacts and positions its shot's transit starts from, or it's a reroll however clean it looks; a key reads as its `action`'s moment. A recurring character reference must be a clean single-subject conditioning frame, not a turnaround sheet.
- Board batch → `konte probe contact-sheet` — shots side by side in one sheet; `--cell-width <px>` when detail is too small to read.
  - `--needs-review [scope]` first after a `generate` — every landed take nobody has judged, each cell carrying its variant id.
  - Otherwise `<variantId|address|scope>...` — a still scope sweeps every image under it; a video scope tiles each shot's in/out pair, so a cut reads across the boundary, plus a cell per subtitle line. A tail artifact is judged on the clip's own filmstrip, never off this sheet.
  - Same-size-and-angle neighbors are a reroll unless a match cut is intended; a planted prop must stay readable across its cuts.
- Video frames: `konte probe reel-thumbnails <animatic|video>:shot.<id>` (one shot's composition frames, scene-detected; `--at <timecode>` for an exact moment) or `konte probe thumbnails <variantId|address|scope>...` (raw clips).
- Motion → `konte probe motion <variantId|address|scope|…#composition>...` — a filmstrip per clip or composition; a scope sweeps every clip. Read adjacent tiles for _did it move_, trajectory and sustained breakage.
  - `low_motion` → it carries the shot's `action` and the board's `blocking`/`camera`; a reroll only where those asked for movement
  - `dispersed_motion` → nothing moved and something churned
  - static strip, no warning → movement finer than the tile spacing; zoom with `--window 0.8` or `--at <sec>` first
- Audio: the assembled mix → `konte probe reel-audio <animatic|video>` (`:shot.<id>` narrows) — per-track waveform, timing, silence warnings. Raw sources → `konte probe audio <variantId|address|scope>...`.

### Animatic: the board as a sequence

- Before the shots' first human review, spawn `konte-animatic-critic` on `animatic.tsx` — after countable defects are cleared and before panels' movement is written.
- Revising after the human's review, read the assembled cut yourself — per-shot checks pass on a flat, monotone cut: weigh each cut in Walter Murch's Rule of Six order (emotion, story, rhythm, spatial continuity last), and run `staging-guide`'s read-test on each changed shot.

### Video: each take

- Before the shots' first human review, spawn `konte-video-critic` on `video.tsx` — instead of reading its strips. An advisory is a handoff note.

### Fix

Fix what you found, then re-check — never hand the human a frame you already know is broken. Route the defect to its owning layer:

- prompt content or delivery → `prompt-guide` → generate
- one local element on a take otherwise right (add, remove, recolour), once a reroll on the fixed prompt still misses it or the human wants the take kept, and the medium has an edit route (`konte adapter list`) → `konte patch new <address>`, the edit shaped per its adapter's guide, then generate. A failed patch leaves the take; `konte patch remove <variantId>` (the take it was written against) drops the fix for good. A further fix is another step in that same script — a patched take cannot be patched again.
- the shot doesn't read — framing, staging, continuity → the animatic panel: restage, then generate down the chain, never papered over in the motion prompt
- a panel rerolled onto the same composition → rewrite its prompt — or its plate, for a size or camera the plate lacks — then generate
- a pinned endpoint — pose, gaze, hands at start/end → the animatic frames pin it, not the prompt: edit the panel, then generate down the chain
- the note is about the movement — "give it more motion", a transit that doesn't read → rewrite the panel's `blocking`/`camera`; no new take, and the comment goes stale on its own
- pacing, shot order, runtime → `direction.ts` (`direction-guide`) — no reroll fixes it; a shot's retuned words are re-signed by its stage accept, a retuned setup on `direction:setups.<id>`
- subtitles, overlays, transitions, BGM/SE mix → the `<Composition>` (`composition-guide`) — re-renders live, regenerates nothing
- an action off its SE in the stem → the board's `<Audio start>`, then generate the motion

Reroll:

- Draw again before you rewrite — a broken still is one sample; rewrite only when several draws fail the same way.
- `konte reroll <address>` — then wait (step 3) and re-check. Rerolling a named accepted asset keeps its accept; the new take stands beside it as review work. If the asset feeds another in the same stage, add `--with-dependents` — the chain rebuilds in dependency order, stopping at an accepted take. A whole stage or shot is rerolled by its address-scope (`konte reroll video:shot.05 --yes`), which skips what it cannot spend on and accepted takes.
- A reroll that came out worse → `konte dismiss <newVariantId>` — the address falls back to the take before it, still undecided and undeleted. It falls back only to a take matching the current definition, so where the new take followed a prompt edit, restore the prompt instead: `konte inspect <address>` diffs each take against the live one.
- Several draws, one best → `konte dismiss --except <variantId>` dismisses every other take at its address.

### Before handoff

- Animatic: write each panel's movement from its settled take — preview refuses (`movement-unwritten`) while any is missing; re-check after a reroll. Where that take departs from `action`, `action` follows it.
- A variant finding — a take silent, or heard to drop or change its line — holds the review (`take-silent` / `line-misheard`). Compare `line` with `heard` in `konte probe audio <variantId>`: dismiss a broken take (a reroll leaves it standing); `konte vouch <variantId>` one whose difference is only spelling (kanji for kana, a name, digits).

## 5. Human review

- Hand off, preview, read the record → `review-guide`, with your stage's `<scope>`. Takes the human names to go back to are yours to record: `konte accept <variantId>... -y`.

## 6. Iterating on feedback

For each target with open feedback, accepted or not: route the human's words through step 4's fix — read the comment with its pin and `[image: <path>]` frame. A note changing what the shot shows goes into its `action` too. Then wait (step 3), self-check (step 4) — the changes, their adjacent cuts, and agreement with the feedback — and re-review (step 5).

Loop until the stage matrix's "done =" holds, then report the accepted variant per asset and take that row's exit.
