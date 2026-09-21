# Structured prompts

For a model whose prompt is a fixed grammar of named sections (MiniMax H3's six fields).

## Shape

```ts
import { defineComfyAsset, formatCutTime } from "konte";

type Task = "keyframe completion" | "reference generation";
type Cut = { at: number; text: string };

prompt: {
  nodeId: "10", field: "prompt", type: "prompt", default: "",
  structure: {
    join: "\n\n",
    fields: {
      subjectDefinitions: {
        required: true,
        description: "one line per label, label written in the line",
        render: (lines: string[]) => `subject_definitions: ${lines.length > 0 ? lines.join("\n") : "N/A"}`,
      },
      summary: {
        required: true,
        render: (s: { tasks: [Task, ...Task[]]; text: string }) => `summary: [${s.tasks.join(" + ")}] ${s.text}`,
      },
      detailedDescription: {
        required: true,
        render: (d: { style: string; shots: [string] | [string, Cut] }) =>
          `detailed_description: ${d.style} ${d.shots
            .map((s, i) => (typeof s === "string" ? `[Shot ${i + 1}] ${s}` : `[Shot ${i + 1}] At ${formatCutTime(s.at)}, ${s.text}`))
            .join(" ")}`,
      },
      overallSoundscape: { render: () => "overall_soundscape: N/A" },
    },
  },
},
```

- **`structure` goes on a `"prompt"` input only**.
- **`join` is required.**
- **Fields render in declaration order**; a field with no value is left out, `join` between the rest.
- **`render`'s parameter type is the caller's type for that field** — annotate it; an unannotated parameter is `never`.
- **`render: () => "…"` is a constant section** — always written, never passed.
- **`required: true`** — the caller cannot omit it.
- **`description`** — printed under the input by `adapter show`.
- **`formatCutTime(seconds)`** — `mm:ss.mmm`, rounded to the millisecond; throws on a negative or non-finite value.

## What to structure

- **Structure what the grammar fixes and an author can get wrong** — section headers, their order, brackets, `+` joins, `[Shot N]` numbering, the cut-time format.
- **Type a closed set as a union or tuple** — task types, a shot count (`[string] | [string, Cut]`). The validator check it replaces can go.
- **Leave prose as `string`** — reference tags (`<Picture N>`), dialogue marks (`<d>…</d>`), descriptions. Those stay with `promptReferenceTags`, `spokenTextPattern` and the model's validator.
- **A label another field cites stays written by the author** — `<Subject 1>` is written into its own line, never numbered by `render`, so adding or reordering a line keeps every citation.
- **Two shapes of one prompt** (H3 R2A with or without a reference) — declare every field of both, none `required` but the shared ones, and let a validator refuse a mix.

## Pitfalls

- **A `render` parameter with a default value** (`(x = …) => …`) is read as a constant at run time — never give one a default.
- **`render` throws** → the load fails with `INVALID_ADAPTER_INPUT`, naming the asset and field.

## Verify

- `konte adapter show <adapter>` lists the fields under the prompt row.
- `konte inspect <address> --prompts` prints the assembled string — what the prompt check, validators and the model read.
