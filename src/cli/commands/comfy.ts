import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { resolveComfyUIConfig } from "../../comfyui/config.js";
import {
  convertLitegraphToApi,
  type LitegraphWorkflow,
  type SubgraphMeta,
} from "../../comfyui/convert.js";
import { ComfyUIHttpClient } from "../../comfyui/http-client.js";
import { ComfyUIManagerClient } from "../../comfyui/manager-client.js";
import type { ComfyUINodeDefinition } from "../../comfyui/types.js";
import { KonteError } from "../../core/errors.js";
import { requireWorkspaceRoot } from "../context.js";
import { declareScope } from "../scope.js";

// Fail fast when probing an unreachable ComfyUI instead of waiting out the
// client's default request timeout.
const COMFYUI_PING_TIMEOUT_MS = 5_000;

interface AnalyzedInput {
  nodeId: string;
  field: string;
  type: string;
  default?: string | number | boolean;
  // Combo (enum) choices, when the node's `object_info` declares them — lets the
  // adapter emit a literal-union `values: [...]` instead of a bare `string`.
  values?: readonly string[];
  required?: boolean;
  comment?: string;
  // True for inputs from a dedicated branch (prompts, images, videos, seeds) —
  // first-class knobs worth surfacing even when buried inside a subgraph.
  semantic?: boolean;
  // Extra `{nodeId, field}` targets that should receive this input's value —
  // set when several nodes shared one litegraph primitive (see collapseSharedInputs).
  also?: { nodeId: string; field: string }[];
}

interface AnalyzedOutput {
  nodeId: string;
  type: "image" | "video" | "audio";
}

interface AnalyzedModel {
  filename: string;
  type: string;
  nodeId: string;
  field: string;
}

interface AnalysisResult {
  inputs: Record<string, AnalyzedInput>;
  outputs: Record<string, AnalyzedOutput>;
  models: AnalyzedModel[];
}

interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

type WorkflowData = Record<string, WorkflowNode>;

interface InputCandidate {
  name: string;
  nodeId: string;
  field: string;
  type: string;
  default?: string | number | boolean;
  values?: readonly string[];
  required?: boolean;
  comment?: string;
  semantic?: boolean;
  also?: { nodeId: string; field: string }[];
}

interface LinkTarget {
  classType: string;
  field: string;
  title?: string;
}

function isLitegraphFormat(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return "last_node_id" in obj || "last_link_id" in obj || "nodes" in obj;
}

function isApiFormat(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([, value]) =>
      typeof value === "object" &&
      value !== null &&
      "class_type" in (value as object) &&
      "inputs" in (value as object),
  );
}

function isLink(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

function asPrimitive(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function buildReverseLinkMap(workflow: WorkflowData): Map<string, LinkTarget[]> {
  const map = new Map<string, LinkTarget[]>();
  for (const [, node] of Object.entries(workflow)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!isLink(value)) continue;
      const [srcId] = value as [string, number];
      const targets = map.get(srcId) ?? [];
      targets.push({ classType: node.class_type, field, title: node._meta?.title });
      map.set(srcId, targets);
    }
  }
  return map;
}

function buildNodeComment(
  nodeId: string,
  node: WorkflowNode,
  reverseLinkMap: Map<string, LinkTarget[]>,
): string {
  let comment = node.class_type;
  if (node._meta?.title && node._meta.title !== node.class_type) {
    comment += ` "${node._meta.title}"`;
  }

  const targets = reverseLinkMap.get(nodeId);
  if (targets && targets.length > 0) {
    const strs = targets.map((t) => `${t.title ?? t.classType}.${t.field}`);
    comment += ` → ${strs.join(", ")}`;
  }

  // Workflow-supplied `_meta.title`s flow into this comment; collapse line
  // terminators so a crafted title can't break out of the `//` line and inject
  // code into the generated adapter.
  return comment.replace(/[\r\n\v\f\u2028\u2029]+/g, " ");
}

