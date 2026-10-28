# YuE2

## Prompt Shape

`style` is one line, language first:

```
[language], [genre], [vocal character], [tempo] BPM, [meter], [instruments], [production]
```

Example: `English, synth pop, bright female vocal, 120 BPM, 4/4, four-on-the-floor kick, analog synth bass, shimmering arpeggios, polished modern production`

- Lead with the language the lyrics are sung in (`English`, `Japanese`, …).
- State the same BPM as `bpm` — the score's tempo comes from `bpm`, and a different figure in `style` works against it.
- Name instruments and vocal timbre concretely; mood words without them steer nothing.

## Lyrics

Put only the sung words in `lyrics`, structured with bracket tags on their own lines:

```
[Verse]
Lights down, desk against the wall
[Chorus]
Hit the light, hit the light
```

- Tags: `[Verse]`, `[Chorus]`, `[Bridge]`, `[Outro]`. A blank line between sections.
- Instrumental → leave `lyrics` empty and name no voice in `style`, not even to exclude one.
- Musical direction goes in `style`, never in `lyrics`.

## Length

- `style`: ~8–12 descriptors in one line.
- Lyric lines short and singable (~4–8 words).

## Duration

- Four sections of four lines run 113–198 s at 92–120 BPM, with long instrumental intros and outros around ~60–100 s of singing.
- Leave `maxDuration` high for a song and trim in the composition.
- A reroll of a short instrumental runs no longer; join takes with `adapters.audioConcat` to fill a bed.

## Avoid

- Phrasing things to avoid as negatives — there's no negative path; steer by editing `style`.
