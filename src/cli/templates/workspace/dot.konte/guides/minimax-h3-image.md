# MiniMax H3 Image

One still, edited from `image1` with the references passed beside it.

## Prompt Shape

`prompt` is an object of three fields; the adapter writes them as one paragraph — every definition, then `The target image …`, then each subject's relation, then `details`, then `style`:

```ts
prompt: {
  references: {
    subjects: [
      { definition: "The sitting room in <Picture 1> is <Subject 1>.", relation: "fully preserved" },
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

- A `definition` names one `<Subject N>`, numbered from 1 in order, and the `<Picture N>` it comes from, element first: `The brass lamp on the desk in <Picture 1> is <Subject 3>.`
- `relation` is one of four — `"fully preserved"`, `{ partially }` (what remains, then what changes), `{ transfers }` (the property and the carrier it lands on: `the light and colour carried onto the new camera position.`), `{ weakly }` (the borrowed quality and what may vary).
- `target` is one sentence after `The target image`, the changed or new state first.
- `details` is only what changes and what is new — a fully preserved subject appears there as its bare `<Subject N>`, as an anchor, never re-described.
- Every wired `imageN` is named as `<Picture N>`.

## Length

- 120–220 English words for a shot with a plate and two or three sheets.

## Frames

- `image1` is the picture edited — the plate for a shot's opening keyframe, `fully preserved`.
- A panel of another shot passed in any slot leaks its light and windows into the frame — pass the plate and the sheets only.
- The next moment of the same take is an edit of its previous frame: that frame as `image1`, `partially` preserved, `details` writing only what moves. One generation only — an edit of an edit comes back grainy.
- A closer plate is the parent plate as `image1`, `{ transfers }`, sized against the set ("the sofa's arm fills the left third of the frame").
- A view image passes `reference.<location>` as `image1`, `{ transfers }`, `target` saying where the camera now stands ("seen from straight above the desk").

## Literal reading

- Light is drawn as written — "slanting golden light" turns the whole room warm. Name the light only where it changes.
- A state or a figure of speech is drawn as written — "frayed at the elbows" frays them, "flushed dark red" paints the face red. Write the amount the frame should show.
- Text in English double quotes comes back verbatim: `a brass plate reading "Nathan Garrideb"`.

## Known failures

- A held prop comes back in the other hand — name the hand and the side of the frame it is on.
- A figure turned away and half out of a door comes back facing camera or with the door shut — take several seeds.
- Figures come back in a heavier, more even line than the plate — restate the plate's line in `style`.

## Avoid

- No negative prompt — the sampler's negative is zeroed. State what the frame holds instead of what it lacks.
- A `[Shot N]`, a cut, a task type or a sound section — this model takes none.