function deduplicateNames(candidates: InputCandidate[]): Record<string, AnalyzedInput> {
  const nameCounts = new Map<string, number>();
  for (const c of candidates) {
    nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
  }

  const result: Record<string, AnalyzedInput> = {};
  const nameIndexes = new Map<string, number>();
  for (const c of candidates) {
    let key = c.name;
    if (nameCounts.get(c.name)! > 1) {
      const idx = nameIndexes.get(c.name) ?? 0;
      key = `${c.name}_${idx}`;
      nameIndexes.set(c.name, idx + 1);
    }
    const input: AnalyzedInput = { nodeId: c.nodeId, field: c.field, type: c.type };
    if (c.required) input.required = true;
    if (c.default !== undefined) input.default = c.default;
    if (c.values && c.values.length > 0) input.values = c.values;
    if (c.comment) input.comment = c.comment;
    if (c.semantic) input.semantic = true;
    if (c.also && c.also.length > 0) input.also = c.also;
    result[key] = input;
  }
  return result;
}

const SAMPLER_CLASSES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
]);

// Text-encode nodes whose prompt widget is a first-class knob. Their prompt
// field differs by class (`text` vs `prompt`), so PROMPT_FIELDS lists both.
const PROMPT_ENCODE_CLASSES = new Set(["CLIPTextEncode", "TextEncodeQwenImageEditPlus"]);
const PROMPT_FIELDS = new Set(["text", "prompt"]);

const SAVE_IMAGE_CLASSES = new Set([
  "SaveImage",
  "SaveImageAdvanced",
  "PreviewImage",
  "SaveAnimatedWEBP",
]);
const SAVE_VIDEO_CLASSES = new Set([
  "SaveVideo",
  "VHS_VideoCombine",
  "SaveAnimatedPNG",
  "SaveWEBM",
]);
const SAVE_AUDIO_CLASSES = new Set([
  "SaveAudio",
  "SaveAudioMP3",
  "SaveAudioOpus",
  "SaveAudioAdvanced",
  "PreviewAudio",
]);

// Widget fields that *are* a frame-rate knob regardless of node class — the name
// itself is the semantic, so matching it carries near-zero false-positive risk
// (unlike a generic `value`). Surfaced under one canonical key, `fps`, whether it
// sits inline on a video node (`CreateVideo.fps`, `VHS_VideoCombine.frame_rate`)
// or is carried by a Primitive passthrough wired into one — otherwise a
// Primitive-wired frame rate lands as an anonymous `value` that curation drops.
const FRAME_RATE_FIELDS = new Set(["fps", "frame_rate"]);
const FPS_KNOB_NAME = "fps";

function feedsFrameRate(targets: LinkTarget[] | undefined): boolean {
  return targets?.some((t) => FRAME_RATE_FIELDS.has(t.field)) ?? false;
}

// Maps (class_type → field → ComfyUI-Manager model type).
// Used by `comfy import` to scaffold a commented-out `models: [...]` block.
const MODEL_LOADER_RULES: Record<string, Record<string, string>> = {
  CheckpointLoaderSimple: { ckpt_name: "checkpoint" },
  CheckpointLoader: { ckpt_name: "checkpoint" },
  UNETLoader: { unet_name: "diffusion_model" },
  VAELoader: { vae_name: "VAE" },
  CLIPLoader: { clip_name: "clip" },
  DualCLIPLoader: { clip_name1: "clip", clip_name2: "clip" },
  TripleCLIPLoader: { clip_name1: "clip", clip_name2: "clip", clip_name3: "clip" },
  LoraLoader: { lora_name: "lora" },
  LoraLoaderModelOnly: { lora_name: "lora" },
  ControlNetLoader: { control_net_name: "controlnet" },
  UpscaleModelLoader: { model_name: "upscale" },
  CLIPVisionLoader: { clip_name: "clip_vision" },
  StyleModelLoader: { style_model_name: "checkpoint" },
};

// Files that look like model weights. Used by the generic detection fallback to
// catch loaders not covered by MODEL_LOADER_RULES (custom nodes, non-standard
// field names) so their dependencies still reach the scaffold.
const MODEL_FILE_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;

