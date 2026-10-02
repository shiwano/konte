# YuE2

Two fields: `style` describes the music, `lyrics` carries the sung words with section tags. YuE2 first plans the song as a score from both, then renders the score as audio.

## Prompt Shape

`style` is one line, language first:

```
[language], [genre], [vocal character], [tempo] BPM, [meter], [instruments], [production]
```

Example: `English, synth pop, bright female vocal, 120 BPM, 4/4, four-on-the-floor kick, analog synth bass, shimmering arpeggios, polished modern production`

- **Lead with the language the lyrics are sung in** (`English`, `Japanese`, …).
- **State the same BPM as `bpm`** — the score's tempo comes from `bpm`, and a different figure in `style` works against it.
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
- **Instrumental → leave `lyrics` empty and name no voice in `style`**, not even to exclude one.
- Musical direction goes in `style`, never in `lyrics`.

## Length

- **`style`: ~8–12 descriptors** in one line.
- **Lyric lines short and singable** (~4–8 words).

## Duration

The planned score sets the length, not a requested running time: four sections of four lines ran 113–198 s at 92–120 BPM, with long instrumental intros and outros around ~60–100 s of singing.

`maxDuration` is a ceiling that cuts the take mid-phrase — leave it high for a song and trim in the composition. For a bed that has to fill a shot, it follows the shot's duration, so an instrumental take ends exactly there.

## Negative Prompt

- **None.** The workflow routes conditioning through `ConditioningZeroOut`, so there's no negative text path. Steer by editing `style`.

## Known failures

- **Song cut mid-phrase at 120 s** — the template's ceiling; the adapter's `maxDuration` default of 360 let takes end on their own.
- **A Japanese ballad at 92 BPM read at 91 on five of six takes** — re-roll until `konte song analyze` reads the declared tempo; English and Japanese at 104 BPM, and English at 92, landed on most takes.
- **A Japanese score slipped a 2/4 or 9/8 bar between sections on four of six plans**, moving every later bar head off a 4/4 grid — re-roll; the English plans held 4/4 throughout.
- **Words sung into an instrumental on two of three takes** — the style was `Instrumental, …, no vocals, no singing, no choir`; a style naming no voice gave none in three.

## Avoid

- A BPM in `style` that differs from `bpm`.
- Sung words in `style`, or a section's musical direction in `lyrics`.
- Phrasing things to avoid as negatives — there's no negative path, and naming what to leave out can bring it in; describe what you _want_.
- Mood adjectives ("epic", "emotional") with no genre, instrumentation or groove behind them.
