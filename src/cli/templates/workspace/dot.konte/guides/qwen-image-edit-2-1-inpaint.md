# Qwen Image 2.1 Inpaint

## Prompt Shape

`In <image1>, [the local change]. Keep everything else unchanged.`

The model sees the selected rectangle and its margin as `<image1>`. Describe the change within that crop. Name what stays by its role, in one blanket clause; re-describing its look reads as a change.

## Region

Give `left`, `top`, `right`, `bottom` as fractions of the source frame. Enclose the entire desired result. The workflow adds a feathered margin of 12% of the rectangle's shorter side, at least 16px; pixels beyond that margin stay unchanged.

The crop is sampled at about one megapixel, then returned to the source frame's dimensions. A small edit needs a tight rectangle. Keep nearby objects that must remain exact outside the margin.

## References

Use `<image2>` and `<image3>` for optional references, filled in order. Name each reference's role. Crop a prop reference to the prop.

## Text

Quote every line verbatim, in reading order. Put `misspelled text, garbled letters, unreadable font` in `negativePrompt`. Where lines still come back missing or garbled, raise `cfg` to 6–8.

## Cost ladder

The defaults, `cfg: 4` at 25 steps, are the rung to keep. `cfg: 1` takes about two thirds of the time and ignores `negativePrompt`. 40 steps showed no gain on a local edit.

## Avoid

- A nonempty `negativePrompt` at `cfg: 1`; the adapter rejects it.
- Exclusions in the positive prompt; describe what occupies the space, and name what must not appear in `negativePrompt`.
- Weights or LoRAs for earlier Qwen Image models; use the 2.1 model and VAE.
