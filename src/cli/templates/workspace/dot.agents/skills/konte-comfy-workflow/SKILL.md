---
name: konte-comfy-workflow
description: Import a ComfyUI workflow into a konte project and clean up the auto-generated adapter file. Use when the user runs /konte-comfy-workflow <path>, imports a workflow JSON, or asks to fix a generated adapters/comfy/*.ts.
user-invocable: true
argument-hint: <path-to-workflow.json>
---

Import a ComfyUI workflow and clean up the auto-generated adapter. Done = `adapters/comfy/<name>.ts` reviewed (no `// @generated` marker), type-checked, its schema and guide verified, and backend readiness reported; wiring it into shots stays with `authoring-guide`.

- Every `adapters/comfy/…` path below is workspace-relative — work from the workspace root.

## Step 1: Import the Workflow

- Workflow path is `$ARGUMENTS` — if none given, ask the user for one.
- Before overwriting an existing adapter, copy its current `.ts` and `.json` to a unique backup directory outside `adapters/`; record that path for 2.1. Keep the backup until verification passes. If it has uncommitted hand-edits, ask before importing.

```sh
konte adapter comfy import $ARGUMENTS
```

- Native workflow JSON (ComfyUI's _Save_) is converted to API format through the running ComfyUI.
- API-format file (_Save (API Format)_) imports offline, but surfaces no hidden subgraph inputs (2.5) and no combo `values`.
- `--name <name>` — adapter name (default: the filename); `--no-adapter` — copy the workflow JSON only.
- Writes `adapters/comfy/<name>.json` (API format), `adapters/comfy/<name>.ts` (the `// @generated` adapter), and, only if absent, `adapters/comfy/<name>.md` (a TODO guide, 2.6). Re-import restores `guide: "./<name>.md"`.

## Step 2: Fix the Auto-Generated Adapter

### 2.1 Recover the Previous Hand-Fixed Version

- If this adapter was fixed before (skip for a brand-new adapter), diff the regenerated `.ts` and `.json` against the backups from Step 1.
- Restore all applicable hand-edits from the backup — input/output names, removed and hidden inputs, types and input metadata, defaults, `models`/`nodes`, descriptions, `guide`, validators, `promptExemptions`, `spokenTextPattern`, and declaration sites. Preserve URLs and `${VAR}` placeholders. Reproducing earlier fixes needs no re-confirmation.
- Only diverge where the workflow genuinely changed (a node/input added or removed, a changed default); apply 2.2–2.4 there.

### 2.2 Rename Field Keys

- Improve field names to be descriptive, using the `// NodeClass → Target.field` comment above each input as guidance; keep the `// …` comments — they document the data flow.
- Resolve the `// TODO: type the model's natural-language conditioning inputs` line — type those inputs per the Types section of the rename conventions.
- Field keys are lowerCamelCase (e.g. `clipName`); the `field` property keeps the original ComfyUI name (`field: "clip_name"`) — never change it.
- Naming, typing, combo `values`, grids, format-derived defaults and branches → [rename-conventions.md](references/rename-conventions.md). Match the already-fixed adapters (no `// @generated`).

### 2.3 Fill in the Dependency Blocks

- A commented-out `models: [...]` block — decide whether to enable it; uncomment and fill each `url` with a direct-download URL. URL formats, `savePath` and when to drop an entry → [model-downloads.md](references/model-downloads.md).
- Same call on the `nodes: [...]` block — uncomment the packs konte should install; ids and restart behavior are in the same reference.
- Never paste a raw token — always use `${VAR_NAME}` and tell the user which env var to set.

### 2.4 Remove Unnecessary Inputs

- Remove internal settings users typically don't change — weight dtype (`weightDtype`), device, internal type selectors (`type` for CLIPLoader), model sampling params (`shift` for ModelSamplingSD3), `batchSize` when always 1.
- Ask the user before removing inputs the workflow change newly introduced.

### 2.5 Expose Useful Hidden Inputs

The generated adapter may carry a commented-out block:

```
// --- Hidden subgraph-internal inputs (uncomment + rename to expose) ---
// CLIPTextEncode → LTXVConditioning.negative
// prompt: { nodeId: "361", field: "text", type: "string", default: "pc game, console game, ..." },
```

- These are inputs (prompts, images, videos, seeds) the workflow author left inside a subgraph — often a negative prompt.
- When one is worth controlling, uncomment, rename and retype it using 2.2 (e.g. key `negativePrompt`, type `"negativePrompt"`); add an expected-but-missing input by hand.
- Then delete the remaining unexposed commented lines (including the `// --- Hidden … ---` header once nothing under it is exposed).

### 2.6 Write the descriptions and the guide

- `description` (emitted as a TODO) — one line: what the adapter generates, and when to pick it over its neighbours (mode, look lean, length lean). `konte adapter list` shows it — the next session picks an adapter by it. Match the already-fixed adapters' phrasing.
- A non-obvious input takes a one-line `description` — printed beside its type and default, it carries what those can't (units, gotchas).
- `<name>.md` — the prompt-craft guide `konte adapter show` points at: prompt shape, length, mode/reference notes, and what to avoid. Write it from the model's official documentation and the adapter's actual schema; document only controls it exposes; per-input facts go in input descriptions.

### 2.7 Declare What the Schema Can't Type

Optional `validators` (one or an array) reject an input combination the model forbids but each input's type allows, failing the load before any spend.

- A model that names its references by ordinal — `promptReferenceTags({ tags: { Picture: ["image1", …] } })`, each tag's slots in numbering order; it reads the adapter's one `"prompt"` input, so name `prompt:` only where there are two. `form: "bare"` for a model writing them as prose (`image 1`) rather than `<Picture 1>`; `{ slots: [...], exhaustive: false }` when naming a wired slot is the author's call or the count is only a ceiling; `[]` for a tag this workflow cannot take.
- An image model drawing animatic keyframes that reads another shot's panel as the frame a cut comes from (H3 R2I's `[Shot 1]`) — `readsPrevPanel: true` beside `validators`, and `prevPanel: { tag, within }` on `promptReferenceTags`, `within` returning the span the panel's ordinal belongs in (`minimaxH3CutSource`).
- A model whose prompt is a fixed grammar of named sections — declare a `structure` on its `"prompt"` input; read [prompt-structure.md](references/prompt-structure.md).
- An input the model won't read in this configuration — `inertInputs({ inputs: { negativePrompt: [" ", ""] }, when: { useLightning: true }, reason, fix })`, each input mapped to the value that means "not set". `whenNot` states the condition as an absence.
- A group where at least one must be set — `requireOneOf({ inputs: { instruct: "", character: "Auto" }, reason })`.
- A negation this model is meant to be written with — `promptExemptions: [/…/]`, beside `validators`; every span one matches is cut from the value the prompt check reads. Leave it off a model with none.
- An input whose value follows from the others — `derive: { <input>: (inputs) => … }` beside `validators`, the input declared with no `default`. `inputs` are the others resolved, a structured prompt assembled. konte fills it, and it leaves the call options and `adapter show`.
- An edit model — uncomment `allowedIn` and name the sites it may be declared in.
- Anything else: a pure function of the resolved inputs that returns why it rejects them, or nothing when they pass, reading only which are present.

### 2.8 Remove the Scaffold Comments

- Remove the `// @generated` marker and every scaffold comment left unused — the `allowedIn`, `validators` and `promptExemptions` hints and any `// TODO` line.

### 2.9 Verify

1. Run `konte adapter show <name>` — verify loading, input/output types, defaults, descriptions and the guide path; read the guide and remove remaining TODOs.
2. Run `konte doctor --backends` — its type check covers `adapters/`, even with no video selected. Inspect the ComfyUI and Manager results even when the exit code is zero; an unused backend's failure is only a warning. Report unavailable services as unverified runtime readiness.
3. Report the adapter path, export name, guide path and verification results.
