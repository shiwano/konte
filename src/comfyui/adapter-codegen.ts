import type { AnalysisResult, AnalyzedInput, AnalyzedModel } from "./workflow-analyze.js";

function snakeToCamel(s: string): string {
  return s.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function renderModelsScaffold(models: AnalyzedModel[]): string[] {
  const lines: string[] = [];
  lines.push(`  // -------------------------------------------------------------------------`);
  lines.push(
    `  // models: Auto-detected model dependencies. Uncomment and fill in any empty \`url\``,
  );
  lines.push(`  // for each model you want konte to install automatically via ComfyUI-Manager`);
  lines.push(`  // before running this workflow. Models already present on the ComfyUI server`);
  lines.push(`  // are skipped. Leave commented-out to install them manually.`);
  lines.push(`  //`);
  lines.push(`  // - \`type\` controls which \`models/<subdir>/\` folder the file lands in`);
  lines.push(`  //   (checkpoint, lora, VAE, clip, diffusion_model, controlnet, upscale,`);
  lines.push(`  //    embeddings, clip_vision, unet)`);
  lines.push(`  // - \`savePath\` overrides the destination with a path relative to \`models/\` —`);
  lines.push(`  //   use it when a custom node loads from its own folder, e.g. "SEEDVR2" puts`);
  lines.push(
    `  //   the file in \`models/SEEDVR2/\`. \`type\` is still required (Manager metadata).`,
  );
  lines.push(`  // - \`url\` must point to a direct download. Examples:`);
  lines.push(`  //     HuggingFace: "https://huggingface.co/<repo>/resolve/main/<file>"`);
  lines.push(
    `  //     Civitai:     "https://civitai.com/api/download/models/<id>?token=\${CIVITAI_TOKEN}"`,
  );
  lines.push(
    `  //   \`\${VAR_NAME}\` placeholders are resolved at runtime from the workspace credentials.`,
  );
  lines.push(
    `  //   A gated HuggingFace repo needs no change to the URL — set \`HF_TOKEN\` in \`konte settings\``,
  );
  lines.push(`  //   and konte sends it as the bearer credential.`);
  lines.push(`  // - Optional \`base\` (e.g. "SDXL", "FLUX.1") helps Manager classify the model.`);
  lines.push(`  // -------------------------------------------------------------------------`);
  lines.push(`  // models: [`);
  for (const m of models) {
    const savePathPart =
      m.savePath !== undefined ? `, savePath: ${JSON.stringify(m.savePath)}` : "";
    lines.push(
      `  //   { filename: ${JSON.stringify(m.filename)}, type: ${JSON.stringify(m.type)}${savePathPart}, url: ${JSON.stringify(m.url ?? "")} },`,
    );
  }
  lines.push(`  // ],`);
  return lines;
}

function renderNodesScaffold(packs: string[]): string[] {
  const lines: string[] = [];
  lines.push(`  // -------------------------------------------------------------------------`);
  lines.push(`  // nodes: Auto-detected custom node packs this workflow uses (resolved to their`);
  lines.push(`  // ComfyUI-Manager registry ids). Uncomment the ones konte should auto-install`);
  lines.push(`  // via ComfyUI-Manager before running this workflow. Packs already present on the`);
  lines.push(`  // ComfyUI server are skipped; installing a missing one reboots ComfyUI once so`);
  lines.push(`  // its nodes load (set comfy.comfyui.autoRebootAfterNodeInstall: false to do this`);
  lines.push(`  // manually). Leave commented-out to manage custom nodes yourself.`);
  lines.push(`  //`);
  lines.push(`  // - \`id\` is the registry (cnr) id. A pack outside the registry is not`);
  lines.push(`  //   auto-installed; give it its \`custom_nodes\` directory name.`);
  lines.push(`  // - Optional \`version\` pins a release; omit for the latest.`);
  lines.push(`  // -------------------------------------------------------------------------`);
  lines.push(`  // nodes: [`);
  for (const p of packs) {
    lines.push(`  //   { id: ${JSON.stringify(p)} },`);
  }
  lines.push(`  // ],`);
  return lines;
}

function renderInputEntry(key: string, input: AnalyzedInput): string {
  const requiredPart = input.required ? `, required: true` : "";
  const defaultPart =
    input.default !== undefined ? `, default: ${JSON.stringify(input.default)}` : "";
  const valuesPart =
    input.values && input.values.length > 0
      ? `, values: [${input.values.map((v) => JSON.stringify(v)).join(", ")}]`
      : "";
  const alsoPart =
    input.also && input.also.length > 0
      ? `, also: [${input.also
          .map((t) => `{ nodeId: ${JSON.stringify(t.nodeId)}, field: ${JSON.stringify(t.field)} }`)
          .join(", ")}]`
      : "";
  const camelKey = snakeToCamel(key);
  // The key derives from workflow-supplied node titles; emit it as a JSON string
  // literal (unless a plain identifier) so it can't break out and inject code.
  const quotedKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(camelKey)
    ? camelKey
    : JSON.stringify(camelKey);
  return `${quotedKey}: { nodeId: ${JSON.stringify(input.nodeId)}, field: ${JSON.stringify(input.field)}, type: ${JSON.stringify(input.type)}${requiredPart}${defaultPart}${valuesPart}${alsoPart} },`;
}

// What `konte adapter list` shows for this adapter. The import can't know what the
// workflow is *for*, so it emits a marker the author (or the konte-comfy-workflow skill)
// rewrites into one line: what it generates, and when to pick it over its neighbours.
const DESCRIPTION_PLACEHOLDER = `description: "TODO: what this generates, and when to pick it",`;

// A workflow's text fields all look alike, so which one the model conditions on is the author's
// call — and it decides what the prompt check reads, and on which polarity.
const PROMPT_TYPE_PLACEHOLDER = `// TODO: type the model's natural-language conditioning inputs — "prompt" and "negativePrompt" (a spoken line stays "string")`;

// An edit model works on a take that has to exist first, and only the author knows whether this
// workflow is one.
const ALLOWED_IN_PLACEHOLDER = [
  `  // Uncomment if this workflow only works on a take that already exists (an edit model). The`,
  `  // sites are "patch", "plate", "reference", "timeline" and "shot"; omitted means all five:`,
  `  // allowedIn: ["patch", "reference"],`,
];

// A guide and a `validators` block are the author's, and a re-emit drops them with every other hand edit.
const GUIDE_PLACEHOLDER = `  // TODO: wire the craft guide — a \`guide\` naming its file`;

const VALIDATORS_PLACEHOLDER = [
  `  // TODO: a constraint across inputs the per-input schema cannot express, if any:`,
  `  // validators: promptReferenceTags({ tags: { Picture: ["image1"] } }),`,
];

// The other half the workflow cannot say (see `promptExemptions`).
const PROMPT_EXEMPTIONS_PLACEHOLDER = [
  `  // Negations this model is MEANT to be written with, if any:`,
  `  // promptExemptions: [/…/i],`,
];

// The sibling guide `konte adapter show` points at. Import scaffolds it as a TODO the author fills;
// the heading is the model's name, which the workflow name only guesses at.
export function comfyGuideScaffold(baseName: string): string {
  return (
    `# ${baseName}  <!-- TODO: the model's name, e.g. Seedance 2.5 -->\n\n` +
    `TODO: prompt-craft for this model — prompt shape, length, any mode/reference notes, and what to avoid.\n` +
    `Parameters are documented by the adapter's input schema; keep this to craft, not a parameter table.\n`
  );
}

export function generateAdapterCode(
  name: string,
  workflowFile: string,
  analysis: AnalysisResult,
  hiddenInputs: Record<string, AnalyzedInput> = {},
  nodePacks: string[] = [],
  // Where the doc `konte adapter show` points at lives. Only a user's import passes one — the
  // sibling `./<name>.md` it just scaffolded. The bundled sync passes none, and a re-emit leaves a
  // TODO for it.
  guideSpecifier?: string,
  // The adapter's `validators` block, rendered as source. `imports` names what the block needs
  // alongside `defineComfyAsset`.
  validators?: { imports: readonly string[]; source: string },
  // Which inputs carry the model's natural-language conditioning (emitted `type: "prompt"`, one of
  // the two types the prompt check reads), and the negations this model is meant to be written
  // with (`promptExemptions`, rendered as source). A workflow says neither.
  prompts?: { inputs?: readonly string[]; exemptions?: string },
): string {
  const exportName = snakeToCamel(name);
  const lines: string[] = [];
  lines.push(`// @generated`);
  lines.push(
    `import { ${["defineComfyAsset", ...(validators?.imports ?? [])].join(", ")} } from "konte";`,
  );
  lines.push("");
  lines.push(`export const ${exportName} = defineComfyAsset({`);
  lines.push(`  workflow: "${workflowFile}",`);
  lines.push(`  ${DESCRIPTION_PLACEHOLDER}`);
  if (!prompts) lines.push(...ALLOWED_IN_PLACEHOLDER);
  if (guideSpecifier) {
    lines.push(`  guide: "${guideSpecifier}",`);
  } else {
    lines.push(GUIDE_PLACEHOLDER);
  }
  if (analysis.models.length > 0) {
    lines.push(...renderModelsScaffold(analysis.models));
  }
  if (nodePacks.length > 0) {
    lines.push(...renderNodesScaffold(nodePacks));
  }
  lines.push(`  inputs: {`);
  // Both prompt scaffolds are the import path's: a caller that passes `prompts` has already made
  // the call (the bundled sync passes its per-adapter answer, `{}` where a model takes no prompt).
  if (!prompts) lines.push(`    ${PROMPT_TYPE_PLACEHOLDER}`);

  const promptInputs = new Set(prompts?.inputs ?? []);
  for (const [key, input] of Object.entries(analysis.inputs)) {
    if (input.comment) {
      lines.push(`    // ${input.comment}`);
    }
    lines.push(
      `    ${renderInputEntry(key, promptInputs.has(snakeToCamel(key)) ? { ...input, type: "prompt" } : input)}`,
    );
  }

  const hiddenEntries = Object.entries(hiddenInputs);
  if (hiddenEntries.length > 0) {
    lines.push(`    // --- Hidden subgraph-internal inputs (uncomment + rename to expose) ---`);
    for (const [key, input] of hiddenEntries) {
      if (input.comment) {
        lines.push(`    // ${input.comment}`);
      }
      lines.push(`    // ${renderInputEntry(key, input)}`);
    }
  }

  lines.push(`  },`);
  lines.push(`  outputs: {`);

  for (const [key, output] of Object.entries(analysis.outputs)) {
    const camelKey = snakeToCamel(key);
    const quotedKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(camelKey)
      ? camelKey
      : JSON.stringify(camelKey);
    lines.push(
      `    ${quotedKey}: { nodeId: ${JSON.stringify(output.nodeId)}, type: ${JSON.stringify(output.type)} },`,
    );
  }

  lines.push(`  },`);
  if (validators) {
    lines.push(`  validators: ${validators.source},`);
  } else {
    lines.push(...VALIDATORS_PLACEHOLDER);
  }
  if (prompts?.exemptions) {
    lines.push(`  promptExemptions: ${prompts.exemptions},`);
  } else if (!prompts) {
    lines.push(...PROMPT_EXEMPTIONS_PLACEHOLDER);
  }
  lines.push(`});\n`);

  return lines.join("\n");
}
