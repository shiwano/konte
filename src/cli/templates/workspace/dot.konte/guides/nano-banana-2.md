# Nano Banana 2

## Prompt Shape

```
[Subject] + [style] + [setting] + [lighting/mood] + [technical details]
```

Concise, direct descriptions work best — avoid over-elaboration.

## Length

~50–120 words.

## Edit Mode

Use `falNanoBanana2Edit` to change existing frame(s) instead of generating from scratch. Prompt for the delta — say what to change and what to keep, not the full scene.

## Tips

- **Multilingual text** — renders Japanese, Chinese, Korean, and Arabic text directly; include the desired text in the prompt.
- **Style separation** — put persistent style ("Studio Ghibli watercolor") in `systemPrompt`, keep the main prompt on subject + composition.

## Avoid

- Negative phrasing — no `negativePrompt`; phrase exclusions as affirmative direction.
- Embedding resolution or aspect ratio values in the prompt text.
