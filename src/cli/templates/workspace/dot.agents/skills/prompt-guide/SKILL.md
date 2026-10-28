---
name: prompt-guide
description: Write the prompt text of an asset() — image, motion, voice, BGM, SFX — and route to the adapter's own guide. Read before writing or editing any asset() prompt.
user-invocable: false
---

Turn fixed staging into `asset()` prompt text; done = the self-review below passes against the adapter's guide and the shot. A shot's production method and role design are outside this guide.

## Before writing

Before writing or editing a prompt-like field (`prompt`, `text`, `lyrics`):

1. Fix the shot's staging (`staging-guide`) — staging you never stated reads as fixed from inside the prompt.
2. Run `konte adapter show <adapter>`, read every file its `guide` lines name, in order, and defer to them — they carry prompt shape, length and per-anchor advice; the input table's DESCRIPTION column documents the non-obvious parameters (negative-prompt and audio policy included). A model's decodes share their first files; read a shared one once. No guide or descriptions shown → read the adapter file's input schema.
3. Inspect the non-prompt parameters (`aspectRatio`, `duration`, `resolution`, `negativePrompt`, voice/seed/format, image/audio references) — don't move parameter-level controls into prompt text.
4. Reference-consuming prompts (an edit, pinned frames, references, a source image) — how much of the source to restate, how to ask for a size or angle it lacks, which reference goes in which slot and how it is tagged in the body are the model's call, from its guide. A reference that has to carry a layout — a framing guide, labelled regions, several assets composited into one plate — is built with `adapters.jsxImage` (`konte adapter show jsxImage`).
5. Schema wins over model doc when they disagree.

## What a prompt names

- Name what occupies the space, never what to leave out — a model conditions on the words it is given, so `no outlines` draws outlines; write `flat washes meeting edge to edge`.
- An exclusion belongs in `negativePrompt` — the one field a model reads it in.
- Write the scene description as a plain string literal, inline and fully spelled out — only boilerplate that must stay verbatim across shots (a canvas preamble, a character-preservation clause) may be a shared constant.

## Per kind

- reference — no staging pass: plain background, even lighting, subject filling the frame, since background detail binds into the identity.
- `brief.look`'s medium decides what a reference has to be — drawn or stylized, the reference is the look, so it arrives at finish quality: line weight, palette, shading and deformation are the character information. Live action, it is an identification asset — write build, garment cut and material, and leave out cinematic backlight, a strong grade and shallow depth of field, each of which buries the structure a later model reads off it.
- voice sample — a cast voice's `reference:<id>` is a timbre specimen: an adapter whose description says it designs a voice, an everyday sentence with nothing to act, the roster's `voice.description` reduced to timbre. A delivery baked into the sample is inherited by every line pointed at it. Sex never moves — a male role needs a male sample.
- spoken line — `{ narration }` is one voice held level across the piece, `{ character }` a person acting inside a shot. Narration takes a clone adapter pointed at the sample, so the timbre holds across every take; a character line takes one that acts, with the sample as its voice reference and the delivery written into the prompt — what the speaker is doing, at what volume, from where in the range, at what tempo, what the breath under it is doing. `konte adapter list` says which each adapter is; a clone's emotion and rate controls adjust a read, never build a performance.
- Translate the line's `acting` note into the model's verbs and adverbs and add nothing it does not claim — an invented delivery is rewritten on the next reroll.
- Two characters' lines in one call only work on a model that takes speaker tags — on any other, give each speaker its own take.
- Either kind's words — pass the injected `script.<who>[n]` as it stands; a paraphrase, a retyped copy or a wording fix is a `direction.ts` edit. A word THIS model reads wrong is respelled at the take with `respell(script.<who>[n], "…")`. A `ja` line's notation is `direction-guide`'s `japanese-notation.md`.
- motion — realize the movement the panel's `blocking`/`camera` fixed; read them in `animatic.tsx`. The prompt names what moves and what the motion reveals — on a key, from its start to the key's landing.
  - Open each beat on where the last one lands, unless a pause is the point — its end state or its momentum: `out of the stumble she snaps a front kick`. A beat written from rest plays a pause before it.
  - Write a camera move as a path — where it starts, what it passes, where it lands, and the subject it travels with: `rises off the floor between the two runners, rides the lead runner's shoulder into a medium shot`.
  - A piece with its own motion grammar writes it once, where every shot reads it — what motion leaves on screen and how the camera behaves: `fast limbs smear and trail speed lines, every landed hit flashes the background hot pink; the camera keeps moving, riding a fist within inches of the lens`. Unwritten, a moment no shot moves holds still.
