# MiniMax Music 3

Two fields: `lyrics` carries the sung words with section tags, `caption` is a **Structured Caption** — a three-section document.

## Prompt Shape

Three literal section headers, each with labeled fields:

```
Global Metadata
Basic Attributes: bpm is 92. key is E, and scale is minor. Dream Pop / Shoegaze.
Global Emotional Progression: <where the piece starts, how it deepens, where it lands>
Application Scenarios & Imagery: <the scene this scores>
Sonics & Production Profile: <soundstage width, frequency balance, dynamic aesthetic>
Vocal Details
Vocal Gender & Timbre: Singer A (Female). <range, texture, what it conveys>
Vocal Style: <delivery, and how it shifts between sections>
Harmony/Backing Vocals: <layers, or "none">
Vocal FX: <reverb/delay/tuning, or minimal processing>
Arrangement
Instrument Lifecycle Description (Primary/Secondary Layering):
Primary: <what carries the harmony and rhythm, from where to where>
Secondary: <what supports it, or "none">
Groove & Foundation Progression: <what generates the pulse, and how its intensity moves>
Embellishments, Textures & Spatial FX: <resonance, ambience, incidental detail>
```

- **Write the caption in English**, whatever language the lyrics are in.
- **Arrangement is a timeline** — per section, what enters, exits, changes or intensifies.
- **Don't fabricate an exact BPM or key** — state them when the brief justifies them, otherwise give a tempo range or a qualitative pulse and drop the key.
- **An absent field's whole value is `none`** (`Harmony/Backing Vocals: none`), never omitted. Any other negation is a prompt-check finding — "no backing vocals" included.
- Two singers are `Singer A` / `Singer B`, each with its own gender and timbre.

## Lyrics

Put the sung words in `lyrics`, never in `caption`. Structure them with bracket tags on their own lines:

```
[Intro]
[Verse]
Static in the air, I feel it in my bones
[Chorus]
Shout it out, I'm alive tonight
[Outro]
```

- Tags: `[Intro]`, `[Verse]`, `[Pre-Chorus]`, `[Chorus]`, `[Post-Chorus]`, `[Bridge]`, `[Instrumental]`, `[Solo]`, `[Outro]`. Separate lines with `\n`.
- **A tag owns its line** — words left on it are dropped.
- **A tag's musical direction goes in the caption's Arrangement, not in `lyrics`.**
- **Describe the singer once, in Vocal Details.**
- The returned structure, tempo and key can drift from what the tags and caption asked for.

## Length

- **`caption`: ~250–450 English words.** The whole prompt is capped at 5,000 tokens.
- **Lyric lines short and singable** (~4–8 words).

## Duration

**The section-tag count in `lyrics` sets the length, and wordless sections count too** — a plain six-section sheet plans around two and a half minutes, and padding one with `[Instrumental]` or `[Solo]` stretches a take further without touching a sung line.

On a sung sheet the padding saturates fast: four wordless sections took a 40-second take to 75, eight gave nothing more, and `[Solo]` buys more than `[Instrumental]`. Seeds land within a second or two of each other. The spread widens as the sheet grows, so pick a section count that can reach the slot and re-roll until one lands long enough to trim.

`maxDuration` is a ceiling. Set it to the slot length and a longer song is cut mid-phrase — set it generously and trim in the composition instead. Raising it further does not lengthen a take. Model ceiling is 5 minutes.

Stating a running time in the caption does nothing, and framing the caption as a seamless non-developing loop makes takes _shorter_. Turn comfy's tiled VAE decoding on when a long take runs out of memory, off when it doesn't — it trades a small seam risk at tile boundaries for the headroom.

## Negative Prompt

- **None.** No negative text path on either backend. Steer by editing `caption`, not by listing things to avoid. A custom adapter may differ — check its schema.

## Avoid

- Collapsing `caption` into one sentence, or dropping the three section headers.
- Putting sung words in `caption`, or a section's musical direction in `lyrics`.
- Inventing a precise BPM, key, or production technique the brief doesn't support.
- Re-describing the singer under each section tag.
- Baking a running time or seed into `caption`.
- Phrasing things to avoid as negatives — there's no negative path; describe what you _want_ ("light and airy", not "never heavy or dark").
- Mood adjectives ("epic", "emotional") with no genre, instrumentation or groove behind them.
