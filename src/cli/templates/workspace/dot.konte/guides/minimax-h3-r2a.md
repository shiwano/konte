# MiniMax H3 R2A

Only audio is decoded from the described scene.

## Prompt Shape

With any image or audio reference, the six fields. Without one, three:

```ts
prompt: {
  integratedMultimodalDescription: {
    style: "…",
    shots: ["[composition], [subject], [action], [camera], [dialogue]"],
  },
  overallSoundscape: "[ambience, physical action sounds, non-verbal human sounds]",
  nonDiegeticMusic: "[instrumentation, tempo, rhythm, dynamic change]",
}
```

- **Write the shot as fully as a video take** — the voice, the room and every effect all come out of the described action.
- **Keep the cuts, drop the camera moves** — a cut changes what is heard, a move rarely does.

## Length

- **250–350 English words** — write the room and its small business out as well as the line.

## References

- **`<Audio N>` is a copied or referenced signal** — `audio1` → `<Audio 1>`, `audio2` → `<Audio 2>`. No `<Video N>`.

## Task Type

- **`reference generation`, `audio reuse`, `audio reference`**, several together where they apply.

## Casting

- **The canvas is heard, though no frame is decoded** — `width`/`height` set the voice as well. Raise both to 256 for a line that still breaks at 128, never to the project canvas.
- **Cast the voice with the reference set** — the speaker's sheet as a `<Picture N>` cited in their `<Subject N>`, the timbre as `<Audio N>`.
- **A take with no reference designs the voice** — the description alone casts it, so it comes back a different person on every seed. Make the character's voice sample this way, as `prompt-guide` describes it, rerolling until the voice is right.
- **Pass the accepted sample as `audio1`** — on every line the character speaks, marked `weak_reference`.
- **A line a mouth has to match is made here** — accept the R2A take and hand it to R2V as `audioStem`, or play it over the composition as `<Audio>`.

## Clip Length

- **Omit `length`** — set it by hand only after hearing a take.
- **Never give a line the shot's `length`** — a 1.5s line handed five seconds comes back said two or three times over. One rung long stretches the read instead: the same words slower, playing whole on their own and cut mid-word by the `<Audio>` window in the composition.
- **The rungs are `17k + 5` frames on a 24fps clock** — a value between them rounds up. The trained floor of 124 (≈5s) is the video range — a line reads below it.

## Cost ladder

- **`steps` is nearly free** — leave it at 20 and spend on references instead.
- **A line take is picked, not written** — the seed moves a take further than `length` does, and the wording not at all. Take several with `konte reroll --count` and choose by ear.