- BGM — take the mood from `direction.ts` (`brief.tone`, the sequence's `pleasure`).
- SFX — name the source event in the frame it lands on, one event per asset.

## Coverage shot (video)

- A `coverage: true` shot is one take the model cuts inside — write the exchange beat after beat; the beats are the body.
- Write the quick detail cuts as a beat (always) — each insert, in order: `quick detail cuts: Rue's narrowed eyes, Mina's tightening glove, the swinging dog tag, then the camera dives under the spin kick`. Unwritten, the model holds one angle.
- Rehearse first:
  1. The adapter's turbo switch on (`useTurbo: true`) at the working size, `konte generate video`, `konte-video-critic` on it; the human accepts or comments in `konte preview video`.
  2. Switch off and `konte reroll` — `generate` skips the accepted rehearsal. `konte-video-critic` on the full take; the human's accept of it replaces the rehearsal.

## Reference preflight (image & video)

Look at the actual upstream image before writing about it.

- Read the ready reference variant when: the asset consumes a source/first/last/reference image; a recurring character's identity must hold; matching an accepted variant; the user asks for consistency.
- Skip when: drafting an initial prompt before any variant exists.

1. `konte inspect <this-asset-address>` → "Dependencies" — the image-producing deps, never eyeballed from the source file.
2. `konte probe image <dep-address>...`; no ready variant → skip and proceed.
3. Open the printed images; `probe crop` for detail.
4. Match what you actually see — outfit, palette, framing, lighting tone, accessories; don't invent details that contradict the reference.
5. Write the identity as discriminative prose — the details that separate this subject from a generic one (coat colour and stripe direction, the cut and shade of a garment). The reference image alone does not carry identity across an edit model.

## Performance (image & video)

- Write the performance toward its target — "anxious" becomes "leans toward her companion, eyes searching his face for a response" when the shot calls for seeking reassurance. Name whom or what the gaze and posture address.
- Ground the performance in the shot's `action` and the character's personality, under `brief.tone`; a gesture expresses that intention without adding a motive or story beat.
- Describe facial cues at the staged scale — in a close frame, state the head's tilt and turn, visible facial planes, brow and mouth shape, and pupil placement toward the gaze target; in a wide frame, express the performance through posture and limbs.
- Write a keyframe as a held instant — an action verb can pull the model through it: an opening is "fingers pinch the note's top edge, its lower edge hovering a hand's width from the board"; "presses the note onto the board" belongs in the motion prompt. An opening take that completes the action is redrawn from a rewritten opening, never patched.
- An animatic panel states the body in full — torso orientation, each visible arm and leg's direction and bend, hand and foot positions, and the surfaces visible from the staged camera. For an upward gaze: "torso faces the camera; head tilts back toward screen left, chin underside visible; pupils high and toward screen left, whites visible below; the raised hand is off the upper-left edge of frame."
- Two figures in contact are told apart by one visible axis, written at every contact — the attribute that separates them at the staged scale (a red coat against a grey one), restated wherever their bodies cross, trade blows or overlap: `the gloved woman blocks; the bare-knuckled one ducks under`. Named only by name, they swap identities mid-contact.
- An animatic panel places contacts, overlaps and gaps explicitly — name what touches what, which object is nearer the camera, what occludes what, and which frame edge crops each part. Describe a required gap by its visible shape, screen position and thickness relative to an object in frame, alongside the physical distance.
- Sides are the frame's, never a figure's — `screen left`, `off the right edge of frame`; a hand recurring across adjacent shots has its side and grip written so (`image-left`, the thumb's direction).
- A figure turned toward the lens is mirrored — what sits on its left sits on the frame's right, so "the sword at his left hip" hangs it off the wrong side; a worn or carried object, and which hand reaches for it, as much as a gaze.
- A reverse cut holds its axis only if both halves name the edge the gaze leaves by — unstated, each subject renders squared up to the lens and the pair loses the line.

## Project-wide consistency

- Read the sibling prompts in the same definition file first and align with them unless the user asks for a break — style-layer and lighting vocabulary, camera/motion vocabulary, character-preservation phrasing, the same voice parameters per speaker.
- Strip body words from a style layer reused where no one stands — proportions, skin or faces draw a figure in.

## Self-review

Re-read the result cold against:

- Every element the adapter's guide asks for is present, in its shape and length.
- Only positives.
- No parameter-level control in prose.
- Sides are the frame's, and `script` lines pass as injected.
- The shot reads from the prompt alone — for an animatic panel, reconstruct the pose, gaze, contacts and gaps from the written details; write in any relation supplied only by knowing the intended action.
