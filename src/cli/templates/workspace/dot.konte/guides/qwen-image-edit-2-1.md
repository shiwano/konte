# Qwen Image 2.1 Edit

## Prompt Shape

Reference style conversion: `Render <image1> as [medium], using [line treatment, fills and shading].`

New pose or view: `The [subject] from <image1>, [the new pose, view or outfit], [framing], on a plain backdrop. Keep the same [face, hair, outfit, line] as in <image1>.`

Same-camera keyframe: `In <image1>, [the subject's new pose and gaze, down to the contact point]. Keep [the subject] as in <image2>, and keep everything else in <image1> unchanged.`

Describe only the change. Name what stays by its role, in one blanket clause; re-describing its look reads as a change.

## Style Conversion

- For a source that already has the required subject, pose and framing — a photograph as an anime cel, brought footage's still as a painting.
- Describe the rendering change in one or two sentences.
- Start with `image1` alone; add `image2` and then `image3` as style examples, naming their roles with `<image2>` and `<image3>`. Their subjects and composition are not content to copy.

## New Pose or View

- Pass the accepted reference as `image1`; its framing and backdrop are not kept.
- Name what stays as attributes — "the same face, hair and line"; an attribute left out drifts.
- A new outfit is the change — name it, and keep the face and hair.
- A second subject or a style example goes in `image2`, its role named with `<image2>`.

## Shared Picture

- At the top of a stage's `timeline`, for a picture several shots show — a painting, a screen, a page — when the change keeps its composition.
- Pass the picture as `image1`, and keep everything else in `<image1>` unchanged.

## Same-Camera Keyframe

- One of a shot's panels from the other, or, across a `continuous` join, the opening keyframe from the previous shot's last panel (`shot("<id>").image("<name>")`).
- Pass that keyframe as `image1` and the character reference as `image2`.
- Name where a reach ends: "the paw pad touches the glass at the center of the screen".
- Down a chain of keyframes, compare identity with the character reference at every link.

## Size

- For a conversion or a keyframe, set `width` and `height` to `image1`'s size; for a new pose or view, to the reference's own shape. Defaults follow the video's canvas.
- Before accepting, compare a conversion or a keyframe with `image1` for identity, silhouette, proportions, pose, placement and framing; a new pose or view for identity alone.
- A local correction is `imageQwenImageEdit21Inpaint` in a patch.

## Cost ladder

- The defaults, `cfg: 4` at 40 steps, are the rung to keep.
- `cfg: 1` at 25 steps takes about a quarter of the time and can add a limb on a turn of the body.

## Avoid

- A new viewpoint, a cut, a change of framing or a new composition in a shot, or another view of a location — draw those with `imageMinimaxH3R2i`.
- Style conversion in a shot; settle the look in the reference stage.
- A nonempty `negativePrompt` at `cfg: 1`; the adapter rejects it. At the default `cfg: 4`, target observed artifacts with short terms.
