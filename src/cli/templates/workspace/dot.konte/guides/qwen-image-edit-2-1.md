# Qwen Image 2.1 Edit

## Prompt Shape

Reference style conversion: `Render <image1> as [medium], using [line treatment, fills and shading].`

Next keyframe: `In <image1>, [the subject's new pose and gaze, down to the contact point]. Keep [the subject] as in <image2>, and keep everything else in <image1> unchanged.`

Describe only the change. Name what stays by its role, in one blanket clause; re-describing its look reads as a change.

## Style Conversion

Use in `reference.tsx` when the source already has the required subject, pose and framing. Describe the rendering change in one or two sentences.

Start with `image1` alone. Add `image2` and then `image3` for style examples, naming their roles with `<image2>` and `<image3>`. Their subjects and composition are not content to copy.

## Next Keyframe

Use in a shot to draw a keyframe from the one before it on the same camera: a shot's last panel from its first, or, across a `continuous` join, the opening keyframe from the previous shot's last panel (`shot("<id>").image("<name>")`). Pass that keyframe as `image1` and the character reference as `image2`.

Name where a reach ends: "the paw pad touches the glass at the center of the screen", not "reaches toward the screen".

Down a chain of keyframes, compare identity with the character reference at every link.

## Size

Set `width` and `height` to `image1`'s size, on a 32-pixel grid. Defaults follow the video's canvas.

Compare identity, silhouette, proportions, pose, placement and framing with `image1` before accepting. Use `imageQwenImageEdit21Inpaint` in a patch for a local correction.

## Cost ladder

The defaults, `cfg: 4` at 40 steps, are the rung to keep. `cfg: 1` at 25 steps takes about a quarter of the time and came back with a limb added on a turn of the body.

## Known failures

- **A reach stops short of its target** — name the contact point, and keep the rest with one blanket clause.

## Avoid

- New viewpoints, a cut, a change of framing or a new composition; draw those with `imageMinimaxH3R2i`.
- Style conversion in a shot; settle the look in the reference stage.
- Negative phrasing in `prompt`; describe the desired result affirmatively.
- A nonempty `negativePrompt` at `cfg: 1`; the adapter rejects it. At the default `cfg: 4`, target observed artifacts with short terms.
