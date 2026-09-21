# Seedance 2.5

## Prompt Shape

```
[Shot/framing], [camera movement], [subject description], [action beats], [setting/environment], [lighting/palette], [style/grade], [audio/foley cues]
```

Rewards richly detailed, multi-aspect prompts — the longest of all supported models.

- **Sequence action beats chronologically** — bundled simultaneous motions tend to get dropped.
- **Kinetic verbs** ("snaps", "lunges", "erupts") over generic ones ("attacks", "hits").
- **Replace emotion words with visible physical causes** ("nervous" → "fingers drumming on table, eyes darting to the door").
- **Name concrete sounds** — gravel underfoot, rain on tin, a fan spinning down. They set the motion's implied timing, and with audio on they are what the soundtrack acts on.

## Length

Hero shots: 200–400 words; inserts/cutaways: 80–150.

## One take, several beats

A single generation carries several connected shots. Write the whole sequence — whatever you leave unordered, the model orders for you.

- **Stage the beats** — one primary change per stage, and name what is on screen when the stage ends.
- **Or write a timed shot list** ("0–6s …", "6–12s …"). A range allocates a share of screen time, not an exact frame.
- **Don't overlap the ranges or leave a gap between beats.**

## Dialogue

Spoken lines go in double quotes — that is what triggers lip-sync.

## Image-to-video

- **Don't fully re-describe the source image** — repeat only 3–6 key anchors (hair, clothing, age, silhouette, distinctive accessories).
- **No pronouns as sole subject references** — "the silver-haired woman in the navy peacoat walks forward", not "she walks forward".
- **Describe progression** — what changes from the start frame to the end state.
- **Camera negation can help** — state what the camera is NOT doing ("no cuts, no zoom, no stabilization").

## References

References are addressed by ordinal, numbered by their position in the input array. Write the tag in the form that adapter's input description gives: `@Image1` on FAL.

- **Give each reference a role in the sentence** — "@Image1 is the potter: her face, her dark green apron".
- **A reference no tag reaches is spend for nothing**; a tag with no reference behind it lands on whichever reference took that ordinal.

## Cost ladder

- **Open at `resolution: "480p"`** — `"720p"` once the take holds, `"1080p"` only for the take that ships with no delivery upscale.
- **`bitrateMode: "high"` is an encode** — the last rung, on the shipped take alone.
- **`generateAudio` costs the same either way** — leave it on; turn it off only where the stem or the mux carries the sound.
- **Pass the shot's `duration`, a whole second at or above its span** — `"auto"` lets the model pick.
- **On R2V, every reference is paid for** — pass the ones the shot needs.

## Negative Prompt

- **None.** The model takes no negative text — phrase every exclusion affirmatively, as what fills the space instead. A custom adapter may differ — check its schema.

## Avoid

- Pronouns as sole subject references — always anchor with visual attributes.
- Generic verbs when a more specific kinetic verb exists.
- Abstract emotion labels without accompanying visible physical detail.
- Baking duration, aspect ratio or resolution into the prompt text — those are inputs.
