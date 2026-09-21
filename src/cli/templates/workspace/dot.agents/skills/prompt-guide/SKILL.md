---
name: prompt-guide
description: Write the prompt text of an asset() — image, motion, voice, BGM, SFX — and route to the adapter's own guide. Read before writing or editing any asset() prompt.
user-invocable: false
---

Turn fixed staging into `asset()` prompt text; done = the self-review below passes against the adapter's guide and the shot. A shot's production method and beat design are outside this guide.

## Stage before you write

**Read `staging-guide` and fix the shot's staging before writing a shot's prompt — an animatic panel or a motion clip — every time, not once per session.** Staging you never stated reads as fixed from inside the prompt.

## Before writing

When writing or editing a prompt-like field (`prompt`, `text`, `lyrics`) in an `asset()` call:

1. **Run `konte adapter show <adapter>`, read every file its `guide` lines name, in order, and defer to them** — they carry prompt shape, length, and per-anchor advice, and the input table's DESCRIPTION column documents the non-obvious parameters (negative-prompt and audio policy included). A model's decodes share their first files; read a shared one once. With no guide or descriptions shown, read the adapter file's input schema.
2. **Inspect the non-prompt parameters** (`aspectRatio`, `duration`, `resolution`, `negativePrompt`, voice/seed/format, image/audio references) — don't move parameter-level controls into prompt text.
3. **Reference-consuming prompts (an edit, pinned frames, references, a source image)** — how much of the source to restate, how to ask for a size or angle it doesn't already have, which reference belongs in which slot, and how a reference is tagged in the prompt body are the model's call — take them from the guide in step 1. **When a reference has to carry a layout** — a framing guide, labelled regions, several assets composited into one plate — build it with `adapters.jsxImage` (`konte adapter show jsxImage`).
4. **Schema wins over model doc** when they disagree.

## What a prompt names

- **Name what occupies the space, never what to leave out** — a model conditions on the words it is given, so `no outlines` draws outlines. Write the positive: `flat washes meeting edge to edge`.
- **An exclusion belongs in `negativePrompt`** — the one field a model reads it in.
- **Write the scene description as a plain string literal, inline and fully spelled out** — boilerplate that must stay verbatim across shots (a canvas preamble, a character-preservation clause) may be a shared constant.
- **One sentence first** — write the action once and let the model do it. Add amplitude, count, speed or a stopping pose only for the term a take actually missed: conditions stack faster than a model holds them, and each dropped one drags the rest of the sentence with it.

## Per kind

- **reference** — no staging pass: plain background, even lighting, subject centred, ~10% margin, since background detail binds into the identity.
- **`brief.look`'s medium decides what a reference has to be** — drawn or stylized, the reference **is** the look, so it arrives at finish quality: line weight, palette, shading and deformation are the character information. Live action, it is an identification asset — write build, garment cut and material, and leave out cinematic backlight, a strong grade and shallow depth of field, each of which buries the structure a later model reads off it.
- **voice sample** — a cast voice's `reference:<id>` is a specimen of a timbre, not a line of the piece: an adapter whose description says it designs a voice, an everyday sentence with nothing in it to act, the roster's `voice.description` reduced to timbre. A delivery baked into the sample is inherited by every line pointed at it. Sex never moves — a male role needs a male sample.
- **spoken line** — `{ narration }` is one voice held level across the piece, `{ character }` a person acting inside a shot. Narration takes a clone adapter pointed at the sample, so the timbre holds across every take; a character line takes one that **acts**, with the sample as its voice reference and the delivery written into the prompt — what the speaker is doing, at what volume, from where in the range, at what tempo, what the breath under it is doing. `konte adapter list` says which each adapter is; a clone's emotion and rate controls adjust a read, never build a performance.
- **Translate the line's `acting` into verbs and adverbs — never invent one** — the prompt says the shot's `acting` note in the model's own terms (what the speaker is doing, and how) and adds nothing the note does not claim. A delivery you made up is rewritten on the next reroll.
- **Two characters' lines in one call only work on a model that takes speaker tags** — on any other, give each speaker its own take.
- **Either kind's words** — pass the injected `script.<who>[n]` as it stands; a paraphrase, a retyped copy or a wording fix is a `direction.ts` edit. A word THIS model reads wrong is respelled at the take with `respell(script.<who>[n], "…")`. A `ja` line's notation is `direction-guide`'s `japanese-notation.md`.
- **motion** — realize the movement the panel's `blocking`/`camera` fixed; read them in `animatic.tsx`. A pinned first frame already shows the set — the prompt names what moves and what the motion reveals.
- **BGM** — take the mood from `direction.ts` (`brief.tone`, the sequence's `pleasure`).
- **SFX** — name the source event in the frame it lands on, one event per asset.

## Reference preflight (image & video)

Look at the actual upstream image before writing about it.

- **Read the ready reference variant when:** the asset consumes a source/first/last/reference image; a recurring character's identity must hold; matching an accepted variant; the user asks for consistency.
- **Skip when:** drafting an initial prompt before any variant exists.

1. **`konte inspect <this-asset-address>` → "Dependencies"** — enumerate the image-producing deps authoritatively, not by eyeballing the source file.
2. **`konte ref <dep-address>...` → one canonical file path per address, in the order given**; non-zero exit = no ready variant → skip and proceed.
3. **Open the printed path as an image.**
4. **Match what you actually see** — outfit, palette, framing, lighting tone, accessories; don't invent details that contradict the reference.
5. **Write the identity into the prompt as discriminative prose** — the details that separate this subject from a generic one (coat colour and stripe direction, the cut and shade of a garment), spelled out. Handing an edit model the reference image alone does not carry identity across.

## Performance (image & video)

- **Write the subject as an actor, not an inventory** — lead with what it does and wants, in progressive action verbs ("leans its weight into the bag"); a coordinate list ("facing right, head raised, one paw touching the base") sits outside caption language and renders stiff, unrelated figures.
- **Pull the acting words from `direction.ts`** — `brief.tone` and the roster entry's personality, not per-shot invented adjectives.
- **An opening keyframe's verb is the motion prompt's** — performance verbs pull the model into completing it, so "presses the note onto the board" comes back pressed. Write what the opening instant holds as positives — the weight, the grip, the gaze — and redraw a take that completes it from a rewritten opening, never patch it.
- **Geometry earns its place** — keep only the spatial facts the shot cannot survive losing (the contact, what sits between whom, the gaze axis).
- **Sides are the frame's, never a figure's** — `screen left`, `off the right edge of frame`. **A figure turned toward the lens is mirrored: what sits on its left sits on the frame's right**, so "the sword at his left hip" hangs it off the wrong side — a worn or carried object, and which hand reaches for it, as much as a gaze. A reverse cut holds its axis only if both halves name the edge the gaze leaves by; unstated, each subject renders squared up to the lens and the pair loses the line.

## Project-wide consistency

- **Read the sibling prompts in the same definition file first and align with them** unless the user asks for a break — style-layer and lighting vocabulary, camera/motion vocabulary, character-preservation phrasing, the same voice parameters per speaker.

## Self-review

After writing, re-read the result cold against:

- **Every element the adapter's guide asks for is present**, in its shape and length.
- **Only positives.**
- **No parameter-level control in prose.**
- **Sides are the frame's**, and `script` lines pass as injected.
- **The shot reads from the prompt alone.**
