---
name: generation-loop-guide
description: Drive one stage — reference pool, animatic, or video — through generate → wait → self-review → human review → iterate until every reviewable asset is accepted. Read when the user wants to build the reference pool, complete the animatic, complete/refine the video shots, run a stage, or whenever you reach a generate/wait/reroll step.
user-invocable: false
---

One loop drives every stage to "every reviewable asset has an accepted variant." Run it once per stage per direction sequence: the reference pool first, then a sequence's animatic and its video before the next sequence's animatic.

## Stage matrix

Substitute your stage's `<scope>` / `<address>` into every step below.

- **`reference`** — scope `reference`; upstream gate: none; self-review image, audio; passes below; done = every returned generative asset accepted → the animatic
- **`animatic`** — scope `animatic`; upstream gate: reference pool accepted; self-review image, audio; done = every **developed** shot accepted (`pendingShot` shots are undeveloped, not gaps) — an accepted sequence goes to `layout-guide` for that same sequence's video shots
- **`video`** — scope `video`; upstream gate: this sequence's animatic frames accepted; self-review video frames, motion, audio; done = every developed shot accepted → `layout-guide` for the next sequence, or `export-guide` when none is left

## Reference order

- **When layout calls for a look proof, run it alone first** — later prompts follow its accepted take. Then run the roster-wired reference pool; without a look proof, start there.
- **A `characters` roster reference is done only when accepted in `konte preview reference`** — an accept through a shot consuming it never counts; an animatic/video spend aborts `CHARACTER_ACCEPTANCE_REQUIRED` until it is.

## 1. Preflight

- **Run `konte doctor`** — on a missing backend key or disconnected backend (`FAIL ...`), stop and follow `config-guide` first.
- **`generate` aborts `DIRECTION_ACCEPTANCE_REQUIRED`** → drive the direction review in `drafting-guide`, then run again. `pendingShot` shots are `layout-guide`'s to develop, not this loop's.
- **The board is accepted before the motion it feeds** — `generate video` aborts (`ANIMATIC_ACCEPTANCE_REQUIRED`) on any `animatic:` address a shot consumes with no accepted take: its keyframes, and its `#stem` where the shot speaks. Take the board through one review of the whole reel (step 5) and run again.

## 2. See what's missing

- **`konte status`** — your stage's Progress line; `all N accepted` → stage done.

## 3. Generate

- **New or rewritten definitions clear `layout-guide`'s self-check before they meet a backend.**
- **Generating what has no accepted variant needs no go-ahead** — on a paid vendor backend report the batch size and expected cost in one line, then generate. Ask before invalidating accepted work, such as rerolling an accepted asset by its address.
- **`konte generate <scope>`** — submits all the stage's assets at once, async; dependency-free assets start immediately, dependent ones cascade as inputs become ready.
- **`generate` skips accepted generative takes, even stale ones** — follow the command's `accepted but stale` Next steps. Stale deterministic assets re-bake automatically unless their accepted take is a patch.
- **Open on the cheap pass** — `production-guide`'s cost ladder.

## 4. Wait for jobs

After `konte generate` or `konte reroll`:

- **`konte job wait`** — this is how a run ends. It returns when the queue drains: run it in the background without extra confirmation, on its own. **Never close a turn with jobs in flight.**
- **Pending jobs wait for dependencies** — including model downloads and node installation; do not reroll them.
- **A job stuck running far too long** → `konte job show <jobId>` — its diagnosis separates a slow model, a prompt ComfyUI lost in a crash, and a job no worker is watching.
- **Failed job** → `konte job show <jobId>`, then `konte job logs <jobId>`; fix the cause and `konte reroll <address>`. Several failed addresses → `konte reroll --failed --yes`.

## 5. Self-review before involving the human

**Look at every generated asset before the human does**, sampled by media kind — skip `file` assets and `pendingShot` shots. Resolve any asset's file with `konte ref <address>...` (accepted, else newest ready non-stale, else newest stale take).

**Your eyes settle what can be counted, never whether it is good** — the wrong subject, a figure too many or too few, an empty frame, a missing element, a take that never moved, a line not carried. A doubt you cannot name in those terms is a note in the handoff, not a reroll.

- **A turbo take's finish is its setting** (`generate` lists them) — softness or thin detail is no reroll; the counted defects above still are.
- **A shared base image is reviewed before the panels built on it, and on its own terms** — set state, realism register, scale, not "does the shot read". A defect there is the root's reroll, never a note on one shot.
- **Image** (animatic panels, reference characters/backgrounds): view the file against the shot's `action` (and `script`, if any) — right subject, character consistency across shots, no artifacts. A `first` panel must be able to launch the transit its shot needs — the contacts and positions that transit starts from are in the pixels, or it's a reroll however clean it looks. A recurring character reference must be a clean single-subject conditioning frame, not a turnaround sheet.
- **Board batch → `konte probe contact-sheet`** — shots side by side in one sheet; `--cell-width <px>` when detail is too small to read.
  - **`--needs-review [scope]` first after a `generate`** — every landed take nobody has judged, each cell carrying its variant id.
  - **Otherwise `<variantId|address|scope>...`** — a still scope sweeps every image under it; a video scope tiles each shot's in/out pair, so a cut reads across the boundary. A tail artifact is judged on the clip's own filmstrip, never off this sheet.
  - **Same-size-and-angle neighbors are a reroll unless a match cut is intended**; a planted prop must stay readable across its cuts.
