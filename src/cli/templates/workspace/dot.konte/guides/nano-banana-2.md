# Nano Banana 2

## Prompt Shape

```
[Subject] + [style] + [setting] + [lighting/mood] + [technical details]
```

Concise, direct descriptions work best — avoid over-elaboration. Fast generation makes it ideal for rapid prompt iteration.

## Length

~50–120 words. Favors brevity; shorter, more focused prompts often produce better results.

## Edit Mode

Use `falNanoBanana2Edit` to change existing frame(s) instead of generating from scratch. Prompt for the delta — say what to change and what to keep, not the full scene.

## Tips

- **Multilingual text** — renders Japanese, Chinese, Korean, and Arabic text directly; include the desired text in the prompt.
- **Style separation** — put persistent style ("Studio Ghibli watercolor") in `systemPrompt`, keep the main prompt on subject + composition.

## Avoid

- Over-elaborate descriptions beyond what the model can resolve.
- Negative phrasing — no `negativePrompt`; it's an instruction-following model, so phrase exclusions as affirmative direction.
- Embedding resolution or aspect ratio values in the prompt text.
