---
name: adapter-authoring
description: Add or audit a shipped FAL (fal.ai) adapter — defineFalAsset, the input defs, and drift against the live provider schema. The adapter's craft guide is prompt-guide-authoring's.
user-invocable: false
---

A shipped adapter is a typed wrapper around one hosted model, seeded into every workspace under `adapters/<backend>/` and used as `asset(name, adapter, inputs)` after a named import. Done = the endpoint id and `inputs` match the live provider schema exactly, its `description` states the lean an author picks on, and `bun run check` passes.

## Where things live

- Adapter: `src/cli/templates/workspace/adapters/fal/<model>.ts` — one file may export several modes (e.g. `falSeedance25T2v` / `falSeedance25I2v`). Template seed: written once by `konte workspace new`, never re-synced.
- Builder: `defineFalAsset` (`src/core/dsl/fal-asset.ts`) — read it once; it is the source of truth for input semantics.
- Export barrel and discovery: none to update — a named `export` suffices; `konte adapter list` tables every `adapters/**/*.ts` adapter's `meta`, and `adapter show <adapter>` adds the input schema and the craft guide's path, never its body. The `description` and input `description`s you write _are_ the docs.

## Verify the schema first — never from memory

When unclear, fan out a research agent on the provider's docs.

- FAL — `fal.ai/models/<endpoint>/api`. Get the exact endpoint id. A successor may sit under the same path (`.../sound-effects` → `.../sound-effects/v2`) or move namespace entirely (`fal-ai/minimax-music/v2.6` → `minimax/music-3`), so search the model by name — never append a guessed version to the old id.
  - `curl "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>" | jq .components.schemas` is the authoritative input schema — field names, types, defaults, enums, min/max, and which are required.
  - `curl -X POST https://queue.fal.run/<id> -d {}` confirms the route: 401 exists, 404 does not.

Capture:

- Every input's exact API field name (snake_case as sent), type, default, and an enum's allowed values.
- The prompt/text field name — music-style models use `prompt`, speech and SFX models often `text`; map the konte key accordingly.
- The output media kind → `mediaType`.
- Free-form vs closed enum — MiniMax `voice_id` / `language_boost` are large open sets, modeled as plain `string`.

## The adapter shape

```ts
import { defineFalAsset } from "konte";

export const falMyModel = defineFalAsset({
  endpointId: "fal-ai/my-model/v2",
  description: "One line for `konte adapter list` — what it makes and what it is good at.",
  mediaType: "audio", // output kind: "image" | "video" | "audio" — drives download/normalization
  inputs: {
    // konteKey (camelCase, what the user writes) → provider field (snake_case, what's sent)
    prompt: { field: "prompt", type: "prompt", required: true },
    duration: { field: "duration", type: "number", default: 8 },
    format: { field: "format", type: "string", default: "mp3", values: ["mp3", "wav"] },
    seed: { field: "seed", type: "seed" },
  },
});
```

### Input def rules

- `type`: `"string" | "prompt" | "negativePrompt" | "spokenText" | "number" | "boolean" | "seed" | "seconds" | "image" | "video" | "audio"`.
  - `prompt` → a `string` carrying the model's natural-language conditioning, read by the prompt check. Type the positive prompt, a music model's style field, a voice-design instruction.
  - `negativePrompt` → an exposed negative field; only a negation inside it is refused.
  - `spokenText` → the words the model voices: a TTS `script`/`text`, a `lyrics` sheet. The prompt check skips it; `konte inspect --prompts` lists it.
  - `seed` → defaults to `seed()`, which auto-randomizes per variant; the user may pass a fixed value. Add it only when the model accepts a seed.
  - `seconds` → the clip's length, derived from the shot it plays in when the caller passes none (outside a shot `default` stands). With `values` the shortest numeric one that holds the shot is sent and the take plays windowed to it; without, whole seconds raised to `min`. One past `max` is refused at load.
  - `image` / `video` / `audio` → the input is a `MediaAsset`; only its `.src` is sent, and only when provided (no default emitted). Use these for reference-image / start-frame / source-audio inputs.
  - everything else → falls back to `default` when unset, and is emitted only when the resolved value is not `undefined`.
