---
name: production-guide
description: Choosing each shot's production method — composition vs generation, which frames to pin, references or the stem, and the adapter that offers them. Read before a shot's panels are drawn and again when its motion is wired.
user-invocable: false
---

Choose each shot's production method; done = its required anchors and duration are supported by the selected adapter or composition. Shot design belongs to `direction-guide`, wiring to `authoring-guide`, prompt text to `prompt-guide`.

## Routing — decide in this order

**The shot names its anchors; the anchors pick the adapter.**

1. **Does it need AI generation at all?** A Ken Burns push/pan/zoom **over a static image**, a subtitle / UI / card reveal, or trimming and placing existing footage → staged in `<Composition>` (`composition-guide`), wired as a `file` asset, or done with a `local` adapter (`imageResize`, `imageCrop`, `videoTrim`) — **not generated**. (A camera move that should also stir parallax, hair, light or background is generated motion — step 4.) A `graphic` shot's picture always stops here; its `cutin` is routed from step 2 separately.
2. **Is a performance the driver?** A spoken line, singing, dance, an instrument, any motion timed to a track → the sound and the picture have to come out of **one pass**. Decide this **before** step 4 — a performance can have a clear end and still belong here.
   - **The stem rides in one of two ways** — as the take's own track (the given recording, exact timing; the input takes one file, the shot's `animatic.stem`) or as a voice reference (re-spoken by the model in that timbre, on its own timing). A line a mouth has to match takes the first.
   - **Muxing an authored voice over a take that generated its own audio is not the fallback** — see Pitfalls.
3. **Does it carry material or continuity?** A recurring character, a specific product / logo / real person, a look matching an **already-accepted visual** → anchor on generated material, **never text alone**. A general style or world tone alone can still be text alone.
4. **Which anchors does the shot need — the ones it needs, not the ones already drawn.**
   - **A pinned first frame — the default** → the take opens on the shot's board panel (below).
   - **A pinned last frame too** → only where the viewer must see that exact picture (below).
   - **Carried subjects, a recorded move or a voice** — several recurring figures in one frame, an identity holding across sheets, a look no panel drew → references.
   - **The stem as the take's own track** — from step 2.
   - **No panel to open on** (an aside, which the board never draws) → text alone, or references by step 3.
5. **Pick the adapter that offers every anchor named, and reaches the shot's length** — `konte adapter list --backend <kind>`, then `konte adapter show <adapter>` for its inputs. **None on the backend offers them all → change adapter, or drop an anchor deliberately and say which** — quietly settling for less ships a shot missing the one thing it needed. A shot longer than the model's maximum clip → Past the model's clip cap.
6. **Keep iteration cheap** — see Cost ladder.

## References — carried, not pinned

- **Tagged references build the shot** — images, and on some models clips and audio: subjects, sets, costumes, styles, a recorded move, a voice.
- **References steer, they do not pin** — a panel passed as a reference carries framing, palette and style; its pixels do not open the clip. Only a first/last-frame anchor does.
- **Every reference is paid for on every sampling step** — pass the ones the shot needs, not the whole roster; the model's guide carries the per-reference cost and any cap.

## Pinning the first frame only — the default

- **One `<Panel>` per shot** — the take opens on it, motion steered by the prompt, the end pose left to the model. A board where most shots carry two panels is over-pinned.
- **Cheapest, and often more stable than pinning both ends** — short ambient cuts, generated camera moves, and shots where a natural expression or texture matters more than a precise end pose.

## Pinning both ends

Pin the last frame only where no plausible landing will do:

- a match cut into the next shot
- the seam of a declared long take (below)
- a reveal whose final framing is held
- a transform's finished state
- a set arrangement of several elements, or an expression the prompt keeps failing to reach — only after a reroll actually misses it

**"The action completes" never qualifies** — any plausible landing reads, and a cut hides endpoint imprecision that interpolation can't; a leap, a draw, a waking face all land on their own. Test: **could the prompt say where it ends, and would any plausible landing do?** Yes → don't pin the end.

- **Two pinned frames are less control, not more** — the model must thread a constrained path, and the authored `last` (an image edit plus its review) is paid before any motion.
- **The pair decides the quality** — if a viewer couldn't draw the one obvious trajectory between the frames, the model can't either, and the clip morphs.
- **`last` is `first` advanced one beat, never an independent generation** — derive it by an image edit changing only the intended delta; every unintended difference (lighting, lens, a background detail) is spent mid-clip as identity morph. Wire: the animatic shot declares two `<Panel>`s, the adapter takes them as its first/last-frame anchors.
- **A declared long take has one frame at its seam** — the shot after declares `join: "continuous"`, so pin this take's end to that shot's first panel (`endImage: animatic.shot("02").image("first")`) and open that shot's take on the same frame (`startImage`); `join-unpinned` asks for it. Generated twice, the seam is a cut with no cut in it.
- **A removal reverses the derivation** — edit models add reliably and delete poorly: generate the uncovered state as `last`, derive `first` by adding the covering element.
- **One axis of change, composition overlapping** (`staging-guide`'s one-mover rule). **Flip test before paying for motion**: toggle the two frames rapidly — "the same shot a moment later" interpolates; "a jump cut" morphs.
- **Match clip length to the action's real time** — over-long for the delta invents idle drift, too short warps.
- **The change spreads evenly over the clip and no prompt retimes it** — produce "action + hold" as a short pinned clip plus a composition trim/hold (live-rendered, free), not one stretched clip.
- **Far-apart endpoints are a shot smell** — usually two actions in one shot: add a mid keyframe, or split the shot at the direction.

## Past the model's clip cap — chain on a seam frame

- **Generate the shot in segments, each opening on a frame extracted from the one before** — `adapters.videoFrame`; `konte adapter show videoFrame` for where to cut and when not to chain. **The seam is a pinned first frame** — a reference holds the look but not the seam.
- **Each link inherits the last one's drift** — past a few segments the look walks; a longer take is usually several shots.

## Cost ladder — keep generation cheap to iterate

- **Open on the cheap pass** — the adapter's fast/low-fidelity mode (`konte adapter show` for the ladder). A slow-pass quality guard like a negative prompt is a second-pass tool for a drift you've _seen_, never a first-pass guess.

## Pitfalls

- **A voice muxed over a take from a model that generates its own audio** — the lips are conditioned on the written line, the words on a separate TTS pass, and the two start at different instants; no volume, offset or trim reconciles them. Route the voice into the take (step 2), or let the model speak it and drop the TTS.