// Best-effort `models/<subdir>/` classification for fallback-detected files,
// inferred from the loader's class/field names. The scaffold is commented out
// for human curation, so a wrong guess is cheaper than dropping the dependency.
function inferModelType(classType: string, field: string): string {
  const hay = `${classType} ${field}`.toLowerCase();
  if (/vae/.test(hay)) return "VAE";
  if (/clip_?vision/.test(hay)) return "clip_vision";
  if (/control/.test(hay)) return "controlnet";
  if (/lora/.test(hay)) return "lora";
  if (/upscale/.test(hay)) return "upscale";
  if (/text_?encoder|\bclip\b|\bt5\b/.test(hay)) return "clip";
  if (/unet|diffusion/.test(hay)) return "diffusion_model";
  if (/embedding/.test(hay)) return "embeddings";
  return "checkpoint";
}

function detectModels(workflow: WorkflowData): AnalyzedModel[] {
  const seen = new Set<string>();
  const results: AnalyzedModel[] = [];
  // Pass 1: precise class+field rules carry an authoritative `type`.
  for (const [nodeId, node] of Object.entries(workflow)) {
    const rules = MODEL_LOADER_RULES[node.class_type];
    if (!rules) continue;
    for (const [field, modelType] of Object.entries(rules)) {
      const value = node.inputs[field];
      if (typeof value !== "string" || value.length === 0) continue;
      if (isLink(value)) continue;
      // Dedupe by filename (same model may be referenced from multiple nodes)
      if (seen.has(value)) continue;
      seen.add(value);
      results.push({ filename: value, type: modelType, nodeId, field });
    }
  }
  // Pass 2: generic fallback for any remaining string input whose value looks
  // like a model file but whose loader isn't in MODEL_LOADER_RULES.
  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || !MODEL_FILE_RE.test(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      results.push({
        filename: value,
        type: inferModelType(node.class_type, field),
        nodeId,
        field,
      });
    }
  }
  return results;
}

// A value that selects a key into a `JsonExtractString`'s embedded JSON map is an enum
// in disguise: its valid choices are that map's top-level keys. They're recoverable
// offline from the workflow itself — `object_info` never carries them, since the combo
// that drives the selector (e.g. a `CustomCombo`) is populated dynamically on the
// frontend. Comfy-Org's audio templates use this for a prompt-style `category` selector.
function jsonExtractKeyChoices(
  workflow: WorkflowData,
  sourceNodeId: string,
  currentValue: string,
): readonly string[] | undefined {
  for (const node of Object.values(workflow)) {
    if (node.class_type !== "JsonExtractString") continue;
    const keyInput = node.inputs.key;
    if (!isLink(keyInput) || (keyInput as [string, number])[0] !== sourceNodeId) continue;
    const jsonString = node.inputs.json_string;
    if (typeof jsonString !== "string") continue;
    try {
      const parsed = JSON.parse(jsonString) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const keys = Object.keys(parsed);
      // Only treat this input as the key selector when its own value is one of the map's
      // keys — a sibling string widget on the same node feeds a different socket, not the
      // key, so its value won't match and it keeps a bare `string` type.
      if (keys.includes(currentValue)) return keys;
    } catch {
      // Not valid JSON — no choices to recover.
    }
  }
  return undefined;
}

// A combo (enum) input is declared in `object_info` as `def[0]` being the array of
// choices (a scalar input has a type-name string there instead). Returns the choices
// when the field is a string combo, so its adapter entry can pin the valid values.
function comboChoices(
  objectInfo: Record<string, ComfyUINodeDefinition> | undefined,
  classType: string,
  field: string,
): readonly string[] | undefined {
  const def = objectInfo?.[classType];
  if (!def) return undefined;
  const spec = def.input.required?.[field] ?? def.input.optional?.[field];
  const choices = spec?.[0];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  if (!choices.every((c) => typeof c === "string")) return undefined;
  // A model/file picker's "choices" are the server's installed filenames — huge,
  // environment-specific, and often the very filename a `models: [...]` entry will
  // later add. That's not a stable enum, so don't pin it as a literal union.
  if (choices.some((c) => MODEL_FILE_RE.test(c))) return undefined;
  return choices as string[];
}

