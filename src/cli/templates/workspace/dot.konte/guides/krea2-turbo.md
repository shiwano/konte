# Krea 2 Turbo

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

- Trained for 1024–2048 px per side; below ~1024 on the short edge composition loosens.
- On a 16:9 canvas, prefer 1920×1080 and bring it down with `imageResize`.

## Avoid

- Naming an exclusion — no `negativePrompt`; describe what occupies the space.
- Evaluative filler ("masterpiece, best quality, 8k").
