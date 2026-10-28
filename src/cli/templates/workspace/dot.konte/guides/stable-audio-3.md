# Stable Audio 3 Medium

## Prompt Shape

Write `prompt` in the shape of what it is:

- Music — a dense comma-list of sonic descriptors:

  ```
  [genre/subgenre], [instrumentation], [mood], [tempo/feel], [production]
  ```

  Example: `tropical house, marimba and steel drums, soft synths and smooth bass, sunny and chilled, layered percussion`

- SFX / ambience — describe the _source_, the _material/action_, and the _acoustic space_:

  ```
  heavy wooden door creaking open slowly in a stone hall, distant echo
  ```

A dense comma-list of descriptors, not narrative prose. Name concrete instruments/sources; favor physical detail over evaluative words.

## Length

- ~5–12 descriptors — density beats length; describe the sound, not a scene.

## Enhance and Category

- `enhancePrompt: true` has an LLM rewrite `prompt` before encoding, from the system prompt `category` selects: `Music` a full track, `Instrument` a loop or stem, `SFX` an effect or ambience, `One-shot` an isolated 1–11 s hit.
- Off (the default), `prompt` is encoded as written and `category` is read by nothing.

## Negative Prompt

- Leave `negativePrompt` empty — at the default `cfg: 1` the sampler ignores the negative conditioning.

## Duration

- For looping ambience, set `duration` by hand a little longer than the slot and loop it in the composition.

## Tips

- For music, include a tempo/feel word and name the lead instruments — they move the result most.
