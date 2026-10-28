# Zonos 2 (ComfyUI)

The first generation downloads several GB of weights inside the node, with no progress in konte's log — leave a long first take running.

## Script Shape

Write clean, speakable prose with real punctuation:

```
She read the last line twice, then closed the book. It was already too late.
```

- Punctuation drives prosody — `…` adds hesitation, `—` breaks a thought, `!`/`?` shape intonation.
- Pre-expand numbers, currency, dates, abbreviations to spoken form ("$1,000" → "one thousand dollars").
- Nothing but the words — a stage direction in the `script` is read aloud.

## Language

- Inferred from the `script`; there is no language input.
- English, Mandarin and Japanese are the model's strongest tier; Korean, Russian, Italian, Portuguese, French and Spanish the next.
- Mixed scripts in one line read unevenly — split them.

## The Reference Clip

- 5–30 seconds of clear, single-speaker speech; past 60 seconds the clip is cut.
- Whatever is in the clip clones — music, room tone and reverb come across as part of the voice.
- Accent and delivery follow the clip more than the `script`.
- `cleanSpeakerBackground` asserts the clip is noise-free — leave it off for any audible room tone, or the model treats the noise as intended.
- `accurateMode` tightens speaker adherence at the cost of expressiveness, and works against emotion conditioning. konte holds it to the emotion: `true` on an unconditioned line, `false` as soon as `emotion` or either axis is set.
- A clip designed by a voice-design model works — a mispronunciation in the sample does not carry.

## Length

- One or a few sentences per generation. Split longer narration at sentence boundaries, then stitch in the composition.
- `maxNewTokens` is a ceiling, not a target — the 1024 default caps a take near 12 seconds and the 6000 maximum near 70. Raise it only when a long line comes back cut off.
- `repetitionPenalty` above 1.0 breaks a stutter or a trailing hum at its source; the default 1.2 already leans that way.

## Conditioning Buckets

`speakingRate`, `loudnessLufs`, `leadingSilence` and `trailingSilence` each take a labelled range (`"3: 0.25-0.5"`) or `"default"`, which leaves that axis unconditioned. They shape pace, level and the silence around the line, never the speaker.

- `speakingRate` is cleaned bytes per second, so a lower bucket reads slower — the one to reach for when a line overruns its shot.
- `leadingSilence` / `trailingSilence` in seconds. Trim them when the composition already places the line.

## Emotion

`emotion` moves only the delivery, never the speaker. `"none"` leaves conditioning untouched. A line that acts sets three inputs together:

```ts
asset("line1", audioZonos2VoiceClone, {
  referenceAudio: reference.voiceElderChild,
  script: "…",
  emotion: "sad",
  loudnessLufs: "9: -14--9.5", // emotion costs 12–14 LUFS without it
  trailingSilence: "5: 1-2", // emotion clips the final mora without it
});
```

- `emotionStrength` multiplies a strength ZONOS2 already calibrated per direction, so 1.0 is the intended amount.
- `emotionStrength: 0` disables emotion whatever else is set, so konte rejects it against a set emotion — say it with `"none"` and unpushed axes instead. Both scales stay at 1 on an unconditioned line.
- The directions are not equally strong. `sad` and `surprised` land at 1.0; `angry` barely reads there and wants 2.0–3.0.
- `emotionValence` / `emotionArousal` mix in continuous axes alongside the named emotion, or instead of it. Valence runs unpleasant to pleasant, arousal calm to excited.
- The axes read more gently than a named emotion at the same strength — the tool for a baseline temperament; a named emotion is a single beat, a line that turns.
- `emotionCfgScale` is the second lever, off at 1.0; above it a take costs roughly double the generation time. Stay at or below 1.3 — 1.5 drops the level and clips the final mora. Reach for strength first.
- The final mora is probabilistic — `trailingSilence` solves it, a lucky seed does not. Suspect it whenever a take comes back noticeably shorter than its neighbours.

## Avoid

- Negative text — the model takes none; steer by rewriting the `script` or changing the reference clip.
- Rerolling to fix the voice or an emotion that did not land — the seed varies delivery, not the speaker or the conditioning; change the clip, the strength, or the label.
- Stacking a named emotion at high strength with both axes pushed — the clone thins out.
