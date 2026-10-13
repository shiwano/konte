# Rename & retype conventions (step 2.2)

## Names

- **Preserve names that already map cleanly** (`clipName`, `vaeName`, `seed`, `width`, `height`, `loraName`) — rename only auto-numbered or ambiguous keys.
- **Prompts**: `→ *.positive` destination → `prompt` (canonical positive key on every backend; use distinct names like `prompt`/`refinePrompt` only when there's more than one); `→ *.negative` → `negativePrompt`.
- **Spoken words**: a TTS node's `text` → `script`; a text-to-SFX or text-to-music node's `text` → `prompt`.
- **Auto-numbered keys → role-based names**: `output0` → output type (`video`/`image`); first-last-frame `image0`/`image1` → `startImage`/`endImage`; multi-pass `seed0`/`steps0`/`cfg0` → `seed`/`steps`/`cfg` and `seed1`/`steps1`/`cfg1` → `refineSeed`/`refineSteps`/`refineCfg`.

## Input types

- **`AdapterInputType`** — `"string"`, `"number"`, `"boolean"`, `"seed"` (auto-randomized), `"image"` / `"video"` / `"audio"` (a `MediaAsset` of that kind), and the retypings below.
- **A combo keeps its `values: [...]` as generated** — the field types as a literal union. An API-format import leaves out choices the server declares; add them from the node's `object_info` or its documentation.

## Types

- **Fix LoadAudio inputs**: type `"audio"`.
- **The model's conditioning → `"prompt"`**: the positive `prompt`, a music model's style `tags`/`caption`, a voice-design `instruct`. It is what the prompt check reads.
- **The exclusion half → `"negativePrompt"`**: every exposed negative field; only a negation among its terms is refused.
- **A first/last frame → `pin: "start"` / `pin: "end"`**: an image the model reproduces as that frame. The pin check then refuses a `reference:` sheet or a plate there. Images only, one input per end. When the end is anchored by a frame-index field (H3's `MiniMaxH3AddGuide.frame_idx`), write `pin: { end: { nodeId, field } }` naming it.
- **The voiced words → `"spokenText"`**: a TTS `text`/`script`, a `lyrics` sheet.
- **Words embedded in a `"prompt"` → `spokenTextPattern`**: declare this adapter-level regex with capture group 1 matching the spoken words in the model's syntax.
- **Canvas size / frame rate → `"width"` / `"height"` / `"fps"` types**: the importer emits every numeric knob as `"number"`, so a workflow's canvas width, height and frame-rate inputs arrive as plain numbers. Retype them — konte then auto-fills each from the video's `format` (size / fps) when the author omits it. **Do not** retype an upscaler's _target_ width/height (delivery-driven, not the canvas) — leave those `"number"`.
- **A generated clip's frame count → `"frames"`**: konte fills it from the shot's duration. Add `clock: <fps>` when the model samples on its own rate — without it the count follows `format.fps`. A length in seconds → `"seconds"`, with no clock. A `default` is the fallback outside a shot. Leave batch limits, duration ceilings and model-picked lengths as `"number"`.
- **A speech model's length → `fill: "speech"`**: requires a `"spokenText"` input or `spokenTextPattern`; a `"frames"` input also requires `clock`. For example, `type: "frames", clock: 24, fill: "speech"`. Music models fill the shot instead.

## Model grids (`grid`)

- **A number the model only accepts on a step → `grid`**: when the model's guide states a step, declare it — `{ step: 32 }` for a plain multiple (MiniMax H3's 32-pixel width/height), `{ step: 17, offset: 5 }` for an offset one (H3's `17k+5` frame counts: 5, 22, 39, 56, …). konte raises whatever the input resolves to — caller, canvas format, frame count or `default` — to the next point on the grid; the offset also floors it.

## Format-derived defaults

- **Compute a `default` from the format → a function**: `default` may be a pure function of the build format `(f) => …` where `f` is `{ size, fps?, duration? }` or `undefined` (`f.duration` is set only inside a video shot). Use it for a value neither a format-derived type nor a `grid` can express. Guard for `undefined` and return a static fallback.

## Optional branches (`branch`)

When a sub-graph exists only for one optional input (a ControlNet's loader and apply node), name it there: `branch: ["220", { nodeId: "222", passThrough: "model" }]`. Omitting the input prunes those nodes and their inputs.

- **`passThrough` is for a node sitting IN a chain** — the input whose source stands in for its output (an apply node stands for the `model` it patches), so edges into it re-point rather than dangle.
- **Give the branch's weights `nodeId: "220"`** — that ties a model to its loader, so an omitted input downloads nothing; without it the model always provisions.
- **The generator emits neither** — restore both with the other hand-fixes (2.1); without `branch` an omitted input fails loudly.
