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

- Write the shot as fully as a video take — the voice, the room and every effect all come out of the described action.
- Keep the cuts and each shot's camera position, drop the camera moves — a cut changes what is heard, a move rarely does.

## Length

- 250–350 English words.

## References

- `audio1` → `<Audio 1>`, `audio2` → `<Audio 2>`. No `<Video N>`.

## Task Type

- `reference generation`, `audio reuse`, `audio reference`, several together where they apply.

## Casting

- Raise `width` and `height` to 256 for a line that still breaks at 128, never to the project canvas.
- A take with no reference comes back a different person on every seed. Make the character's voice sample this way, as `prompt-guide` describes it, rerolling until the voice is right.
- Pass the accepted sample as `audio1` — on every line the character speaks, marked `weak_reference`.
- A line a mouth has to match is made here — accept the R2A take as the shot's `<Audio>` on the board.

## Clip Length

- Never give a line the shot's `length` — a 1.5s line handed five seconds comes back said two or three times over. One rung long plays whole, cut mid-word by the `<Audio>` window in the composition.
- The rungs are `17k + 5` — a value between them rounds up.

## Cost ladder

- `steps` is nearly free — leave it at 20 and spend on references instead.
- A line take is picked, not written — the seed moves a take further than `length` does, and the wording not at all. Take several with `konte reroll --count` and choose by ear.
