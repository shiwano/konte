# MiniMax H3 — Sound

What the decoded track reads from the prompt.

Write every `<d>` tag exactly as given.

## Length

- **`overallSoundscape` — 1–4 sentences**, one paragraph. **`nonDiegeticMusic` — 1–3 sentences.**

## Speakers and Dialogue

- **Every voice gets a stable id** — `(S1)`, `(S2)`, in the order they first sound; `(S1,S2)` when they speak together. The id follows the speaker across shots. A character who never vocalizes gets none. Speaker ids never appear in `retentionAnalysis`.
- **A speaking reference keeps both labels** — `<Subject 2> (S1) turns toward the woman and says, <d>[English] …</d>`. When an `<Audio N>` is a voice reference, bind it to the same id in its definition (`<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`).
- **Cast the voice on first appearance, outside `<d>`** — character type, age, gender, on- or off-screen, pitch, timbre, rate, accent.
- **A sheet as `<Picture N>` or a voice as `<Audio N>` casts the speaker too** — an uncast one comes back male.
- **Carry the delivery on the verb** — `snaps at them`, `shouts at them`, `drops her voice to a frightened whisper and says`. The voice itself is two or three adjectives on the speaker. A list of acoustic properties in its place comes back stiff.
- **Reach for a plain `says` unless the shot is about how she says it** — a pressed or muttered delivery costs intelligibility and comes back at a level `volume`'s +12 dB cannot recover.
- **Delivery costs stack** — a small child's timbre, a lisp, a half-volume copy of what someone else just said: each is affordable on its own and the three together come back as mouth noise. The roster's `voice.description` and the shot's `acting` both reach the prompt, so read what they already spend before adding to the verb.
- **`<d>` holds the language tag and the words, nothing else** — `<d>[English] I get off at the next station.</d>`. Every word verbatim; never translate a line into the body language. The tag is the English name of one of `policy.lang`'s languages. `Arabic` `Chinese` `English` `French` `German` `Italian` `Japanese` `Korean` `Portuguese` `Russian` `Spanish` are the stable eleven.
- **Punctuation inside `<d>` is normalized** — `,` `.` `?` `!` closing every statement, question and exclamation before `</d>`; repeated tildes, emoji, bullets and decorative marks come out.
- **Voiceover has a fixed phrase** — `says in an off-screen voiceover`.
- **A misread word is respelled with `respell(script.<who>[n], "…")`, whose return goes inside `<d>`** — change the spelling until it reads right.
- **A line crossing a cut takes `<scenetrans>` at both connecting points**, plus a continuity clause (`continues seamlessly across the cut`, `continues uninterrupted into the next shot`, `carries over from the previous shot`, `remains audible across the transition`). **`<cutoff>`** marks speech the end of the take truncates.

## Japanese Lines

- **Write a word read wrong in kana** — `祇園精舎` → `ぎおんしょうじゃ`. Change the word; leave the rest of the sentence in its ordinary orthography.
- **Never gloss in parentheses** — `祇園精舎（ぎおんしょうじゃ）` is spoken twice over, the spelling and then the gloss.
- **Keep figures in digits** — a date, a time or an address in kana comes back garbled. Hold the ordinary orthography and write the numbers as digits: `2026年8月27日`, `午後3時15分`, `神南1丁目19番8号`.

## Reference Audio

- **`audio1`…`audio3` are the standalone `<Audio N>` references** — a voice, a room, a piece of music the take carries — filled upward with no gaps and numbered in the order the decode's guide gives.
- **Reused or re-performed is a choice, and the prompt is where it is made** — **reuse** hands back the passed recording as the take's own audio; **reference** takes its timbre and lets the model speak the line itself, in its own performance and timing.
- **The choice is written in three places and they have to agree** — the role in `subjectDefinitions`, the task type in `summary.tasks`, the marker in `retentionAnalysis`. A marker outside the role its own definition gave asks for both at once — `fully_copy` under "the voice-timbre reference for `<Subject 1>`".
- **Reuse** — the words in `<d>` are the recording's own, verbatim and in its language, `[unclear]` for a span that cannot be made out:

```ts
subjectDefinitions: ["<Audio 1> is the recorded line <Subject 1> (S1) speaks in this shot."],
summary: { tasks: ["reference generation", "audio reuse"], text: "…" },
retentionAnalysis: ["<Audio 1>: partially_copy - the spoken layer is reused unchanged, with the room tone added around it."],
```

- **Reference** — never carry the recording's dialogue into `<d>`; the line is the target take's own:

```ts
subjectDefinitions: ["<Audio 1> is the voice-timbre reference for <Subject 1> (S1)."],
summary: { tasks: ["reference generation", "audio reference"], text: "…" },
retentionAnalysis: ["<Audio 1>: reference - the target speaker follows its timbre and measured delivery without copying the signal."],
```

- **Under `reference`, pass the line whose tension this one continues** — pitch and its spread come across with the timbre; `weak_reference` keeps the colour and leaves the delivery to the scene. The same speaker's previous line — `shot("<id>").audio(…)`, or an earlier asset in the same shot — holds a scene or a stretch of narration level across takes.
- **A voice inside a reused track is not a speaker** — verbal content a copied BGM or soundtrack carries takes `<Audio N>` as its source and no `(Sx)`: `When <Audio 1> reaches the phrase <d>[English] …</d>, the room ambience continues around the recording.`
- **`fully_copy` claims the whole delivered track** — nothing else sounds, so it stands only beside `overallSoundscape: "N/A"` and `nonDiegeticMusic: "N/A"`. Room tone, a score or a second voice around the copy makes it `partially_copy`.
- **Place the relationship on the layer that carries it** — ambience and effects in `overallSoundscape`, audience-only score in `nonDiegeticMusic`, a spoken line at its vocal event in `detailedDescription` ("her recorded words from `<Audio 1>` sounding in the room"; on a reference, "in the settled, unhurried voice of `<Audio 1>`, at its own pace and on its own timing").

## Soundscape and Score

- **Sound is generated** — an unwritten track comes back undirected, not silent.
- **`overallSoundscape` is everything unvoiced and diegetic** — wind, rain, traffic, footsteps, fabric, impacts, breathing, laughter, panting, summarized across the whole take. Dialogue, singing and diegetic music already live in the description; do not repeat them here.
- **`nonDiegeticMusic` is what only the audience hears** — instrumentation, tempo, rhythm, dynamic change, never mood or emotional function ("melancholy", "builds tension"). Music a character can hear (a radio, a phone, someone singing) is a diegetic event and belongs in the description instead.
- **`N/A` is the literal for absence** — on the soundscape only when the take is explicitly silent throughout, on the score whenever there is none.

## Level

- **Level is not addressable** — there is no volume or mix-balance field, and a dynamic change on `nonDiegeticMusic` ("gradually increasing in volume") is the only loudness the prompt reaches. A reference's `retentionAnalysis` marker is not one either — `fully_copy` / `partially_copy` say how much of the signal is taken. Write the rest as quality — `a faint crackle`, `low room ambience underneath` — and set the take's own level at playback with the composition's `volume`.
- **The level is written into the performance** — a hushed interior comes back far under a studio read. A take too quiet for `volume`'s +12 dB ceiling is re-acted, not amplified.