export function analyzeWorkflow(
  data: unknown,
  subgraphMeta?: SubgraphMeta,
  objectInfo?: Record<string, ComfyUINodeDefinition>,
): AnalysisResult {
  if (isLitegraphFormat(data)) {
    throw new KonteError(
      "WORKFLOW_IMPORT_FAILED",
      "Litegraph format detected. Please export the workflow in API format (Save (API Format) in ComfyUI).",
    );
  }

  if (!isApiFormat(data)) {
    throw new KonteError(
      "WORKFLOW_IMPORT_FAILED",
      "Invalid workflow format. Expected ComfyUI API format (each node must have class_type and inputs).",
    );
  }

  const workflow = data as WorkflowData;
  const reverseLinkMap = buildReverseLinkMap(workflow);
  const candidates: InputCandidate[] = [];
  const outputs: Record<string, AnalyzedOutput> = {};

  for (const [nodeId, node] of Object.entries(workflow)) {
    const classType = node.class_type;
    const comment = buildNodeComment(nodeId, node, reverseLinkMap);

    if (SAVE_IMAGE_CLASSES.has(classType)) {
      const name = `output_${Object.keys(outputs).length}`;
      outputs[name] = { nodeId, type: "image" };
      continue;
    }

    if (SAVE_VIDEO_CLASSES.has(classType)) {
      const name = `output_${Object.keys(outputs).length}`;
      outputs[name] = { nodeId, type: "video" };
      // A combined saver (e.g. VHS_VideoCombine) carries the frame rate as an
      // inline widget; the node short-circuits as an output, so surface its fps
      // knob here rather than letting it fall through to the generic branch.
      for (const [field, value] of Object.entries(node.inputs)) {
        if (isLink(value) || !FRAME_RATE_FIELDS.has(field)) continue;
        candidates.push({
          name: FPS_KNOB_NAME,
          nodeId,
          field,
          type: "number",
          default: asPrimitive(value),
          comment,
          semantic: true,
        });
      }
      continue;
    }

    if (SAVE_AUDIO_CLASSES.has(classType)) {
      const name = `output_${Object.keys(outputs).length}`;
      outputs[name] = { nodeId, type: "audio" };
      continue;
    }

    if (SAMPLER_CLASSES.has(classType)) {
      for (const [field, value] of Object.entries(node.inputs)) {
        if (isLink(value)) continue;

        if (field === "seed" || field === "noise_seed") {
          candidates.push({
            name: "seed",
            nodeId,
            field,
            type: "seed",
            default: asPrimitive(value),
            comment,
            semantic: true,
          });
        } else if (field === "steps" || field === "cfg" || field === "denoise") {
          candidates.push({
            name: field,
            nodeId,
            field,
            type: "number",
            default: asPrimitive(value),
            comment,
            semantic: true,
          });
        }
      }
      continue;
    }

    if (PROMPT_ENCODE_CLASSES.has(classType)) {
      for (const [field, value] of Object.entries(node.inputs)) {
        if (isLink(value)) continue;
        if (PROMPT_FIELDS.has(field)) {
          const title = node._meta?.title?.toLowerCase().replace(/\s+/g, "_") ?? "prompt";
          candidates.push({
            name: title,
            nodeId,
            field,
            type: "string",
            default: asPrimitive(value),
            comment,
            semantic: true,
          });
        }
      }
      continue;
    }

    if (classType === "LoadImage") {
      for (const [field, value] of Object.entries(node.inputs)) {
        if (isLink(value)) continue;
        if (field === "image") {
          candidates.push({
            name: "image",
            nodeId,
            field,
            type: "image",
            required: true,
            comment,
            semantic: true,
          });
        }
      }
      continue;
    }

    if (classType === "LoadVideo" || classType === "VHS_LoadVideo") {
      for (const [field, value] of Object.entries(node.inputs)) {
        if (isLink(value)) continue;
        // The file widget is `file` on ComfyUI core's LoadVideo, `video` on VHS_LoadVideo.
        if (field === "video" || field === "file") {
          candidates.push({
            name: "video",
            nodeId,
            field,
            type: "video",
            required: true,
            comment,
            semantic: true,
          });
        }
      }
      continue;
    }

    if (classType === "LoadAudio" || classType === "VHS_LoadAudio") {
      for (const [field, value] of Object.entries(node.inputs)) {
        if (isLink(value)) continue;
        // The file widget is `audio` on ComfyUI core's LoadAudio, `audio_file` on VHS_LoadAudio.
        if (field === "audio" || field === "audio_file") {
          candidates.push({
            name: "audio",
            nodeId,
            field,
            type: "audio",
            required: true,
            comment,
            semantic: true,
          });
        }
      }
      continue;
    }

    // A Primitive passthrough wired into a frame-rate widget surfaces as `fps`.
    const primitiveFeedsFps =
      classType.startsWith("Primitive") && feedsFrameRate(reverseLinkMap.get(nodeId));

    for (const [field, value] of Object.entries(node.inputs)) {
      if (isLink(value)) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const isFps = primitiveFeedsFps || FRAME_RATE_FIELDS.has(field);
        const values =
          typeof value === "string"
            ? (comboChoices(objectInfo, classType, field) ??
              jsonExtractKeyChoices(workflow, nodeId, value))
            : undefined;
        candidates.push({
          name: isFps ? FPS_KNOB_NAME : field,
          nodeId,
          field,
          type: typeof value as "string" | "number" | "boolean",
          default: asPrimitive(value),
          values,
          comment,
          semantic: isFps,
        });
      }
    }
  }

  const collapsed = subgraphMeta
    ? collapseSharedCandidates(candidates, subgraphMeta.sharedPrimitiveGroups)
    : candidates;
  return { inputs: deduplicateNames(collapsed), outputs, models: detectModels(workflow) };
}

