# MiniMax H3 R2V

Picture and stereo audio decoded from one take.

## Length

- `detailedDescription`: 350–1200 English words, spread over the shots by what each has to show — a take of few shots is no shorter. Dialogue-dense content fits the whole spoken timeline.

## Task Type

- `keyframe completion`, `reference generation`, `video editing`, `video continuation`, `audio reuse`, `audio reference`, several together where they apply.

## Keyframes

- A panel passed as `image1` alone holds the composition without fixing it.
- With `startImage` alone, develop forward — the pinned frame carries the set, composition and light; write the action's onset, its continuous development, and the result or reaction it lands on, and describe the set only where the motion reveals or changes it. Identity, clothing, colours, key objects and spatial relationships hold across all of it.
- With both frames, favour one shot; cut only when the shot needs it. Write the path — the onset, the observable intermediate changes, the differences narrowing, the landing.
- With `endImage` alone, converge on it — infer the state the shot opens in, then write the subjects, objects, camera and light closing on the pinned frame, landing on it in the last shot.

## Clips

- `video1`…`video3` are `<Video 1>`…`<Video 3>` — 2–15s of 24fps footage, five frames minimum, truncated to the take's own length, so a reference longer than the shot contributes only its opening.
- `<Video N>` is a whole-video relationship, never visible content — an edit source, a continuation, a borrowed cut rhythm. A person, prop, set or move taken out of a clip is a `<Subject N>` like any other, sourced from it (`whose walking motion comes from <Video 1>`). A clip that lends only its camera or pacing is `reference generation`, not `video editing` — `<Video 1> (cut and pacing structure): weak_reference - …`.
- `video editing` and `video continuation` are for a clip actually edited or continued — the edit opens its summary with `The target video is an edited version of <Video 1>.`, and keeps `audio reuse` alongside whenever the original track stays audible.

## Shots and Cuts

- Cut verbs — `the camera cuts to`, `the shot cuts to`, `the shot transitions to`, `the shot changes to`, `the shot switches to`. Cross-dissolve, fade and wipe only when the shot asks for one.
- A cut has to bring new information — subject, space, state, viewpoint or time. If only the distance or the angle shifts, move the camera instead.
- A coverage shot is one `[Shot N]` string, its cuts written inside it, never placed with `at` — the model times its own cuts, landing late on a pinned second. Its opening panel goes in as `image1`, no end frame. The 350–1200 words still hold.

## Camera Motion

- Motion type, then amplitude, then speed — written as a natural English action inside the shot, never stacked as labels at the end of a sentence. Medium amplitude and normal speed are the default; leave them off.
- Every shot names its camera — an unwritten one drifts and reframes on its own. A held frame is `the camera holds a static shot`.
- Motion type — `Zoom In`/`Zoom Out` (focal length, body still), `Push In`/`Pull Out` (body forward/back), `Pan Left`/`Pan Right`, `Truck Left`/`Truck Right` (body translates), `Tilt Up`/`Tilt Down`, `Pedestal Up`/`Pedestal Down` (body rises/drops), `Arc Shot`, `Tracking Shot`, `Static Shot`, `Shake Slightly`/`Shake Strongly`, `POV`, `Roll Clockwise`/`Roll Counterclockwise`.
- Amplitude — `with small amplitude` / `with large amplitude`.
- Speed — `at slow speed` / `at fast speed`.
- Amplitude does not size a push-in. `small` and `medium` land in the same extreme close-up, and a seed reroll reproduces it. Size the move by the frame it ends on instead — what is still in shot at the last frame, and how much larger it has grown.
- The move still overshoots on some shots with the landing frame written out. The fallback is a locked-off frame and no move at all.

```
The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
The camera holds a static shot as the runner exits the frame.
```

## Lips

- Every line closes its own mouth — the words are followed by the lips meeting and the speaking motion stopping. Without it the mouth keeps moving past the line.
- A voiceover block is followed immediately by the on-screen character's lips staying closed — `<d>[English] I still remember that road.</d> while his lips remain completely closed.`
- A reused line sits at the mouth that speaks it — `her mouth shaping the words of <Audio 1> as they sound`.

## Reference Audio

- The `<Audio N>` order is `video1Audio`…`video3Audio`, then `audio1`…`audio3` — count the wired slots in that order and number them from 1.

## The Stem

- A line a mouth has to match is `animatic.stem` passed as `audioStem` — it takes no `audio reuse` / `audio reference` task type and no `retentionAnalysis` line; the words in `<d>` are the recording's own, verbatim, as in a reuse.
- An effect in the stem times the action that makes it — name it at that action in `detailedDescription` (`her fist landing on her chest exactly on the dull thump in the soundtrack`), and in `overallSoundscape`.
- The clip arrives with its track baked in — a composition plays it with `<Video hasAudio>` alone; a second `<Audio src={animatic.stem} />` over that take double-tracks the line.
- Narration goes in neither slot — a shot whose only line is narration leaves `audioStem` and `audio1` unpassed and lets the take carry only its soundscape.

## Clip Length

- Omit `length`.
- The rungs are `17k + 5` — a value between them rounds up.
- The clock is 24fps whatever the project's rate — moving `fps` off it without `length` rescales the motion and slips the audio.

## Cost ladder

- `steps` is where the time goes — changing it re-samples the take, so it is picked once and left.
