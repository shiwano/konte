# Seedance 2.5

## Prompt Shape

```
[Shot/framing], [camera movement], [subject description], [action beats], [setting/environment], [lighting/palette], [style/grade], [audio/foley cues]
```

Rewards richly detailed, multi-aspect prompts.

- Sequence action beats chronologically — bundled simultaneous motions tend to get dropped.
- Kinetic verbs ("snaps", "lunges", "erupts") over generic ones ("attacks", "hits").
- Name concrete sounds — gravel underfoot, rain on tin, a fan spinning down. They set the motion's implied timing.

## Length

Hero shots: 200–400 words; inserts/cutaways: 80–150.

## One take, several beats

Write the whole sequence — whatever you leave unordered, the model orders for you.

- Stage the beats — one primary change per stage, and name what is on screen when the stage ends.
- Or write a timed shot list ("0–6s …", "6–12s …"). A range allocates a share of screen time, not an exact frame.
- Don't overlap the ranges or leave a gap between beats.

## Image-to-video

- Repeat only 3–6 key anchors of the source image (hair, clothing, age, silhouette, distinctive accessories).
- No pronouns as sole subject references — "the silver-haired woman in the navy peacoat walks forward", not "she walks forward".
- Name what the camera does hold — `one continuous take`, `a locked-off camera`.

## References

- A tag's ordinal is the reference's position in its input array.
- Give each reference a role in the sentence — "@Image1 is the potter: her face, her dark green apron".
- A reference no tag reaches is spend for nothing; a tag with no reference behind it lands on whichever reference took that ordinal.

## Cost ladder

- Open at `resolution: "480p"` — `"720p"` once the take holds, `"1080p"` only for the take that ships with no delivery upscale.
- `bitrateMode: "high"` is an encode — the last rung, on the shipped take alone.
- Leave `generateAudio` on; turn it off only where the stem or the mux carries the sound.
- Leave `duration` unset in a shot — konte passes the shortest length that holds it; `"auto"` lets the model pick.
- On R2V, every reference is paid for — pass the ones the shot needs.

## Avoid

- Negative text — the model takes none; phrase every exclusion as what fills the space instead.
