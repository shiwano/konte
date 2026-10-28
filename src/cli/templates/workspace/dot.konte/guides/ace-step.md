# ACE-Step 1.5 XL Turbo

## Prompt Shape

`tags` is the musical direction — a dense comma- or sentence-list:

```
[genre/subgenre], [mood], [instrumentation], [vocal character], [production/era]
```

Example: `dream pop, hazy and nostalgic, shimmering reverb guitar, analog synth pads, breathy female vocals, 80s production`

A short labeled paragraph also works (`K-Pop: A slick, maximalist track that genre-hops…`). Name actual instruments and vocal timbre explicitly; favor concrete sonic terms over evaluative ones ("pulsing sub bass" beats "epic").

## Lyrics

Put the sung words in `lyrics`, never in `tags`. Structure with bracket tags on their own lines:

```
[Verse 1]
Static in the air, I feel it in my bones
[Chorus]
Shout it out, I'm alive tonight
```

- Common tags: `[Intro]`, `[Verse]`, `[Pre-Chorus]`, `[Chorus]`, `[Hook]`, `[Bridge]`, `[Outro]`. Separate lines with `\n`.
- Instrumental — leave `lyrics` empty, with no "instrumental" in `tags`.

## Length Heuristic

- `tags`: a tight ~6–12 descriptors — density beats length.
- Lyric lines short and singable (~4–8 words).

## Duration

- Set `duration` by hand for a bed that has to outlast its slot.
- The music sometimes ends before the requested duration, leaving a silent tail — probe the result and reroll if it doesn't cover the slot.

## Tips

- For BGM under narration, leave `lyrics` empty so vocals don't compete with the voiceover.
- Iterate by swapping one element in `tags`, not rerolling an identical prompt.

## Avoid

- Phrasing things to avoid as negatives — there's no negative path; steer by editing `tags`.
- Vague mood words with no genre, instrumentation, or tempo.
