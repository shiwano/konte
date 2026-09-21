# Stable Audio 3 Medium

Makes **music** or **SFX / ambience**, selected by `category`. The single `prompt` field _describes_ the sound — a style line for music, a discrete sound/soundscape for SFX.

## Prompt Shape

Pick the mode, then write `prompt` to match:

- **Music** — a dense comma-list of sonic descriptors:

  ```
  [genre/subgenre], [instrumentation], [mood], [tempo/feel], [production]
  ```

  Example: `tropical house, marimba and steel drums, soft synths and smooth bass, sunny and chilled, layered percussion`

- **SFX / ambience** — describe the _source_, the _material/action_, and the _acoustic space_:

  ```
  heavy wooden door creaking open slowly in a stone hall, distant echo
  ```

A dense comma-list of descriptors, not narrative prose. Name concrete instruments/sources; favor physical detail over evaluative words.

## Length

- **~5–12 descriptors** — density beats length; describe the sound, not a scene.
- **SFX: one coherent sound** — generate multiple effects separately and mix in the composition.

## Duration

- `duration` follows the shot where one is in scope, and takes the adapter's default on the timeline.
- For looping ambience, set it by hand a little longer than the slot and loop it in the composition.

## Tips

- Match the mode to the content — a music-style prompt used as SFX (or vice versa) fights the model.
- For music, include a tempo/feel word and name the lead instruments — they move the result most.

## Avoid

- Mismatching the mode and prompt content (SFX wording under music).
- Stuffing many unrelated sounds into one SFX prompt — generate separately and mix.
- Narrative prose instead of a comma-list of descriptors.
- Expecting vocals or lyrics — instrumental / SFX only.
