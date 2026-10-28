# Qwen Image 2.1 Inpaint

## Prompt Shape

`In <image1>, [the local change]. Keep everything else unchanged.`

Describe the change within the crop. Name what stays by its role, in one blanket clause; re-describing its look reads as a change.

## Region

- Enclose the entire desired result in the rectangle.
- The workflow adds a feathered margin of 12% of the rectangle's shorter side, at least 16px.
- The crop is sampled at about one megapixel — a small edit needs a tight rectangle.
- Keep nearby objects that must remain exact outside the margin.

## References

- Name each reference's role. Crop a prop reference to the prop.

## Text

- Quote every line verbatim, in reading order.
- Put `misspelled text, garbled letters, unreadable font` in `negativePrompt`.
- Lines still missing or garbled — raise `cfg` to 6–8.

## Cost ladder

- The defaults, `cfg: 4` at 25 steps, are the rung to keep.
- `cfg: 1` takes about two thirds of the time, without `negativePrompt`.
- 40 steps buys nothing on a local edit.

## Avoid

- A nonempty `negativePrompt` at `cfg: 1`; the adapter rejects it.
