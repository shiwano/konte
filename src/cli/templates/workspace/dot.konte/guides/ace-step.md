# ACE-Step 1.5 XL Turbo

ACE-Step splits the request across **two fields**: `tags` describes the _music_ (genre, mood, instrumentation), `lyrics` carries the _sung words_ with structure tags.

## Prompt Shape

`tags` is the musical direction — a dense comma- or sentence-list, not narrative prose:

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
- **Instrumental?** Leave `lyrics` empty — don't write "instrumental" into `tags`.

## Length Heuristic

- **`tags`: a tight ~6–12 descriptors** — density beats length.
- **Lyric lines short and singable** (~4–8 words). A focused style line outperforms a sprawling one.

## Duration

`duration` follows the shot where one is in scope, and takes the adapter's default on the timeline — set it by hand for a bed that has to outlast its slot. The music sometimes ends before the requested duration, leaving a silent tail: probe the result and re-roll if it doesn't cover the slot.

## Negative Prompt

- **None.** The workflow routes conditioning through `ConditioningZeroOut`, so there's structurally no negative text path — nothing to fill. Steer by editing `tags`, not by listing things to avoid. A custom adapter may differ — check its schema.

## Tips

- Name a clear vocal timbre in `tags` ("breathy female vocals") — it changes the result more than mood words.
- For BGM under narration, leave `lyrics` empty so vocals don't compete with the voiceover.
- Iterate by swapping one element in `tags`, not re-rolling an identical prompt.

## Avoid

- Putting sung words in `tags`, or the musical description in `lyrics`.
- Writing "instrumental" into `tags` instead of leaving `lyrics` empty.
- Baking tempo, key, duration, or seed into `tags` when a parameter controls them.
- Phrasing things to avoid as negatives — there's no negative path; describe what you _want_.
- Vague mood words with no genre, instrumentation, or tempo.
