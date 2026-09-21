import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { parsePlaceholder } from "../core/dsl/shot-context.js";
import { KonteError } from "../core/errors.js";
import { stableStringify } from "../core/stable-stringify.js";
import type { ComfyUIWorkflow } from "./types.js";

export async function loadWorkflow(workflowPath: string): Promise<ComfyUIWorkflow> {
  let raw: string;
  try {
    raw = await fs.readFile(workflowPath, "utf-8");
  } catch {
    throw new KonteError("WORKFLOW_NOT_FOUND", `Workflow file not found: "${workflowPath}"`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KonteError("WORKFLOW_INVALID", `Workflow file is not valid JSON: "${workflowPath}"`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KonteError("WORKFLOW_INVALID", `Workflow must be a JSON object: "${workflowPath}"`);
  }

  return parsed as ComfyUIWorkflow;
}

export function parameterizeWorkflow(
  workflow: ComfyUIWorkflow,
  inputs: Record<string, unknown>,
  seed: number,
  resolvedDependencies?: Record<string, string>,
  prunedNodes?: readonly string[],
  prunedPassThroughs?: Readonly<Record<string, string>>,
): ComfyUIWorkflow {
  const result: ComfyUIWorkflow = structuredClone(workflow);

  if (prunedNodes && prunedNodes.length > 0) {
    pruneNodes(result, new Set(prunedNodes), prunedPassThroughs ?? {});
  }

  for (const [nodeId, overrides] of Object.entries(inputs)) {
    const node = result[nodeId];
    if (!node) continue;
    if (typeof overrides === "object" && overrides !== null && !Array.isArray(overrides)) {
      result[nodeId] = {
        ...node,
        inputs: {
          ...node.inputs,
          ...(overrides as Record<string, unknown>),
        },
      };
    }
  }

  for (const [key, value] of Object.entries(inputs)) {
    const dotIndex = key.indexOf(".");
    if (dotIndex === -1) continue;
    const nodeId = key.slice(0, dotIndex);
    const field = key.slice(dotIndex + 1);
    const node = result[nodeId];
    if (!node) continue;
    node.inputs[field] = value;
  }

  for (const node of Object.values(result)) {
    node.inputs = substituteInValue(
      node.inputs,
      resolvedDependencies ?? {},
      seed,
    ) as typeof node.inputs;
  }

  return result;
}

function isLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

// Where an edge into a pruned node should land instead. A pass-through node stands for one of its
// own inputs (a ControlNet apply node stands for the `model` it patches), so the consumer follows
// that socket's source — through further pruned pass-throughs, since a chain of optional branches
// on one line all collapse together. Null when the source is a pruned node that is NOT a
// pass-through: there is nothing to fall back to, so the edge is dropped as before.
function spliceTarget(
  workflow: ComfyUIWorkflow,
  link: [string, number],
  pruned: ReadonlySet<string>,
  passThroughs: Readonly<Record<string, string>>,
): [string, number] | null {
  let current = link;
  for (let depth = 0; depth < 32 && pruned.has(current[0]); depth++) {
    const socket = passThroughs[current[0]];
    const source = socket === undefined ? undefined : workflow[current[0]]?.inputs[socket];
    if (!isLink(source)) return null;
    current = source;
  }
  return pruned.has(current[0]) ? null : current;
}

function pruneNodes(
  workflow: ComfyUIWorkflow,
  pruned: Set<string>,
  passThroughs: Readonly<Record<string, string>>,
): void {
  // Read the replacements BEFORE deleting anything — a pass-through's own input is what a consumer
  // falls back to, and it is gone the moment its node is.
  const spliced = new Map<string, [string, number] | null>();
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node.inputs)) {
      if (!isLink(value) || !pruned.has(value[0]) || spliced.has(value[0])) continue;
      spliced.set(value[0], spliceTarget(workflow, value, pruned, passThroughs));
    }
  }

  for (const id of pruned) delete workflow[id];

  for (const node of Object.values(workflow)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!isLink(value) || !pruned.has(value[0])) continue;
      const replacement = spliced.get(value[0]);
      if (replacement) node.inputs[field] = replacement;
      else delete node.inputs[field];
    }
  }
}

function substituteInValue(
  value: unknown,
  resolvedDependencies: Record<string, string>,
  seed: number,
): unknown {
  if (typeof value === "string") {
    const ref = parsePlaceholder(value);
    if (ref === "seed") return seed;
    if (ref && ref in resolvedDependencies) return resolvedDependencies[ref];
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteInValue(item, resolvedDependencies, seed));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteInValue(v, resolvedDependencies, seed);
    }
    return result;
  }
  return value;
}

export function computeWorkflowHash(workflow: ComfyUIWorkflow): string {
  const hash = createHash("sha256");
  hash.update(stableStringify(workflow));
  return hash.digest("hex");
}

export function computeInputHash(inputs: Record<string, unknown>): string {
  const hash = createHash("sha256");
  hash.update(stableStringify(inputs));
  return hash.digest("hex");
}
