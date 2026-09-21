import { describe, expect, it } from "vitest";
import { computeDefinitionHash } from "../definition-hash.js";
import {
  ComfyAssetDefinitionSchema,
  FalAssetDefinitionSchema,
  FileAssetDefinitionSchema,
  LocalAssetDefinitionSchema,
  NON_GENERATIVE_KEYS,
  VERDICT_AXIS_KEYS,
} from "../types/definition.js";
import type { AssetDefinition } from "../types/index.js";

const comfy = (extra: Partial<AssetDefinition> = {}): AssetDefinition =>
  ({ kind: "comfy", workflow: "w.json", inputs: { prompt: "a cat" }, ...extra }) as AssetDefinition;

describe("computeDefinitionHash", () => {
  // Flipping an adapter's review policy must never age out a take. Driven off VERDICT_AXIS_KEYS,
  // so an axis added later is covered here by that edit alone.
  it("ignores every verdict axis, set either way", () => {
    const bare = computeDefinitionHash(comfy());

    for (const axis of VERDICT_AXIS_KEYS) {
      for (const value of [true, false]) {
        expect(computeDefinitionHash(comfy({ [axis]: value }))).toBe(bare);
      }
    }
    const all = Object.fromEntries(VERDICT_AXIS_KEYS.map((axis) => [axis, true]));
    expect(computeDefinitionHash(comfy(all))).toBe(bare);
  });

  // Renaming an adapter's input, or declaring labels on a definition that had none, changes what a
  // reader is shown and nothing a backend receives.
  it("ignores the input labels", () => {
    const bare = computeDefinitionHash(comfy());

    expect(computeDefinitionHash(comfy({ inputLabels: { prompt: "prompt" } }))).toBe(bare);
    expect(computeDefinitionHash(comfy({ inputLabels: { prompt: "description" } }))).toBe(bare);
  });

  it("still moves on anything a backend reads", () => {
    const bare = computeDefinitionHash(comfy());

    expect(computeDefinitionHash(comfy({ inputs: { prompt: "a dog" } }))).not.toBe(bare);
    expect(computeDefinitionHash(comfy({ workflow: "other.json" }))).not.toBe(bare);
  });

  it("is stable across key order", () => {
    expect(
      computeDefinitionHash({
        inputs: { prompt: "a cat" },
        workflow: "w.json",
        kind: "comfy",
      } as AssetDefinition),
    ).toBe(computeDefinitionHash(comfy()));
  });
});

// The hash's exclusion list is `NON_GENERATIVE_KEYS`, which covers nothing added as a top-level
// sibling of `workflow`/`inputs` without being named there. Classify every field here: a new one
// fails this test until someone decides which side it is on.
describe("definition fields are classified", () => {
  const GENERATIVE: Record<string, readonly string[]> = {
    comfy: [
      "kind",
      "workflow",
      "inputs",
      "prunedNodes",
      "prunedPassThroughs",
      "outputNodeId",
      "models",
      "nodes",
    ],
    file: ["kind", "path", "type"],
    fal: ["kind", "endpointId", "mediaType", "inputs"],
    local: ["kind", "operation", "mediaType", "inputs"],
  };

  const NON_GENERATIVE: Record<string, readonly string[]> = {
    comfy: [...VERDICT_AXIS_KEYS, "inputLabels", "turboInputs"],
    file: VERDICT_AXIS_KEYS,
    fal: [...VERDICT_AXIS_KEYS, "inputLabels", "turboInputs"],
    local: VERDICT_AXIS_KEYS,
  };

  it.each([
    ["comfy", ComfyAssetDefinitionSchema],
    ["file", FileAssetDefinitionSchema],
    ["fal", FalAssetDefinitionSchema],
    ["local", LocalAssetDefinitionSchema],
  ])("%s declares no unclassified field", (kind, schema) => {
    expect(Object.keys(schema.shape).sort()).toEqual(
      [...GENERATIVE[kind]!, ...NON_GENERATIVE[kind]!].sort(),
    );
  });

  it("excludes every field classified non-generative from the hash", () => {
    for (const keys of Object.values(NON_GENERATIVE)) {
      for (const key of keys) expect(NON_GENERATIVE_KEYS).toContain(key);
    }
  });
});
