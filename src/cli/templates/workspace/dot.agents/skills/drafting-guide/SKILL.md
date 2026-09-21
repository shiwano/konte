---
name: drafting-guide
description: Shape a human's concept, script, or shot plan into an accepted direction.ts. Read before the first shaping question for a new video, and before adding, cutting, or restructuring an existing video's shots; laying out the stage files is layout-guide's.
user-invocable: false
---

Translate what a human wants to make into the direction every stage builds on — the signed-off concept captured in `direction.ts` and accepted. Done = every direction part accepted; laying out the stage files is `layout-guide`'s, generation and stage review `generation-loop-guide`'s.

## 1. Settle which piece

- **New piece → a new video, even when the workspace holds videos** — **never author one into an existing video's files**; created at step 7. Ask when it isn't explicit.
- **Deriving from a sibling video → still a new video; a copied `direction.ts` is a draft** — re-author it against `direction-guide` before editing it.
- **Revising an existing video → `konte status`, then step 7** — learn shot IDs and what's accepted; steps 2–6 shape a new piece only. What the change invalidates is `## Confirm before`'s.

## 2. Take in what they bring

A human arrives with some mix of three inputs — **ask which they have:**

- **Concept** — a script/shot list (honor it; map onto konte's shape with minimal restructuring) or a vague idea (then you propose).
- **Material** — their own media to put _in_ the video (footage, character/product/logo image, BGM/SE). Separate "already have" from "to generate"; `layout-guide` wires the files in.
- **Reference** — a link/video/image shown as "make it like this" → **direction, not material to include.** Pin down _what_ to emulate (tone, pacing, palette, framing, motion, subtitles); read what you can, ask the rest.

## 3. Hear what they picture — before any pitch

**Ask in rounds, not as a questionnaire** — two or three questions at a time, each next round shaped by the last answer — and stop when every line below is filled; a pitch made before that answers a brief you invented. "Just make something" fills the rest yourself; say what you assumed.

- **Why, and where it plays** — the purpose (a laugh among friends, a portfolio piece, a product's feed) and the surface (a feed thumbed with the sound off, a screen watched sitting down). The two set the runtime, what the first second must do, and whether on-screen text carries the piece.
- **The feeling they want left behind** — offer the `pleasure` vocabulary (`direction-guide`'s lenses.md) and let them pick, never ask cold; then the one line they want a viewer to say afterwards.
- **The picture in their head** — ask what they see when they imagine it, open, and follow what comes back: whatever they mention first is what matters to them, so the next question goes deeper into that — a figure, a light, a pace — never across a checklist. Write it back as they told it and let them correct you.
- **Which way this piece goes, and which way it must not** — about this piece, never taste in general or AI video at large. For a work they name, ask _which thing_ in it — a rhythm, a face, a palette, the shape of a joke. Ask the refused side as a direction the piece could plausibly take, e.g. "cute, or unsettling?". The refused side is the first draft of `outOfScope`.
- **What is fixed** — runtime, a character or product that must appear, the language, a deadline, a spend ceiling.
- **Mirror it back before the first pitch** — one paragraph in their words: what it is for, who watches it where, the feeling, the picture they see, the direction wanted and refused, the fixed points. A correction here costs a sentence; after a pitch it costs the pitch.

## 4. Decide the backend — before the pitch

- **Put the backend choice to the human explicitly** — recommend a path from what's connected + the concept, then confirm. Never default to a cloud vendor unasked.
- Weigh **connected** (`konte doctor --backends` surveys each — missing key / unreachable = unavailable), **cost** (ComfyUI local, low cost, needs a running server; FAL cloud, pay-per-use, ready now), and **look** (a matching model on a backend, or a custom workflow needed).
- **Chosen backend not configured → `config-guide`**, then back here.
- **Pick the specific model deliberately, not from memory** — read the leans off `konte adapter list --backend <kind>`; a wrong model is the costliest choice to reverse once a cut is built on it. Its guide answers the cull's model-reach question. A model the human names for every piece goes into `HOUSE_RULES.md`.
- **Ask whether they want a delivery resolution, never `megapixels`** — none → 720p (`1280×720`, `720×1280` vertical) at `megapixels: 0.9`, no upscale. Above 720p, say it adds an upscale job per shot at export, on an upscaler the chosen backend has (`authoring-guide`'s delivery.md).
- **Missing something (e.g. a ComfyUI workflow)? Flag now → `konte-comfy-workflow`.**

## 5. Pitch and pick

- **Read `scenario-guide` first.**
- **A vague concept is pitched under `scenario-guide`'s cull** — three loglines out of the wide set. A brought script or shot list (step 2) is never re-pitched.
- **Present each pitch with its cull answers** — the human picks or blends.

## 6. Agree the treatment — the gate before any file

Nothing is written to disk until the human has said yes to the treatment, in so many words. "Make a video about X" authorized the conversation, not the file.

- **Develop the pick, or the brought script, into a treatment** — tone, look, rough runtime (propose defaults, marked as yours), the recurring characters, props and places, and the frames the shots will share. **Ask only for forks you can't guess past** — live-action vs anime, aspect ratio, length. **Never pitch a shot-by-shot cut in chat** — the cut is authored under `direction-guide`'s rules and reviewed in the direction preview, or its sign-off gets re-litigated.
- **Send the treatment as one message, then the question alone** — logline, hook, the feeling and the viewer's line, tone, look, runtime, delivery resolution, who and where, the frames; then "shall I write this up as the direction?" With a native choice UI, that is the only question on it.
- **What is not a yes** — the pick in step 5; "sounds good" on one part; silence; a question back; a "yes, but…" (fold the "but" in, re-send the treatment, ask again). A treatment changed after the yes needs a new one.

## 7. Author the direction

- **Read `direction-guide` first** — and `scenario-guide`, entering here on a revision.
- **New piece → `konte video new <name> --template blank`, then copy the material already in hand to its `assets/files/`.**
- **Write `direction.ts`** — the `brief` is step 6's treatment (its hook is `hook`, step 3's refused direction is `outOfScope`); add rosters, `policy` and `sequence: { lens, pleasure, shots }`; clear `konte status`'s direction findings (fix or waive).
- **Then a split pass — the direction check can't read prose**: check every `action` against the one-action rule. **A pass that changes nothing on a first draft is suspect** — go find the fused trigger-reaction pair. Then an idiom pass over the hinges and peaks: a key action staged as one take is a missed chain. Then a continuity replay: walk the list as one continuous space — every "how did it get there?" is a missing shot.

## 8. Critique the cut

A fresh **`konte-direction-critic`** subagent reads the cut and returns findings before the direction goes to review.

- **Two spawns in sequence** — the second, fresh, reads the cut the first one's fixes rewrote. Iterating on the human's direction feedback (step 9) skips both.
- **Spawn it fresh, never as a fork** — a fork inherits your reading of the piece, which is the one thing the critique is for.
- **Pass one thing and nothing else** — the path to `direction.ts`. No history, no recap, no reason a choice was made: the explanation is what hides the defect.
- **Fix every blocking finding; take each advisory or say why not** — or, keeping a blocking one on purpose, write it into `brief.tolerances` with its reason, never into the spawn prompt: the critic skips what the piece has agreed to carry.
- **A spawn that won't run is the human's call** — ask, naming what the pass covers: unblock it, or go on without. Their go-ahead is what sends you to [self-critique.md](references/self-critique.md) — don't improvise that pass, and don't skip it.

## 9. Get it accepted

- **Get the direction accepted before authoring the stages** — chat sign-off does not substitute; the animatic and video spends are gated on it.
- **Run the review per `review-guide`, scope `direction`** — hand off, `konte preview direction`, read the record back.
- **Iterate feedback here, not later** — fix the direction (or waive with a reason), hand off again, re-preview; loop until accepted.
- **Once the direction is accepted end to end, don't reopen this preview** — re-entering here to retune a shot, a roster entry or the arc is an edit and a report, not a review: the human signs those off in the stage review of the panel or shot that realizes them. Only `brief`, `policy` and `waivers` bring you back, and `konte status` says so by offering `konte preview direction` under Next steps.

## 10. Hand off

- **Report in plain language** — the agreed concept, the direction's shape, what was fixed or waived in review.
- **Next — carry straight into `layout-guide`** to lay out the stages; report, don't stop for a go-ahead.

## Confirm before

- a change substantially affects already-accepted work, a shot ID, or the runtime/structure — never break one silently; say what it invalidates.

## Don't

- generate, open another stage preview, or accept / unaccept a variant.
- rewrite the human's concept on your own.
- pitch before step 3's mirror paragraph has been confirmed.
- for a new piece, create the video or write `direction.ts` before step 6's yes — however settled the backend and the roster are.
