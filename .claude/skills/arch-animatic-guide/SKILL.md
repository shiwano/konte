---
name: arch-animatic-guide
description: Read when touching the animatic stage — <Panel> and its windows, the derived stem, the cross-stage gate it holds, and what its review shows that the video's does not.
user-invocable: false
---

The board on the direction's clock, with the shot's lines sounding over it. Not audio muxing (`arch-audio-guide`) nor the review UI (`arch-review-system-guide`).

## One shape, two stages

`defineAnimatic` and `defineVideo` are the same builder (`dsl/stage-define.ts`) over the same `StageDefinition`, which carries its own `stage` field, so every consumer formats the definition's own addresses. A leaf lister, predicate or cascade that hardcodes `video` silently does nothing for the board. Both walk the direction with the same chain and starter, both return `{ shots, soundtracks? }`, and both build a `<Composition>` per shot.

What differs is what may go inside:

- **`<Panel>` is the animatic's** — it carries the part name `video.tsx` reaches it by, the slot it holds on the shot's clock, the movement leaving it, and the frame `probe contact-sheet` tiles. A plain `<Image>` beside it is a layer, not a keyframe. A developed narrative shot with none is `PANEL_REQUIRED`; a graphic shot may hold none, and one outside a `<Cutin>` there is `ANIMATIC_INVALID`.
- **`<Video>` is the video's** — anywhere in an animatic it is `ANIMATIC_INVALID`, raw markup included. A graphic shot's picture is the composition's own layers, finished on the board, and the video places the same component.

`video.tsx` reaches the board through the imported ref — `animatic.shot("01").image("first")`, `.stem` — each checked against what that shot declared, so an unknown name or a kind mismatch throws at load. A video shot that spends yet builds nothing on the board it develops is refused outright (`ANIMATIC_UNCONSUMED`); one assembled from `file`/`local` takes no board input, so only `doctor` reports it. An undeveloped `pendingShot(id)` carries nothing of its own; its black tile is backed by the direction's `action` (and, on the board, its `script`).

**Asides.** The video authors an aside like any shot (`asideShot(id, build)`, usually one `file`); the animatic never boards one (`asideShot(id)`) and konte fills the span with its own labelled slug. Each starter is pinned to its kind at the type level. A board aside carries no `shotFn`, so it is not review work there; it is not `pending` either, so export never refuses over it, `status` never asks for it to be developed, and `ANIMATIC_UNCONSUMED` passes it over.

## Panel windows

