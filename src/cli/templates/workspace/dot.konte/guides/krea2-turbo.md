# Krea 2 Turbo

A drawn or stylized piece's references arrive at finish quality: the line, the palette, the shading and the deformation are the character information.

## Prompt Shape

```
[medium/style], [subject + appearance], [action/pose], [setting], [color palette], [light], [framing]
```

Two registers read equally well: a dense comma-separated clause string, or flowing prose. Either way the medium comes first — "1990s vintage anime cel animation", "vintage analog collage", "stylized digital painting", "macro photograph".

Name colors concretely: "azure blue", "pinkish-orange", "chartreuse", "muted mint green".

Text to be rendered goes in double quotes: `a sign reading "OPEN"`.

## Length

One clause to ~250 words. Long and detailed lands best; a bare clause still comes out clean.

## Size

Trained for 1024–2048 px per side. Below ~1024 on the short edge composition loosens, so on a 16:9 canvas prefer 1920×1080 and bring it down with `imageResize`. Both dimensions snap up to a multiple of 16.

## Negative Prompt

- **Absent** — the workflow zeroes the negative conditioning and samples at CFG 1.
- A scene exclusion belongs in `prompt` as what fills the space instead. A custom adapter may differ — check its schema.

## Avoid

- Evaluative filler ("masterpiece, best quality, 8k").
- Naming an exclusion — describe what occupies the space.
- Embedding resolution, step count, or seed values in the prompt text.
