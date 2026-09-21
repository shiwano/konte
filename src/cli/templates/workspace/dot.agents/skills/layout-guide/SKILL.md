---
name: layout-guide
description: Lay out an accepted direction into stage definitions — wire rosters and brought material, lay out every shot in animatic.tsx / video.tsx, bake the plates, then develop and self-check one direction sequence at a time. Read when the direction is accepted and stage files are missing, when developing pendingShot shots, adding shots, or restructuring a definition; human reviews use generation-loop-guide.
user-invocable: false
---

Turn the accepted direction into stage definitions ready to generate — rosters wired, every shot laid out, developed one direction sequence at a time. Done = the current sequence authored and typechecked, handed to `generation-loop-guide`; shaping the concept or revising the direction is `drafting-guide`'s.

- **Critics are spawned fresh, never as a fork, handed only what the step names**. Take each finding or say why not.

## 1. Preflight

- **The direction is accepted, or this isn't your step** — `konte status`; a direction review under Next steps, or a change that belongs in `direction.ts` → `drafting-guide`. A part reported as changed with no direction review offered needs none: the stage review it belongs to signs it off.
- **Re-entering a piece → `konte status` before editing** — which shots are developed, what's accepted, which pendings remain.

## 2. Wire brought material as file assets

Bring each file under `assets/files/` in as `file` kind — no generation. Pick `adapters.imageFile` / `videoFile` / `audioFile` by media type; where each declaration goes → `authoring-guide`.

## 3. Settle the look

- **Create a look proof only when its appearance needs visual agreement** — including CG characters in live action. `brief.look` alone suffices, brought material only, or an already-accepted look → skip to step 4.
- **Declare one look proof alone in `reference.tsx`, then hand to `generation-loop-guide` for its pass** — reference is exempt from the direction gate, so it generates with the rosters unanchored. Return here once it is accepted.
- **It is `brief.look` as a picture** — palette, key light, line, finish, realism register. **Draw the world, not a shot**: a frame from the cut turns the review onto staging.
- **Put one unnamed figure in it when the piece has people** — a person of the world, not the cast: line, skin and proportion under this look, no face or costume to sign off. A look settled on scenery alone is redone after pass 1, and every sheet with it.
- **Looked at, never fed** — wiring it into a later asset as an image or style input carries its staging into everything built on it. Every later prompt is written to it in prose; where prose cannot pin the finish, that is a style sheet's slot, in pass 1.
- **Leave it declared** — removing it orphans its accepted take.

## 4. Wire the rosters

- **Expose a `reference:<id>` per character, prop, location, and cast voice in `reference.tsx`** — the deferred roster findings gate generation from here on.
- **Run the reference pool through `generation-loop-guide` and return once accepted.**

## 5. Lay out every shot

- **Lay out every shot in `animatic.tsx` undeveloped** — `pendingShot(id)` / `.nextPendingShot(id)`, a graphic shot `graphicShot(id, …)`. **Don't stand one up as a `jsxImage` plate.**
- **Mirror the structure into `video.tsx` as the same `pendingShot(id)` skeleton** — one per shot ID, declared rather than omitted, so the direction ↔ video drift check sees every shot (`konte export` refuses while any remain).
- **An aside shot is `asideShot(id)`** — never boarded, never `pendingShot`ed; the video builds it, usually one `file`. A generated OP is its own konte video, exported and brought in as that file.
- **Animatic `soundtracks` only for a cut timed to a track** (music video, dance) — one `reference:<id>` in both stages; other music goes in `video.tsx` once the cut exists.

## 6. Bake the plates

- **Wire plates** → `staging-guide`; every shot stays pending through the bake.
- **Spawn `konte-prompt-critic` with only the `animatic.tsx` path before the bake.**
- **`konte generate animatic`, `konte job wait`, then spawn `konte-animatic-critic` with only `plates`** — recut or reroll a wrong frame before any panel stands on it. **Accept nothing**: a plate is never review work; the accept of the first panel built on it signs it off.

## 7. Develop one direction sequence at a time

