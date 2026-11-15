# MiniMax H3 Image

One still, edited from `image1` with the references passed beside it — a plate, a view, a reference or a patch. A shot's keyframes are `imageMinimaxH3R2i`'s.

## Prompt Shape

`prompt` is an object of three fields; the adapter writes them as one paragraph — every definition, then `The target image …`, then each subject's relation, then `details`, then `style`:

```ts
prompt: {
  references: {
    subjects: [
      {
        definition: "The sitting room in <Picture 1> is <Subject 1>.",
        relation: {
          partially: "its walls, furniture, light and camera position remain, while a figure now sits in its right armchair.",
        },
      },
      {
        definition: "The man in the grey frock coat in <Picture 2> is <Subject 2>.",
        relation: { partially: "his face, hair and coat remain, while his pose changes to seated." },
      },
    ],
    target: "shows <Subject 2> seated in the armchair at the right of <Subject 1>.",
  },
  details: "He leans forward, elbows on his knees, …",
  style: "Hand-drawn 2D animation, ink line and flat watercolour washes.",
}
```

- A `definition` names one `<Subject N>`, numbered from 1 in order, and the `<Picture N>` it comes from, element first: `The brass lamp on the desk in <Picture 1> is <Subject 3>.` It is written from what the image shows — open it first.
- One identity shown in two images cites each: `The boy in the apron in <Picture 2> and <Picture 3> is <Subject 2>.`
- `relation` is one of four — `"fully preserved"`, `{ partially }` (what remains, then what changes), `{ transfers }` (the property and the carrier it lands on: `the exact colour transferred to the coat of <Subject 1>.`; its definition names the property: `The colour of the scarf in <Picture 3> is <Subject 2>.`), `{ weakly }` (the borrowed quality and what may vary).
- `"fully preserved"` is a subject nothing touches. One a figure stands in front of, casts a shadow on, or that moves, turns or is relit is `{ partially }`.
- `target` is one sentence after `The target image`, the changed or new state first.
- `details` is only what changes and what is new — a fully preserved subject appears there as its bare `<Subject N>`, as an anchor, never re-described.
- Every wired `imageN` is named as `<Picture N>`.
- `target` and `details` narrate the finished frame: `The cup now stands on the windowsill`.
- A removed object is written as what fills its place (`bare floorboards run where the rug lay`). A moved object leaves its old place; a copy adds an instance — say which.

## Plates and Views

- A closer plate is the parent plate as `image1`, `{ partially }` — its walls, furniture and light remain, while the camera moves in — sized against the set ("the sofa's arm fills the left third of the frame").
- A view image passes `reference.<location>` as `image1`, `{ partially }` — its walls, furniture and light remain, while the camera moves — `target` saying where the camera now stands ("seen from straight above the desk").

## Literal reading

- Light is drawn as written — "slanting golden light" turns the whole room warm. Name the light only where it changes.
- A state or a figure of speech is drawn as written — "frayed at the elbows" frays them, "flushed dark red" paints the face red. Write the amount the frame should show.
- Text in single quotes comes back verbatim: `a brass plate reading 'Nathan Garrideb'`.
- `details` ends with `The frame holds no other lettering.`

## Known failures

- A held prop comes back in the other hand — name the hand and the side of the frame it is on.
- A figure turned away and half out of a door comes back facing camera or with the door shut — take several seeds.
- Figures come back in a heavier, more even line than the plate — restate the plate's line in `style`.

## Avoid

- No negative prompt — the sampler's negative is zeroed. State what the frame holds instead of what it lacks; `no other lettering` is the one negation the prompt check takes.
- A `[Shot N]`, a cut, a task type or a sound section — this model takes none.