// Several nodes that shared one litegraph primitive surface as separate candidates
// targeting the same value. Merge each such group into one candidate (the rest become
// `also` targets) so the adapter exposes a single knob that drives every node — e.g.
// one `seed` or `duration` instead of `seed0`/`seed1` or `duration`/`seconds`.
function collapseSharedCandidates(
  candidates: InputCandidate[],
  groups: { nodeId: string; field: string }[][],
): InputCandidate[] {
  if (groups.length === 0) return candidates;
  const dropped = new Set<InputCandidate>();
  for (const group of groups) {
    if (group.length < 2) continue;
    const members = candidates.filter((c) =>
      group.some((t) => t.nodeId === c.nodeId && t.field === c.field),
    );
    if (members.length < 2) continue;
    // A seed-typed member keeps the seed's auto-randomization; otherwise prefer a
    // semantic knob, then fall back to the first member.
    const primary =
      members.find((c) => c.type === "seed") ?? members.find((c) => c.semantic) ?? members[0]!;
    primary.also = members
      .filter((c) => c !== primary)
      .map((c) => ({ nodeId: c.nodeId, field: c.field }));
    // The merged knob drives every member, so its combo choices are only valid if
    // all members agree on them — otherwise pinning `primary.values` would reject
    // values legal for an `also` target. Drop it and fall back to a plain string.
    if (primary.values) {
      const key = JSON.stringify(primary.values);
      if (!members.every((c) => JSON.stringify(c.values ?? null) === key)) {
        primary.values = undefined;
      }
    }
    for (const c of members) {
      if (c !== primary) dropped.add(c);
    }
  }
  return candidates.filter((c) => !dropped.has(c));
}

