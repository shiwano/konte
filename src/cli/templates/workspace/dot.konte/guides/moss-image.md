# MOSS-Image

- Write a reference for legibility — bone and build, hair, skin and eye colour, the cut and material of each garment, the props; a place, its layout and surfaces.
- One subject per asset, and one further asset per view a later model needs: a neutral full-length, a medium close-up, a profile, a costume detail.

## Prompt Shape

```
[medium] of [subject + appearance], [action/pose], [space: foreground, midground, background], [setting], [framing/camera], [light], [tone: palette, contrast, grain]
```

Open on the medium and the subject ("Studio photograph of …", "Wide photograph of …"), never on a verb. Flowing prose in two to four paragraphs, ordered by space or by the viewer's eye, each clause a visible fact named concretely — "belted camel wool coat", "soft key light from the front left". Describe the finished picture; the model reads no instruction ("make", "change", "keep").

English carries the most training data; Chinese is also trained.

## Length

~200–320 words for one subject. The model was trained on long captions; a short prompt drifts generic. Pad with new visible facts, never restatement.

## Text in Frame

- Quote the exact text in double quotes, with its carrier, position, typeface and colour.
- Write a line break into the prompt where the text must break; the model's own breaks land unpredictably.

## Sampling

- `steps` 25 is the fast rung; 50 is the official setting and sharpens fine detail, at linear cost.
- `cfg` 2.5–4. Raise it toward 4 for a short prompt; past ~6 colours saturate.
- 1–2 megapixels is the trained size range; 4 MP is the ceiling.

## Negative Prompt

- Exposed and effective. Keep the default short artifact list ("nsfw, worst quality, bad anatomy, watermark, jpeg artifact"), not scene content.
- A scene exclusion belongs in `prompt` as what fills the space instead.

## Avoid

- Evaluative filler ("masterpiece, best quality, 8k").
- Negated scene content in `prompt` ("no people") — name what is there instead.
