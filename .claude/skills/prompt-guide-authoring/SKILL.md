---
name: prompt-guide-authoring
description: Write or audit an adapter's craft guide and its input descriptions against the real schema. Read when adding a guide for a new adapter, or checking one for drift — wrong keys, stale values, a missing negative-prompt policy.
user-invocable: false
---

An adapter's craft guide teaches the agent how to drive one adapter — for a model-backed one, prompt-craft for the model behind it. It lives on the adapter, surfaced by `konte adapter show <adapter>`: a craft-prose `.md` plus the input schema whose per-input notes carry the parameter knowledge. Done = the guide's craft fits the model **and** the schema/descriptions document every non-obvious control with the right key, values, and mode/backend scope.

## Where things live

Bundled model adapters live under `src/cli/templates/workspace/adapters/{comfy,fal}/`. All bundled craft guides, including local operations, live under `src/cli/templates/workspace/dot.konte/guides/`, specified as `guide: "konte/guides/<name>.md"`.

- **Share a guide where the prompting rules hold across modes/backends; split where they differ.** Each adapter's `guide` field names its guide, or lists several read in order — the shared grammar first, the mode's own last — so no rule is written twice.

- **FAL** — hand-written: add `guide: "konte/guides/<model>.md"` to each export, and a one-line `description` to each non-obvious input.
- **ComfyUI (bundled)** — a re-emit drops the hand-edited `guide` field and input descriptions; restore them through `konte-comfy-workflow`.
- **ComfyUI (a user's own import)** — `konte adapter comfy import` scaffolds a sibling `adapters/comfy/<name>.md` and emits `guide: "./<name>.md"` in the adapter.
- **Read/audit against `konte adapter show <adapter>`** — it names the guide's file and renders the input schema (with descriptions).
- **Read `inputs`, `promptExemptions`, and `validators` for each adapter the guide covers.** For ComfyUI, also trace the conditioning in the workflow `.json`.

## The guide: craft prose only

No parameter table. Sections in order, omitting any that doesn't apply: `# <the model's name>`, `## Prompt Shape` (template line + gloss), `## Length`, model-specific sections as warranted (`## I2V`/`## FLF2V`/`## IA2V`, `## Edit Mode`, `## Multi-Image Editing`), `## Cost ladder`, `## Known failures`, `## Avoid`.

- Carry only what the schema can't: phrasing, length sweet spot, mode anchoring, model strengths/weaknesses. Concrete (kinetic verbs, visible physical detail, hex colors), never evaluative ("high quality").
- **`## Prompt Shape` stays prose** — the agent copies its template line + gloss.
- **Length, mode notes, Avoid are terse** — one rule per line, why inline. `## Avoid` includes this model's negative-phrasing rule.
- **`## Cost ladder` when the schema offers rungs** (resolution, steps, a tier, per-reference cost) — the rung to open on and what each higher one buys.
- **`## Known failures` from observed takes only** — `- **symptom** — the change that cleared it`; never a general belief about generation.
- **Keep parameter catalogs in the schema/descriptions** — the guide may recommend which value to choose, when, and what it changes.

## Parameters: input descriptions

From the adapter `inputs`, document each **non-obvious** control where it is durable:

- **One input's own knowledge → a one-line `description`** on the input def. `adapter show` already prints type/required/default/values, so a description adds meaning beyond them — units, interactions, gotchas — or is omitted (skip `prompt`, `seed`, a `values`-bearing `aspectRatio`/`duration`).
- **A rule spanning several inputs, or the prompt → the guide prose.** The table gives a description one unwrapped line.
- **Name by the konte input key**, not the provider field (`guidance` not `guidance_scale`; `inputImage` not `image`; `steps` not `num_inference_steps`) — that is what the agent writes in `asset()`.
- **A `description` is only about the input it sits on** — no "FAL only" / "T2V only" scoping. Cross-backend contrast (a comfy input vs its FAL twin) goes in the shared guide prose if anywhere.
- **`numImages`/`n`/batch — leave unset and undocumented** — one image per variant; alternatives come from `reroll --count`.
- **Never document model-infra inputs** (`ckptName`, `loraName`, `vaeName`, `textEncoder`, …).

## Negative-prompt & audio policy

Establish the field's availability from the adapter and workflow, and its use from model documentation or observed takes. Put an input-specific rule in its `description`, and rules spanning inputs or the prompt in the guide:

- **Exposed** (`negativePrompt`) — state when to use it, what to target, which modes make it effective, and observed side effects.
- **Comfy, unexposed but wired** — trace the sampler's `negative` in the `.json`: a real text node (even empty) can be exposed; a `ConditioningZeroOut` has no negative path.
- **Conditionally ineffective** — trace the mode/CFG that disables the negative branch; name the effective configuration and any combination the adapter rejects.
- **Unsupported** — state how to express exclusions affirmatively; name any model-specific negative phrasing the adapter permits through `promptExemptions`.
- **Audio** — if `generateAudio`/an audio input or output exists, state when sound is produced (e.g. only with `generateAudio` on).
- **Mention custom-adapter differences only when they change the reader's action.**

## Creating a guide

**FAL:**

1. Read the model's exports and decide which share prompting rules.
2. Write each guide under `dot.konte/guides/`; set each export's `guide` to the corresponding `konte/guides/<name>.md`.
3. Add a `description` to each non-obvious input; document the negative-prompt/audio policy above.
4. Verify.

**ComfyUI (bundled):** use the same guide placement and sharing rules; restore the wiring after a re-emit.

## Auditing an existing guide

Run `konte adapter show <adapter>`, read the guide it points at and the adapter source alongside the displayed schema, flag:

- a non-obvious input with no `description` and uncovered by the guide — the recurring miss is `negativePrompt`, `generateAudio`, a `mode`/tier field;
- a `description` with the wrong key or stale values/scope (schema wins);
- a duplicated parameter catalog or a leftover `## Parameters vs Prompt` table — move input facts to descriptions; retain advice on choosing values;
- a per-backend difference the guide claims but the schema lacks;
- recommended negative phrasing that `promptExemptions` does not permit, or an exemption unsupported by the guide;
- recommended input combinations that `validators` reject, or a rejected combination the guide presents as merely ineffective;
- for comfy, a workflow negative/conditioning node the guide ignores.

Fix in the guide `.md` and the input descriptions.

## Verify

- `konte adapter show <adapter>` in a workspace — verify the schema, descriptions, and resolved guide path.
- `bun run check:templates` — checks workspace adapters' bundled guide files exist and type-checks the templates, including input descriptions.
- Audit the guide's advice against the model and adapter behavior; automated checks do not establish its correctness.

## Scope

- **May** edit guide prose, the `guide` field, and per-input `description`s. Keep descriptions selective and schema-true.
- **Report required implementation changes separately** — inputs, workflow, `promptExemptions`, and `validators` belong to an adapter change; use `konte-comfy-workflow` for workflow changes.
