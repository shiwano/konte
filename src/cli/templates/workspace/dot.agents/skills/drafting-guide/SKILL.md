---
name: drafting-guide
description: Shape a human's concept, script, or shot plan into an accepted direction.ts. Read before the first shaping question for a new video, and before adding, cutting, or restructuring an existing video's shots; laying out the stage files is layout-guide's.
user-invocable: false
---

Translate what a human wants to make into the direction every stage builds on — the signed-off concept captured in `direction.ts` and accepted. Done = every direction part accepted; laying out the stage files is `layout-guide`'s, generation and stage review `generation-loop-guide`'s.

## 1. Settle which piece

- New piece → a new video, even when the workspace holds videos — never author one into an existing video's files; created at step 7. Ask when it isn't explicit.
- Deriving from a sibling video → still a new video; a copied `direction.ts` is a draft — re-author it against `direction-guide` before editing it.
- Revising an existing video → `konte status` (shot IDs, what's accepted), then step 7; steps 2–6 shape a new piece only.

## 2. Take in what they bring

Ask which of three inputs they have:

- Concept — a script/shot list (honor it; map onto konte's shape with minimal restructuring) or a vague idea (then you propose).
- Material — their own media to put _in_ the video (footage, character/product/logo image, BGM/SE). Separate "already have" from "to generate"; `layout-guide` wires the files in.
- Reference — a link/video/image shown as "make it like this" → direction, not material to include. Pin down _what_ to emulate (form, tone, pacing, palette, framing, motion, subtitles); read what you can (a video or a link: `konte study clip <file|url>`), ask the rest.

## 3. Hear what they picture — before any pitch

Ask in rounds of two or three questions, each shaped by the last answer; stop when every line below is filled — a pitch made before that answers a brief you invented. "Just make something" → fill the rest yourself and say what you assumed.

- Why, and where it plays — the purpose (a laugh among friends, a portfolio piece, a product's feed) and the surface (a feed thumbed with the sound off, a screen watched sitting down). The two set the runtime, what the first second must do, and whether on-screen text carries the piece.
- The form — offer the four, a reference's form as the first guess: a story (someone wants something, events follow), persuasion (a claim and its reasons — a promo, an explainer), a process (one subject made or changed), a mood (a motif).
- The feeling they want left behind — offer the `pleasure` vocabulary (`direction-guide`'s lenses.md) and let them pick, never ask cold; then the one line they want a viewer to say afterwards.
- The picture in their head — ask openly what they see, then go deeper into whatever they mention first (a figure, a light, a pace), never across a checklist. Write it back as they told it and let them correct you.
- Which way this piece goes, and which way it must not — this piece, never taste in general or AI video at large. For a work they name, ask _which thing_ in it — a rhythm, a face, a palette, the shape of a joke. Ask the refused side as a direction the piece could plausibly take, e.g. "cute, or unsettling?". The refused side is the first draft of `outOfScope`.
- What is fixed — runtime, a song to cut to, a character or product that must appear, the language, a deadline, a spend ceiling.

## 4. Choose the backend and model — before the pitch

Your picks go into the treatment (step 6). Ask nothing here.

- `konte adapter list` — it lists only configured backends. One backend → it. Several → recommend by cost (ComfyUI local, low cost, needs a running server; FAL cloud, pay-per-use, ready now) and look (a matching model on a backend, or a custom workflow needed).
- None configured, or the look needs a backend that isn't → `config-guide`, then back here.
- Pick the model from `konte adapter list --backend <kind>`'s leans, never from memory. Its guide answers the cull's model-reach question. A model the human names for every piece goes into `HOUSE_RULES.md`.
- Delivery resolution, never `megapixels` — default 720p (`1280×720`, `720×1280` vertical) at `megapixels: 0.9`, no upscale. A higher one the brief asks for adds an upscale job per shot at export, on an upscaler the chosen backend has (`authoring-guide`'s delivery.md); the treatment says so.
- Missing something (e.g. a ComfyUI workflow)? Flag now → `konte-comfy-workflow`.

## 5. Pitch and pick

- Read `scenario-guide` first — a vague concept is pitched under its cull. A brought script or shot list (step 2) is never re-pitched.
- Present each pitch with its cull answers — the human picks or blends.

## 6. Agree the treatment — the gate before any file

Nothing is written to disk until the human has said yes to the treatment, in so many words. "Make a video about X" authorized the conversation, not the file.

- Develop the pick, or the brought script, into a treatment — tone, look, rough runtime (propose defaults, marked as yours), the recurring characters, props and places, and the frames the shots will share. Ask only for forks you can't guess past — live-action vs anime, aspect ratio, length. Never pitch a shot-by-shot cut in chat — it is authored in `direction.ts` and reviewed in the direction preview.
- Send the treatment as one message, then the question alone — what it is for and where it plays, logline, hook, the feeling and the viewer's line, the direction it refuses, tone, look, runtime, delivery resolution, backend and model, who and where, the frames; then "shall I write this up as the direction?" With a native choice UI, that is the only question on it.
- What is not a yes — the pick in step 5; "sounds good" on one part; silence; a question back; a "yes, but…" (fold the "but" in, re-send the treatment, ask again). A treatment changed after the yes needs a new one.

## 7. Author the direction

- Read `direction-guide` first — and `scenario-guide`, entering here on a revision.
- New piece → `konte video new <name> --template blank`, then copy the material already in hand to its `assets/files/`, a studied clip to `studies/` (`brief.references`).
- A piece derived from an existing one → `konte video copy <src> <dest> --through <stage>` — `--through direction` to revise the direction.
- Cut to a song → [song-first.md](references/song-first.md) before writing any shot — the song is made and accepted first.
- Write `direction.ts` — the `brief` is step 6's treatment (its hook is `hook`, step 3's refused direction is `outOfScope`); add rosters, `policy` and `sequence: { lens, pleasure, shots }`; clear `konte status`'s direction findings (fix or waive).
- Then three passes the direction check can't make:
  - split — every `action` against the one-action rule; a first-draft split that changes nothing is suspect — in a story, find the fused trigger-reaction pair.
  - idiom — over the hinges and peaks: a key action staged as one take is a missed chain.
  - continuity — walk the world-state ledger across every cut; inside a continuous-space stretch, every "how did it get there?" is a missing shot.

## 8. Critique the cut

A fresh `konte-direction-critic` subagent reads the cut and returns findings before the direction goes to review.

- Two spawns in sequence — the second, fresh, reads the cut the first one's fixes rewrote.
- Fix every blocking finding; take each advisory or say why not — or, keeping a blocking one on purpose, write it into `brief.tolerances` with its reason — the critic skips what the piece has agreed to carry.
- A spawn that won't run is the human's call — ask, naming what the pass covers: unblock it, or go on without. Their go-ahead is what sends you to [self-critique.md](references/self-critique.md) — don't improvise that pass, and don't skip it.

## 9. Get it accepted

- Get the direction accepted before authoring the stages — chat sign-off does not substitute.
- Run the review per `review-guide`, scope `direction`.
- Iterate feedback here, not later — fix the direction (or waive with a reason), hand off again, re-preview; loop until accepted.
- Once the direction is accepted end to end, don't reopen this preview — retuning a shot, a roster entry or the arc is an edit and a report; the human signs it off in the stage review of the panel or shot that realizes it. Only `brief`, `policy` and a waiver on no shot bring you back; `konte status` then offers `konte preview direction` under Next steps.

## 10. Hand off

- Report in plain language — the agreed concept, the direction's shape, what was fixed or waived in review.
- Next — carry straight into `layout-guide` to lay out the stages; report, don't stop for a go-ahead.

## Confirm before

- a change substantially affects already-accepted work, a shot ID, or the runtime/structure — never break one silently; say what it invalidates.

## Don't

- generate, open another stage preview, or accept / unaccept a variant.
- rewrite the human's concept on your own.
- for a new piece, create the video or write `direction.ts` before step 6's yes — however settled the backend and the roster are.
