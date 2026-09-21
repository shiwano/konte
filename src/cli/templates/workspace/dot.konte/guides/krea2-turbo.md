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

## Reference

`imageKrea2TurboReference` takes up to three frames and holds what is in them — a face, a pose, a framing — while the prompt says what to change.

Choose it for a new reference sheet, pose or view of an existing subject. Name the target scene and the details to carry. A style-only conversion requiring the source's complete geometry and composition to survive is outside this adapter's purpose.

- **Name each frame by number and give it a job**: "Keep the same young man in image 1 — the same face, the same hair, the same pose. Take the palette of image 2." A frame the prompt never names is still read, but nothing says what for.
- **What is held has to be spelled out.** "the same face, the same hair, the same pose with his head tilted back, the same framing" holds all four; drop a clause and that one drifts.
- **A style word inside the keep clause holds the drawing itself** — "and the same delicate hand-drawn line" is what keeps a pencil original from being redrawn as a generic cel.
- **Name the era and the tooling of the target look.** "a cel from a 1990s theatrical anime, a thin ink line that varies in weight, a muted desaturated palette" lands where "anime cel" gives the default gloss.
- **A far medium arrives in pieces.** Asking a line drawing for a photograph tends to convert the clothing and the setting first and leave the face drawn. Move in one register at a time.

## Negative Prompt

- **Absent** — the workflow zeroes the negative conditioning and samples at CFG 1.
- A scene exclusion belongs in `prompt` as what fills the space instead. A custom adapter may differ — check its schema.

## Avoid

- Evaluative filler ("masterpiece, best quality, 8k").
- Naming an exclusion — describe what occupies the space.
- Embedding resolution, step count, or seed values in the prompt text.