Developing a shot = swapping its pending form for the real one — `pendingShot(id)` → `shot(id, build)` in either stage — with a real adapter and prompt.

- **Delegate the mechanics** — routing each shot's motion and panel count, before its panels are drawn → `production-guide`; each shot's staging, fixed before its prompt → `staging-guide`; DSL → `authoring-guide`; adapters → `konte adapter list` / `show`; prompts → `prompt-guide`; `<Composition>` JSX → `composition-guide`.
- **One pass = one direction leaf sequence, in story order** — its shots and nothing outside it; a short piece is a single leaf, so it is one pass.
- **A `join: "continuous"` pair is developed together** — the second shot's picture is derived from the first's, so leaving one of them a `pendingShot` leaves the other nothing to build on. Take the pair in one pass even where a sequence boundary falls between them.
- **Carry a sequence through both stages before laying out the next** — its panels accepted, then its video shots developed and accepted. A video shot's motion prompt is written from the accepted frames; the next sequence's prompts from what this one settled — the adapter, the prompt pattern, each recurring subject's look.
- **Write each panel prompt from the plate on screen** — the prompt names what that frame actually shows as its `<Picture N>`. Written from the roster prose instead, the plate is wired in but unread by the model: `setup-unconsumed` passes and the frame drifts anyway.
- **Leave `blocking`/`camera` off every `<Panel>`** — they are written from the take, in `generation-loop-guide`'s self-review. The shot's `script` is sounded with `<Audio>`, not written onto a panel.
- **An animatic `pendingShot` may stay for good** — a shot produced by text-to-video or staged in composition consumes no keyframe; name the deferral in the handoff.
- **Editing a definition copied from another video is writing it** — read the guides above before the first edit; a carried-over prompt holds the other piece's staging and adapter choices.

## 8. Self-check the sequence

Every pass reads the files you just wrote, never your memory of what you meant.

- **A match pass, definition against definition** — each reference prompt against its roster entry and the job it holds as an anchor (single subject, clean ground, identifying features in frame); each panel prompt against its shot (`action`, `script`, and the size/place its `setup` carries) and the anchors it conditions on — the `reference:<id>`s, and the setup's plate where it has one; each motion prompt against the panel's `blocking` / `camera` and the shot's `duration`; each voice asset word for word against the shot's `script` line and a character line's delivery against that shot's `action`, each bed against `brief.tone`. A promise the prompt drops, or an element it invents, is a rewrite now — after generating it is a reroll.
- **Then each opening panel against the motion it must launch** — is the condition its `action` lands true in the frame the prompt fixes? Untrue, or half true, is a rewrite, unless that shot opens on the tail by choice.
- **Then a run-through, shot against shot** — `konte inspect <stage>:shot.<id> --prompts` prints each address's `lineup:` and `set:` lines above its prompt. Read this sequence in order, opening from the last accepted shot before it, against `staging-guide`'s frame and cut rules: every subject by its `promptDepiction` in `lineup:` order, each `set:` landmark on its side, one continuity state described identically everywhere — **put each recurring element's wording side by side across shots**.
- **`brief.outOfScope` is a rewrite wherever it shows**; what `brief.tolerances` accepts is never a finding.
- **Then spawn `konte-prompt-critic` with only the definition path, before this sequence's first spend** — once per sequence, not per round.

## 9. Typecheck, then hand off

- **Typecheck with `konte status`** — it type-checks the whole workspace and loads the definitions.
- **Report in plain language** — structure, developed shots, runtime, remaining `pendingShot`s per stage; for a revision, what you touched.
- **Next — carry straight into `generation-loop-guide`** for what you just developed; report the layout, don't stop for a go-ahead.

## Confirm before

- a sequence or restructuring touches already-accepted panels or takes — never break one silently; say what it invalidates;
- accuracy-critical real people or products are involved — a missing source file is the human's to provide, never fabricated.

## Don't

- generate mid-layout outside step 6's plate bake, open a preview, or accept / unaccept a variant — **except a take the human named**: `konte accept <variantId> -y` records their sign-off.
- develop past the current sequence before its review is in.
