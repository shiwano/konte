import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  diffDefinitions,
  formatDefinitionValue,
  readDefinitionSnapshot,
  writeDefinitionSnapshot,
} from "../definition-snapshot.js";
import type { AssetDefinition } from "../types/index.js";

const baseDef = (): AssetDefinition => ({
  kind: "fal",
  endpointId: "fal-ai/kling",
  mediaType: "video",
  inputs: { prompt: "a cat", duration: 5 },
  deterministic: false,
});

describe("definition snapshot sidecar", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "konte-defsnap-"));
  });

  it("round-trips a written snapshot", () => {
    const def = baseDef();
    writeDefinitionSnapshot(dir, "video:shot.01.motion", "v-abc", def);
    expect(readDefinitionSnapshot(dir, "video:shot.01.motion", "v-abc")).toEqual(def);
  });

  it("returns null when no snapshot exists", () => {
    expect(readDefinitionSnapshot(dir, "video:shot.01.motion", "v-missing")).toBeNull();
  });
});

describe("diffDefinitions", () => {
  it("reports no changes for identical definitions", () => {
    expect(diffDefinitions(baseDef(), baseDef())).toEqual([]);
  });

  it("reports changed nested fields by dotted path", () => {
    const oldDef = baseDef();
    const newDef = { ...baseDef(), inputs: { prompt: "a dog", duration: 8 } };
    expect(diffDefinitions(oldDef, newDef)).toEqual([
      { path: "inputs.duration", old: 5, new: 8 },
      { path: "inputs.prompt", old: "a cat", new: "a dog" },
    ]);
  });

  it("reports added and removed leaves", () => {
    const oldDef = { ...baseDef(), inputs: { prompt: "a cat" } };
    const newDef = { ...baseDef(), inputs: { prompt: "a cat", seed: 42 } };
    expect(diffDefinitions(oldDef, newDef)).toEqual([
      { path: "inputs.seed", old: undefined, new: 42 },
    ]);
  });

  // The only caller prints this to explain a definition-stale take, so a field the hash never read
  // cannot be the reason and must not crowd out the one that is.
  it("ignores a field the definition hash does not read", () => {
    const withLabels = { ...baseDef(), inputLabels: { prompt: "prompt" }, deterministic: true };
    expect(diffDefinitions(baseDef(), withLabels)).toEqual([]);
  });

  it("ignores function values dropped by JSON normalization", () => {
    const withFn = { ...baseDef(), inputs: { prompt: "a cat", duration: 5, fn: () => 1 } };
    expect(diffDefinitions(baseDef(), withFn)).toEqual([]);
  });
});

describe("formatDefinitionValue", () => {
  it("quotes strings and truncates long values", () => {
    expect(formatDefinitionValue("hi")).toBe('"hi"');
    expect(formatDefinitionValue(undefined)).toBe("(absent)");
    expect(formatDefinitionValue("x".repeat(100)).endsWith("…")).toBe(true);
  });
});