`<Panel start>` pins when a keyframe takes over, in shot-local seconds. Omitted, a panel divides what the pins bracketing it leave (the pinned panel opening a gap holds its first slot; the shot's ends stand in where there is no pin) — with nothing pinned, the even whole-shot division. So `[—, 5, —]` over a 6s shot is `[0, 5, 5.5]`. Each holds until the next one's `start` — the last to the shot's end — and then CUTS; konte never interpolates between two frames, so a dissolve is written with `<Animate>`. Non-monotonic pins, and any start outside `[0, duration)`, are load errors.

**The windows are resolved once, by the definition, and paired back by position.** `<Panel>` runs inside `renderToHtml`, and by the real render its `src` is a served URL rather than an address — so the part name cannot pair it with its entry. `Composition` resets a cursor as each shot begins and each panel takes the next (`panel-collect.ts`), which is exactly document order.

**A `<Cutin>` is a second lane.** It renders its children itself through `renderInContext` with `lane: "cutin"` — a component's returned element renders only after it returns — so a `<Panel>` inside records into the cutin lane, pairs against `cutinPanels` on its own cursor, and lands in `shot.cutin.panels`, windowed on the same clock. `partitionShotRefs` counts the `<Cutin>`s and collects the refs drawn inside (`shot.cutin.refs`, on both stages), which `defineStage` checks against the direction (`CUTIN_REQUIRED` / `CUTIN_UNDECLARED`). A part name is the shot's across both lanes.

**`blocking` / `camera` never reach the HTML.** They are the movement out of a panel — the subject, and the camera — across the span to the next keyframe, or, on a shot's only panel, to the shot's end: prose in the working language that `video.tsx` reads when it writes its motion prompt, so they are written from the take, a review prerequisite gated at `preview` / `accept`. Discovery rejects them only on a multi-panel shot's last panel, the landing frame nothing moves out of — unless the next shot runs on from that lane in one take (`ShotDefinition.continuedBy`): the last panel then owes the transit like any other (`arch-direction-guide`, Join). They are collected the way `asset()`'s prompts are, so they fall outside the composition's definition hash. Rewriting a move after the take came back asks for no re-accept and no reroll; it is hashed on its own axis (`panel-move-hash.ts`), read only by the comments written on the panel.

## The stem

`animatic:shot.<id>#stem` is the shot's `<Audio>` cues mixed down and **clamped to the shot's `duration`** — a materialized leaf like `video:*#stem`, over the same `stemRefs` and the same structure hash (`stemDefinitionHash`; the board's folds the clamp in, so a retimed shot is a different stem). `video.tsx` takes it through `animatic.shot("01").stem`.

**Narration is mixed apart** into `#narrationStem`, which only `<Audio>` takes (`NARRATION_UNPLACED` wherever both stages load).

What the materialization writes is the one difference between the stages' stems: the delivered stem is a manifest (muxed at export), the board's is the real mix — `materializeShotStem` runs `mixAudioTracks` over the cues. Nothing generates it: the review page mixes the cues live, and the shot's accept materializes the stem over the takes it just signed off, an unchanged accept minting nothing; `konte accept animatic:shot.<id>#stem` does the same by address.

**The clamp is konte's, not the author's** — a model of this kind reads the clip length off its input audio, so an unclamped stem would let a TTS take, not the direction, decide how long the shot runs. A sound that must cross a cut belongs in the video build's `<Audio>` (full length, never clamped).

**What the clamp cuts is caught either side of the spend** — a truncated stem is exactly as long as the shot, so nothing downstream tells it from one that fits. `assertCuesFitShot` (`core/clip-fit.ts`) throws `CUE_OVERRUNS_SHOT` at load, off the declared length; `findAnimaticOverflows` (`core/animatic-overflow.ts`) measures recorded lengths after, surfacing as status' **Needs retiming** and a `probe reel-audio` warning, counting an unmeasured cue. `tightenDerivedClipLengths` holds a `fill: "speech"` count inside the cue's window first, re-validating at what it narrowed to; it trips the check only where the grid fits nothing. A derived count left under half its words' estimate, the take's lead-in (`BASE_SEC`) aside, throws `CUE_WINDOW_TOO_SHORT` from the same check — the take would come back rushed.

**Never the delivered stem into a motion model** — it may contain audio generated FROM the picture, so `stem → motion → stem` would cycle. The video build is handed no handle to it; the only stem it reaches is the board's.

## The gate is the ordinary one

There is no animatic-specific spend gate. `GATED_UPSTREAM` lists `[reference, animatic]`, and `assertUpstreamAccepted` does the rest: a video asset consuming `animatic:shot.01.first` needs that keyframe accepted, one consuming `animatic:shot.01#stem` needs the stem accepted. The gate's width is exactly what the spend consumes.

**A stale accept does not pass.** The mix is reviewed at the board, but every stem is DETERMINISTIC (`isDeterministicAddress`), and strict resolution refuses a stale accept on either axis (`selectResolvedVariant`, via `ResolutionDefinitions.isDeterministic`). So re-picking a voice take, or editing a cue, ages the stem out, `status` lists it under Needs review, and the shot's next accept re-mixes it — no `generate` in between.

**The cast is gated here too.** `assertVoicesAccepted` runs for `animatic` as for `video`, and only `reference` — where the sample is made — is exempt.

**Whole-stage prerequisites still apply**: a board with one unwritten `blocking`/`camera` stops every video spend.

## Review

`konte preview animatic` is `konte preview video`'s page, handler and submit (`reel-review.ts`, told which stage by the definition it is handed): one reel played through, one verdict per shot folding its `#composition`, its stem and the takes they rest on, takes picked in the variant gallery, comments pinned at the playhead on `animatic:shot.<id>`.

Both print the board's `blocking` / `camera` in the selected shot's detail.

Two differences:

- **No stand-in.**
- **Needs retiming** reads the shot's cues against the clamp.

On the video side the only trace left is the **stand-in**: a shot whose delivered composition cannot be drawn yet plays the animatic shot of the same id, spliced in from the animatic's own render plan (`RenderPlan.standInPlan`). Display only — no address, no node, no verdict: its toggle is closed and a decision on one is dropped at submit. Which shots stood in comes from the client (`displayedStandInShotIds`), never re-derived, because a build dependency finishing mid-review would otherwise flip the answer and accept a composition nobody watched.

**Order matters inside a submit.** The audio takes a stem is mixed from are accepted before any composition is materialized: an animatic composition's identity covers its audio, so building it first would fingerprint the take the reviewer replaced and read stale the moment the review saved.