- **Video frames**: `konte probe reel-thumbnails <animatic|video[:shot.<id>]>` (a composition's own frames, scene-detected; `--at <timecode>` for an exact moment) or `konte probe thumbnails <variantId|address|scope>...` (raw clips).
- **Motion → `konte probe motion <variantId|address|scope|…#composition>...`** — a filmstrip per clip or composition; a scope sweeps every clip. Read adjacent tiles for _did it move_, trajectory and sustained breakage.
  - `low_motion` → it carries the shot's `action` and the board's `blocking`/`camera`; a reroll only where those asked for movement
  - `dispersed_motion` → nothing moved and something churned
  - static strip, no warning → movement finer than the tile spacing; zoom with `--window 0.8` or `--at <sec>` first
- **Audio**: the assembled mix → `konte probe reel-audio <animatic|video>` (`:shot.<id>` narrows) — per-track waveform, timing, silence warnings. Raw sources → `konte probe audio <variantId|address|scope>...`.

### Animatic: the board as a sequence

- **Spawn `konte-animatic-critic` cold** — this sequence's shot ids, fresh and never a fork, handed nothing else; once per sequence, after the countable defects are cleared and before the panels' movement is written. Take or answer each finding.
- **Judge the assembled cut** — per-shot checks pass on a flat, monotone cut.
- **Weigh each cut in Walter Murch's Rule of Six order** — emotion, story, rhythm, spatial continuity last.
- **Read `staging-guide` and run its read-test per shot.**

### Fix

**Fix what you found, then re-check — never hand the human a frame you already know is broken.** Route the defect to its owning layer:

- prompt content or delivery → `prompt-guide` → reroll
- one local element on a take otherwise right — add, remove or recolour it — once a reroll on the fixed prompt still misses it, or the human wants the take kept, and the medium has an edit route (`konte adapter list`) → **`konte patch new <address>`**, the edit in the shape its adapter's guide gives, then generate. A failed patch leaves the take; `konte patch remove <variantId>` (the take it was written against) drops the fix for good. A further fix is another step in that same script — a take a patch produced cannot be patched again.
- the shot doesn't read — framing, staging, continuity → the animatic panel: restage, reroll the chain, never papered over in the motion prompt
- a pinned endpoint — pose, gaze, hands at start/end → the animatic frames pin it, not the prompt: edit the panel, reroll the chain
- the note is about the movement, not the frame — "give it more motion", a transit that doesn't read → the panel's `blocking`/`camera`: rewriting them answers it with no new take, and the comment goes stale on its own
- pacing, shot order, runtime → `direction.ts` (`direction-guide`) — no reroll fixes it; a shot's retuned words are re-signed by its stage accept, a retuned setup on `direction:setups.<id>`
- subtitles, overlays, transitions, BGM/SE mix → the `<Composition>` (`composition-guide`) — re-renders live, regenerates nothing
- an action off its SE in the stem → the board's `<Audio start>`, then reroll the motion

**Reroll:**

- **Draw again before you rewrite** — a broken still is one sample; rewrite only when several draws fail the same way.
- **Before a third take at one address, simplify its action instruction to one sentence** — the adapter guide's required sections, notation and word counts still hold; re-add action constraints only for what the take actually misses.
- **`konte reroll <address>`** — then wait (step 4) and re-check. Rerolling a named accepted asset drops its accept after confirmation; the new take becomes review work. **If the asset feeds another in the same stage, add `--with-dependents`** — the chain rebuilds in dependency order, stopping at an accepted take. A whole stage or shot is rerolled by its address-scope (`konte reroll video:shot.05 --yes`), which skips what it cannot spend on and accepted takes.
- **A reroll that came out worse → `konte dismiss <newVariantId>`** — the address falls back to the take before it, still undecided and undeleted. It falls back only to a take matching the current definition, so where the reroll followed a prompt edit, restore the prompt instead: `konte inspect <address>` diffs each take against the live one.

### Before handoff

- **Animatic: write each panel's movement from its settled take** — preview reports `REVIEW_PREREQUISITE_MISSING` while any is missing; re-check it after a reroll.
- **Video, last sequence: run `polish-guide`** — once every shot holds a self-reviewed take and no sequence is left.

## 6. Human review

- **Hand off, preview, read the record → `review-guide`** — `<scope>` is your stage's; come back here with the submitted decisions. The takes they name to go back to are yours to record: `konte accept <variantId>... -y`.

## 7. Iterating on feedback

For each target with open feedback, **accepted or not**: **route the human's words through step 5's fix** — read the comment with its pin and `[image: <path>]` frame. A note on what the frame or movement conveys re-derives the shot's whole staging from its `action`; a note changing what the shot shows goes into its `action` too. Then wait (step 4), self-check (step 5), re-review (step 6).

Loop until the stage matrix's "done =" holds, then report the accepted variant per asset and take that row's exit.
