# MiniMax H3 Max

Every take comes back with picture and synchronized audio from one pass.

## Prompt Shape

```
[style/medium], [framing and lens], [subject with visible anchors], [action beats in order], [dialogue], [setting], [light/palette], [camera move]. Sound: [voices, foley, ambience, music].
```

Plain English prose.

- **Open on the medium** — `Cinematic live-action`, `Stop-motion claymation`, `2D pixel-art gameplay`, `vintage film`.
- **Beats arrive in the order written** — one change per sentence, each with a kinetic verb and the state it lands on.
- **Replace emotion words with visible physical causes** — "jaw tightens, eyes drop to the cup", not "upset".
- **Close on a `Sound:` sentence** — the voice's distance and quality, two or three concrete foley sounds, the room or weather behind them, and music only where the shot has it.
- **English is the body language.** Dialogue and text visible in frame keep their source language.

## Length

- **One shot, one to three beats: 60–150 words.**
- **A 10–15s take carrying several beats or cuts: a shot brief** — labelled blocks (`Style:`, `Subjects:`, `Action:`, `Camera:`, `Audio:`) and timed beats (`0:00-0:05 …`), up to ~500 words.

## Dialogue

- **A spoken line goes in double quotes, after who says it and how** — `The near man says flatly: "Did you hear?"`. That is what lip-syncs.
- **Name the speaker by a visible anchor at every line** — position (near/far, left/right) or wardrobe — when two people share the frame.
- **Name the language** — `lip-synced English dialogue`.
- **Double quotes carry spoken words only** — text shown in frame goes in single quotes (`a sign reading 'OPEN'`).

## Image-to-video

- **A passed frame fixes the canvas, the camera height and the axis** — pass the frame whose camera the shot keeps. The output ratio follows `image`, or `endImage` when it is passed alone.
- **Don't re-describe the frame** — repeat 3–6 anchors (hair, garment, silhouette) so each subject stays named, then write what changes.
- **With both frames, write one continuous path** — the onset, the intermediate changes, the landing.

## References

- **Name each reference by modality and list position** — `Image 1`, `Image 2`, `Video 1`, `Audio 1`.
- **Give each one a role in its first sentence, and write the identity out** — `Image 1 is the potter: cropped grey hair, a dark green apron over a white shirt.`
- **Name the garments at every appearance, in the same words.**
- **A reference no sentence names is spend for nothing.**

## Prompt Expansion

- **`"balanced"` is the one to write for.**
- **`"disabled"` sends the prompt as written, and the model reads a raw prompt only in its own six-section structure.**

## Cost ladder

- **Open at `resolution: "480P"`** for blocking and timing; `"768P"` once the take holds. `"1080P"` costs double; only for the take that ships with no delivery upscale.
- **Pass the shot's `duration`, a whole second at or above its span** — output is billed per second.
- **On R2V, references are billed by their pixel area beyond a small allowance** — a 5s clip costs about eighteen 1024px stills. Pass the ones the shot needs.

## Avoid

- Naming an exclusion — there is no negative prompt. Write what fills the space instead: `one continuous take`, `a locked-off camera`, `only wind and traffic under the voices`.
- Pronouns as the sole subject reference — anchor with visual attributes.
- Evaluative words (`beautiful`, `high quality`, `8K`) — name the lens, the light and the texture instead.
- Duration, aspect ratio or resolution in the prompt text — those are inputs.
- Leaving the sound undescribed — the model generates it either way.
