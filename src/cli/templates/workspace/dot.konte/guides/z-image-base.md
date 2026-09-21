# Z Image

A reference off this model is what the production reads. Write it for legibility — bone and build, hair, skin and eye colour, the cut and material of each garment, the props; a place, its layout and surfaces. One subject per asset, and one further asset per view a later model needs: a neutral full-length, a medium close-up, a profile, a costume detail.

Leave out cinematic backlight, a strong grade and shallow depth of field — each buries the structure. Where the reference is the piece's own drawn look, take `imageKrea2TurboT2i`.

## Prompt Shape

```
[composition/camera angle], [subject + appearance], [setting/background], [color treatment], [light + time of day], [overall mood/style]
```

Flowing prose, one clause at a time, each named concretely — "deep cobalt blue", "warm brown bark", "low-angle upward shot". At the long end, split into two or three paragraphs: subject, environment, then light and mood.

English and Chinese are the trained prompt languages.

## Length

~60–200 words. Past ~200 the later clauses dilute the earlier ones.

## Sampling

- `steps` 30–50 sharpens fine detail, at linear cost.
- `cfg` 3–5. Below 3 the prompt loosens; above 5 colors saturate and edges harden.
- 1–2 megapixels is the trained size range; far above it, structure repeats.

## Negative Prompt

- **Exposed and effective** — `cfg` runs above 1, so guidance is live. Fill it with short generic artifact terms ("blurry, extra fingers, watermark, text"), not scene content.
- A scene exclusion belongs in `prompt` as what fills the space instead. A custom adapter may differ — check its schema.

## Avoid

- Keyword lists — this model reads prose.
- Evaluative filler ("masterpiece, best quality, 8k").
- Naming an exclusion in `prompt` — describe what occupies the space.
- Embedding resolution, step count, or seed values in the prompt text.
