# MiniMax H3

The prompt grammar every H3 decode reads.

## Prompt Shape

`prompt` is an object of fields; the adapter writes the section names, their order, the task-type brackets, the `[Shot N]` numbers and the cut times:

```ts
prompt: {
  subjectDefinitions: ["<Subject 1> is …", "<Picture 2> is …"],
  summary: { tasks: ["keyframe completion"], text: "…" },
  retentionAnalysis: ["<Subject 1> (appears in [Shot 1]): fully_preserved - …"],
  detailedDescription: {
    style: "2D-animated.",
    shots: ["…", { at: 3.5, text: "the camera cuts to …" }],
  },
  overallSoundscape: "…",
  nonDiegeticMusic: "N/A",
}
```

- **An unused sound field takes `N/A`, never an empty string.**
- **`style` is one or two sentences.** Name it from `Cinematic`, `live-action`, `2D-animated`, `3D CG`, `claymation`, `watercolor`, `vintage film` — derived from the reference image wherever a frame or a sheet is passed, and from the shot's own text where none is.
- **English is the body language.** Only dialogue, lyrics and text visible in frame keep their source language.
- **`shots[0]` is `[Shot 1]`; every later shot is `{ at, text }`** — `at` the cut time in seconds, strictly increasing and inside the take's duration.
- **Refer back in words (`the previous shot`), never with `[Shot N]` inside a shot's text.** Other fields cite a shot as `[Shot N]`, N its position in `shots`.

## References

- **Labels are numbered per type from 1** — `<Subject N>` is reusable visible content (a person, a set, a costume, a prop, a style, an action), `<Picture N>` a reference image serving as a concrete frame or composition anchor. The decode's guide names the other types it takes.
- **`<Picture N>` is the N-th image actually passed** — `image1` → `<Picture 1>`, `image2` → `<Picture 2>`. Fill numbered input slots upward from 1 with no gaps; the adapter rejects skipped slots.
- **An image that only defines a character, set, costume or style gets no standalone `<Picture N>` line** — cite it inside the `<Subject N>` it defines: `<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.` One subject may draw on several assets (`appearance comes from <Picture 1>, the costume from <Picture 2>`). A cast held as bare `<Picture N>` in the body comes back with the written action dropped, a named figure absent, and similar characters blended into each other.
- **Write the identity out as well as tagging it.**
- **Name the garments at every appearance, in the same words** — a tag does not hold wardrobe, which drifts from shot to shot and from take to take.

## Task Type and Retention

- **`summary.tasks` names the task types** — the decode's guide lists the types it takes. `summary.text` introduces no new labels.
- **`retentionAnalysis` is one line per label declared at the start of a `subjectDefinitions` line** — visible content takes `fully_preserved`, `partially_preserved`, `attribute_transfer` or `weak_reference`; audio takes `fully_copy`, `partially_copy`, `reference` or `weak_reference`.
- **A tag cited inside another label's definition gets no retention line** — `<Subject 1> is the woman in <Picture 1>.` takes retention for `<Subject 1>` alone.
- **The parenthetical is the label's own:**

```
<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - …
<Picture 2> ([Shot 1] first frame): fully_preserved - …
```

- **What the take adds is not a loss** — a new action, a background the references never showed, a beat of plot: none of it lowers a marker.

## Cost ladder

- **All nine references hold** — every identity lands in its place and at its size — **but each one is paid for on every step.** Pass the ones the shot needs.
- **A prompt edit costs more than a seed sweep** — the encode is cached across takes sharing a prompt and reference set.

## Avoid

- Keyword lists — this model reads prose.
- Evaluative filler ("masterpiece, best quality, 8k").
- Naming an exclusion — the model takes no negative text. Write what fills the space instead; a decode's own guide names any exclusion it lets through.
- Tagging a reference you did not pass — the tag lands on whichever reference took that ordinal. The adapter rejects it, along with a slot you passed and never tagged.