function snakeToCamel(s: string): string {
  return s.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// Custom-node class_type values used by an API-format workflow, for node-pack resolution.
// When `objectInfo` is given, core classes (served by "nodes" / "comfy_extras.*" /
// "comfy_api_nodes.*") are excluded: the Manager's mapping DB lets custom packs shadow core
// node names (e.g. LoadAudio, SaveAudioMP3), so resolving them would scaffold bogus packs.
// Classes absent from objectInfo are kept — they're uninstalled custom nodes.
export function collectClassTypes(
  workflow: unknown,
  objectInfo?: Record<string, ComfyUINodeDefinition>,
): string[] {
  const set = new Set<string>();
  if (workflow && typeof workflow === "object") {
    for (const node of Object.values(workflow as Record<string, unknown>)) {
      const classType = (node as { class_type?: unknown })?.class_type;
      if (typeof classType !== "string" || classType.length === 0) continue;
      const pythonModule = objectInfo?.[classType]?.python_module;
      if (typeof pythonModule === "string" && !pythonModule.startsWith("custom_nodes.")) continue;
      set.add(classType);
    }
  }
  return [...set];
}

function renderModelsScaffold(models: AnalyzedModel[]): string[] {
  const lines: string[] = [];
  lines.push(`  // -------------------------------------------------------------------------`);
  lines.push(`  // models: Auto-detected model dependencies. Uncomment and fill in \`url\``);
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
    const typeLiteral = JSON.stringify(m.type);
    const filenameLiteral = JSON.stringify(m.filename);
    lines.push(`  //   { filename: ${filenameLiteral}, type: ${typeLiteral}, url: "" },`);
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
  lines.push(`  // its nodes load (set comfyui.autoRebootAfterNodeInstall: false to do this`);
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
  `  // Negations this model is MEANT to be written with (a freeze clause), if any:`,
  `  // promptExemptions: [/\\bnothing\\s+(?:moves|slides|turns)\\b/i],`,
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// The sibling guide `konte adapter show` points at. Import scaffolds it as a TODO the author fills;
// the heading is the model's name, which the workflow name only guesses at.
function comfyGuideScaffold(baseName: string): string {
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

// A subgraph author exposes only some of a subgraph's internal inputs. Drop the
// rest from the active set, returning the *semantic* ones (prompts, images,
// seeds, ...) so callers can surface them as commented-out hints for curation.
// Mutates `analysis.inputs`.
export function extractHiddenSubgraphInputs(
  analysis: AnalysisResult,
  subgraphMeta: SubgraphMeta,
): Record<string, AnalyzedInput> {
  const hidden: Record<string, AnalyzedInput> = {};
  if (subgraphMeta.internalNodeIds.size === 0) return hidden;
  for (const [key, input] of Object.entries(analysis.inputs)) {
    if (
      subgraphMeta.internalNodeIds.has(input.nodeId) &&
      !subgraphMeta.inputTargetKeys.has(`${input.nodeId}:${input.field}`)
    ) {
      if (input.semantic) hidden[key] = input;
      delete analysis.inputs[key];
    }
  }
  return hidden;
}

export function registerComfyCommand(program: Command): void {
  const comfy = program.command("comfy").description("Manage ComfyUI adapters");

  const importCmd = comfy
    .command("import <source>")
    .description("Import a ComfyUI workflow and generate an adapter")
    .option("--name <name>", "Name for the workflow adapter")
    .option("--no-adapter", "Skip adapter generation")
    .action(async (source: string, opts: { name?: string; adapter: boolean }) => {
      const workspaceRoot = requireWorkspaceRoot();
      const sourcePath = path.resolve(source);

      // `--name` becomes the adapter's filename (adapters/comfy/<name>.{json,ts}); reject
      // anything that isn't a single path segment so it can't escape the adapters dir.
      if (
        opts.name !== undefined &&
        (opts.name.length === 0 ||
          opts.name.includes("/") ||
          opts.name.includes("\\") ||
          opts.name !== path.basename(opts.name) ||
          opts.name === "." ||
          opts.name === "..")
      ) {
        throw new KonteError(
          "WORKFLOW_IMPORT_FAILED",
          `Invalid --name "${opts.name}": must be a plain filename with no path separators`,
        );
      }

      let rawJson: string;
      try {
        rawJson = await fs.readFile(sourcePath, "utf-8");
      } catch {
        throw new KonteError("WORKFLOW_IMPORT_FAILED", `Cannot read source file: ${sourcePath}`);
      }

      let data: unknown;
      try {
        data = JSON.parse(rawJson);
      } catch {
        throw new KonteError(
          "WORKFLOW_IMPORT_FAILED",
          `Invalid JSON in source file: ${sourcePath}`,
        );
      }

      // A native ComfyUI workflow is in litegraph format and must be converted to
      // API format (which needs `/object_info` from a running server) before the
      // backend can run it. An already-API-format file is used as-is, offline —
      // but it carries no subgraph metadata, so it gets no hidden-input hints.
      let apiWorkflow: unknown;
      let workflowJson: string;
      let subgraphMeta: SubgraphMeta | null = null;
      // cnr_ids of the custom node packs this workflow uses, scaffolded (commented-out) into
      // the adapter. Only resolvable on the litegraph path, where ComfyUI (and its Manager)
      // are reachable; best-effort, so a Manager that lacks the mapping API just yields none.
      let nodePacks: string[] = [];
      // An `object_info`-declared combo's choices live only on the server, absent from the
      // workflow JSON — so they're only recoverable on the litegraph path, where the server
      // is reachable. (A `JsonExtractString`-selected enum is the exception: those choices
      // are in the workflow JSON, so `analyzeWorkflow` recovers them on either path.)
      let objectInfo: Record<string, ComfyUINodeDefinition> | undefined;

      if (isLitegraphFormat(data)) {
        const config = await resolveComfyUIConfig(workspaceRoot);
        const client = new ComfyUIHttpClient(config.baseUrl, { headers: config.headers });
        if (!(await client.ping(COMFYUI_PING_TIMEOUT_MS))) {
          throw new KonteError(
            "WORKFLOW_IMPORT_FAILED",
            `Cannot reach ComfyUI at ${config.baseUrl} to convert the litegraph workflow. ` +
              `Start ComfyUI and run \`konte doctor\` to verify the connection, or export the ` +
              `workflow as API format (Save (API Format) in ComfyUI) and import that instead.`,
          );
        }
        objectInfo = await client.getObjectInfo();
        const converted = convertLitegraphToApi(data as LitegraphWorkflow, objectInfo);
        apiWorkflow = converted.workflow;
        subgraphMeta = converted.subgraphMeta;
        workflowJson = `${JSON.stringify(converted.workflow, null, 2)}\n`;

        try {
          const managerClient = new ComfyUIManagerClient(config.baseUrl, client);
          const classToPack = await managerClient.resolveClassToPack(
            collectClassTypes(converted.workflow, objectInfo),
          );
          nodePacks = [...new Set(classToPack.values())].sort();
        } catch {
          // Manager unavailable or no mapping API — skip the nodes scaffold (best-effort).
        }
      } else {
        apiWorkflow = data;
        workflowJson = rawJson;
      }

      const analysis = opts.adapter
        ? analyzeWorkflow(apiWorkflow, subgraphMeta ?? undefined, objectInfo)
        : undefined;
      if (analysis && Object.keys(analysis.outputs).length === 0) {
        throw new KonteError(
          "WORKFLOW_IMPORT_FAILED",
          `No image, video or audio output node found in ${sourcePath}. ` +
            `Recognized output nodes: ${[
              ...SAVE_IMAGE_CLASSES,
              ...SAVE_VIDEO_CLASSES,
              ...SAVE_AUDIO_CLASSES,
            ].join(", ")}.`,
        );
      }

      const baseName = opts.name ?? path.basename(source, ".json");
      const adapterDir = path.join(workspaceRoot, "adapters", "comfy");
      await fs.mkdir(adapterDir, { recursive: true });

      const workflowDest = path.join(adapterDir, `${baseName}.json`);
      await fs.writeFile(workflowDest, workflowJson, "utf-8");
      console.log(`Workflow saved: adapters/comfy/${baseName}.json`);

      if (!analysis) {
        return;
      }

      const hiddenInputs = subgraphMeta ? extractHiddenSubgraphInputs(analysis, subgraphMeta) : {};
      const guideFile = `${baseName}.md`;
      const adapterCode = generateAdapterCode(
        baseName,
        `${baseName}.json`,
        analysis,
        hiddenInputs,
        nodePacks,
        `./${guideFile}`,
      );

      const adapterPath = path.join(adapterDir, `${baseName}.ts`);
      await fs.writeFile(adapterPath, adapterCode, "utf-8");
      console.log(`Adapter generated: adapters/comfy/${baseName}.ts`);

      // A TODO the author fills (like the description marker). Never clobber a hand-written one.
      const guidePath = path.join(adapterDir, guideFile);
      if (!(await fileExists(guidePath))) {
        await fs.writeFile(guidePath, comfyGuideScaffold(baseName), "utf-8");
        console.log(`Guide scaffolded: adapters/comfy/${guideFile}`);
      }
    });

  // Adapters are workspace-wide, shared by every video. The type-check is skipped because the
  // adapter this command is about to write is exactly what would make it pass.
  declareScope(importCmd, { scope: "workspace", skipTypeCheck: true });
}