- `structure` (`"prompt"` only) — for a prompt that is a fixed grammar of named sections: the caller passes an object, each field's `render` writes its section (`fields` order, joined by `join`) before anything reads the prompt. The `render` parameter type is the caller's type; `render: () => "…"` is a constant section. Structure what the grammar fixes (headers, order, brackets, numbering). Example: the H3 adapters.
- `required: true` makes the call arg mandatory at the type level and is enforced at runtime — a missing value throws `MISSING_REQUIRED_INPUT`.
- `values` narrows the TS type for `type: "string"` / `"seconds"`; nothing validates it at runtime. List string enums for autocomplete; leave large open sets as bare `string`.
- `pin: "start" | "end"` — an `"image"` input the model reproduces pixel for pixel as the clip's first or last frame. One input per end, never with `array`.
- `stem: true` — the one `"audio"` input a model times its take to (lips, a beat). On a video shot of a piece cut to its song konte fills it with the board's `#songStem` and refuses anything written there. Not for a reference audio the prompt addresses by tag.
- `array: true` — media inputs only. The user passes an array of media assets and each `.src` is sent as a list element. Use it for a model whose media field takes a list (`image_urls`, `input_images`).
- Nested fields use a dotted `field` path. `"audio_setting.format"` expands into `{ audio_setting: { format } }`, and sibling leaves merge under the shared parent — so a provider's nested object is modeled as several flat konte keys, each with its own type/default/values. Placeholders, seeds and media resolve at any depth, so a nested path may carry a media or seed input. Only arrays-of-objects are unsupported.
- `fixed: true` pins a provider field the adapter owns: `default` is always sent, the key is absent from the call options and from `adapter show`, and no runtime value for it is read. For a field that selects _which adapter this is_ — one endpoint serving several modes, split into one export each — never for one a caller may want to set. Always pair it with a `default`; scalar types only.
- `promptExemptions` (config level) lists the negations this model is meant to be written with, as RegExps — every span one matches is cut out of a checked value before the prompt check reads it, as is a `script` line quoted verbatim inside an adapter's marked line span. Only where the model's own guide says so. The check's unit is the phrase; a finding is waived by its key in the stage's own `waivers` (a patch declares none), and `status` lists both the findings and the waivers whose phrase is gone.
- `spokenTextPattern` (config level) — a RegExp whose group 1 is the spoken words, for a model whose lines sit inside its `"prompt"` (H3's `<d>[Japanese] …</d>`). Without it the per-line `script-unvoiced` rule falls back to the whole-shot one, and the prompt check reads a quoted line as prompt text.
- `readsPrevPanel: true` (config level) — the model reads the previous shot's last panel, passed to one of its image inputs, as the frame a cut comes from (H3's `[Shot 1]`); `panel-unlinked` asks only such an adapter for that panel.
- `allowedIn` (config level) names the `asset()` sites the adapter may be declared in — an edit model works on a take that has to exist first, so a shot refuses it and a patch takes it.
- `deterministic: true` (config level) marks the output reproducible; set it only when the model genuinely is.
- `validators` (config level, one validator or an array) rejects an input combination the schema cannot type: `promptReferenceTags({ tags })` for a model naming references by ordinal (it reads the adapter's one `"prompt"` input; pass `prompt:` only where there are two), `inertInputs({ inputs, when, reason, fix })` for one the model won't read in this configuration, `requireOneOf({ inputs, reason })` for a group where at least one must be set, else a pure function of the resolved inputs (keyed by input name) returning why it rejects them, or nothing when they pass. It runs on every definition build, so read only which inputs are present — never a media value's contents.

### Naming

Export `fal<Model>` in PascalCase after the prefix, matching existing exports' casing; a multi-mode model suffixes the mode (`T2v` / `I2v` / `R2v`).

## Steps to add one

1. Verify the endpoint id + input schema (above).
2. Create `src/cli/templates/workspace/adapters/fal/<model>.ts`, mapping each konte key → provider field.
3. Write the `description` so it states the lean an author picks on (look, motion character, mode).
4. `bun run build:embed-templates` — so `konte workspace new` ships the new adapter.
5. Verify (below).

## Auditing an existing adapter

Read the adapter and the live schema side by side and flag every divergence:

- a deprecated/renamed endpoint id;
- an exposed input not mapped, or mapped to a stale `field`;
- wrong/stale enum `values` or `default`, or a large open set frozen into `values`;
- a missing `array` on a list field;
- a `mediaType` that doesn't match the real output;
- a media input given a `default` (it can't have one).

Fix in the adapter; leave a genuinely useless field off.

## Verify

- `bun run check` — must pass; it also verifies each `guide` path resolves on disk.
- `konte adapter show <adapter>` in a workspace renders the final schema as an agent will read it.
- No live-API smoke test; schema-correctness against the docs is the gate.
