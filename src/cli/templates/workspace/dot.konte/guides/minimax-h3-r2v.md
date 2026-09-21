# MiniMax H3 R2V

Picture and stereo audio decoded from one take.

## Length

- **`detailedDescription`: up to 500 English words.** Dialogue-dense content fits the whole spoken timeline.

## References

- **`<Video N>` is numbered as `<Picture N>` is; `<Audio N>` is a copied or referenced signal, ordered under Reference Audio.**

## Task Type

- **`keyframe completion`, `reference generation`, `video editing`, `video continuation`, `audio reuse`, `audio reference`**, several together where they apply.

```
<Video 1> (cut and pacing structure): weak_reference - …
<Audio 1>: partially_copy - …
```

## Keyframes

- **`startImage` pins the take's first frame pixel for pixel, `endImage` the frame just past the shot** — the shot's last shown frame leads into it. Neither takes a `<Picture N>` tag. To name the frame in the prompt, pass the same panel as `image1` (and `image2`) and write it as `keyframe completion` (`<Picture 1> is the first frame of [Shot 1].`, `<Picture 2> is the last frame of [Shot 1].`). A panel passed as `image1` alone holds the composition without fixing it.
- **With `startImage` alone, develop forward** — the pinned frame carries the set, composition and light; write the action's onset, its continuous development, and the result or reaction it lands on, and describe the set only where the motion reveals or changes it. Identity, clothing, colours, key objects and spatial relationships hold across all of it.
- **With both frames, favour one shot**; cut only when the shot needs it. Write the path — the onset, the observable intermediate changes, the differences narrowing, the landing.
- **With `endImage` alone, converge on it** — infer the state the shot opens in, then write the subjects, objects, camera and light closing on the pinned frame, landing on it in the last shot.

## Clips

- **`video1`…`video3` are `<Video 1>`…`<Video 3>`** — 2–15s of 24fps footage, five frames minimum, truncated to the take's own length, so a reference longer than the shot contributes only its opening.
- **`<Video N>` is a whole-video relationship, never visible content** — an edit source, a continuation, a borrowed cut rhythm. A person, prop, set or move taken out of a clip is a `<Subject N>` like any other, sourced from it (`whose walking motion comes from <Video 1>`). A clip that lends only its camera or pacing is `reference generation`, not `video editing`.
- **`video editing` and `video continuation` are for a clip actually edited or continued** — the edit opens its summary with `The target video is an edited version of <Video 1>.`, and keeps `audio reuse` alongside whenever the original track stays audible.

## Shots and Cuts

- **Cut verbs** — `the camera cuts to`, `the shot cuts to`, `the shot transitions to`, `the shot changes to`, `the shot switches to`. Cross-dissolve, fade and wipe only when the shot asks for one.
- **A cut has to bring new information** — subject, space, state, viewpoint or time. If only the distance or the angle shifts, move the camera instead.

## Camera Motion

Motion type, then amplitude, then speed — written as a natural English action inside the shot, never stacked as labels at the end of a sentence. Medium amplitude and normal speed are the default, so leave them off.

- **Every shot names its camera** — an unwritten one drifts and reframes on its own. A held frame is `the camera holds a static shot`.
- **Motion type** — `Zoom In`/`Zoom Out` (focal length, body still), `Push In`/`Pull Out` (body forward/back), `Pan Left`/`Pan Right`, `Truck Left`/`Truck Right` (body translates), `Tilt Up`/`Tilt Down`, `Pedestal Up`/`Pedestal Down` (body rises/drops), `Arc Shot`, `Tracking Shot`, `Static Shot`, `Shake Slightly`/`Shake Strongly`, `POV`, `Roll Clockwise`/`Roll Counterclockwise`.
- **Amplitude** — `with small amplitude` / `with large amplitude`.
- **Speed** — `at slow speed` / `at fast speed`.
- **Amplitude does not size a push-in.** `small` and `medium` land in the same extreme close-up, and a seed reroll reproduces it. Size the move by the frame it ends on instead — what is still in shot at the last frame, and how much larger it has grown.

```
The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
The camera holds a static shot as the runner exits the frame.
```

## Static Subject, Moving Camera

- **Freeze by enumeration** — name every object in the frame, each holding the position, angle and place it has in the first frame, and close on `and nothing slides, turns, tilts, enters or leaves`. A short freeze ("nothing in the scene moves", "this is a completely frozen still picture") leaves the subject drifting.
- **Then move, named as the exception** — `The camera, however, does move:` keeps the freeze off the camera.
- **`static` stops the camera too, wherever it sits** — write `the camera holds a static shot` beside a freeze clause only when a locked-off frame is the shot.
- **The move still overshoots on some shots** with the landing frame written out. The fallback is a locked-off frame and no move at all.
- **The freeze clause is the one exclusion the adapter lets through.**

## Lips

- **Every line closes its own mouth** — the words are followed by the lips meeting and the speaking motion stopping. Without it the mouth keeps moving past the line.
- **A voiceover block is followed immediately by the on-screen character's lips staying closed** — `<d>[English] I still remember that road.</d> while his lips remain completely closed.`
- **A reused line sits at the mouth that speaks it** — `her mouth shaping the words of <Audio 1> as they sound`.

## Reference Audio

- **A clip's own soundtrack is `video1Audio`…`video3Audio`** — the same clip handed a second time, beside the `video1`…`video3` it belongs to; without that clip it is refused.
- **The `<Audio N>` order is `video1Audio`…`video3Audio`, then `audio1`…`audio3`** — count the wired slots in that order and number them from 1.

## The Stem

- **A line a mouth has to match is `animatic.stem` passed as `audioStem`** — it takes no `<Audio N>` tag, no `audio reuse` / `audio reference` task type and no `retentionAnalysis` line; the words in `<d>` are the recording's own, verbatim, as in a reuse.
- **An effect in the stem times the action that makes it** — name it at that action in `detailedDescription` (`her fist landing on her chest exactly on the dull thump in the soundtrack`), and in `overallSoundscape`.
- **The clip arrives with its track baked in** — a composition plays it with `<Video hasAudio>` alone; a second `<Audio src={animatic.stem} />` over that take double-tracks the line.
- **Narration goes in neither slot** — konte keeps it out of `animatic.stem`; a shot whose only line is narration leaves `audioStem` and `audio1` unpassed, lets the take carry only its soundscape, and plays `<Audio src={animatic.shot(id).narrationStem} />` over `<Video hasAudio volume={…}>` in the composition.

## Clip Length

- **Omit `length`** — it defaults to the shot's `duration × 24`, snapped up to the model's grid (one frame more with `endImage`).
- **The rungs are `17k + 5`** — a value between them rounds up. The trained floor is 124 (≈5s).
- **The clock is 24fps** whatever the project's rate — moving `fps` off it without `length` rescales the motion and slips the audio.

## Cost ladder

- **`steps` is where the time goes** — changing it re-samples the take, so it is picked once and left.
