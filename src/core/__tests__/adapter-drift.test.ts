import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDefinitionHash } from "../definition-hash.js";
import { applyResolutionDefinitions } from "../definition-hashes.js";
import { writeDefinitionSnapshot } from "../definition-snapshot.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineFalAsset } from "../dsl/fal-asset.js";
import { StateManager } from "../state/manager.js";
import type { AssetDefinition, ReferenceDefinition } from "../types/index.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

const ADDRESS = "reference:test";

const adapter = (steps: number | undefined) =>
  defineFalAsset({
    endpointId: "fal-ai/test",
    description: "test adapter",
    mediaType: "image",
    inputs: {
      prompt: { field: "prompt", type: "prompt", required: true },
      steps: { field: "steps", type: "number", default: steps },
    },
  });

let ws: Workspace;
let root: string;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"] });
  root = ws.videos.v1!.video;
});

afterEach(async () => {
  await ws.cleanup();
});

async function acceptUnder(
  made: AssetDefinition,
  current: AssetDefinition,
): Promise<{ sm: StateManager; id: string }> {
  const sm = await StateManager.load(root);
  const id = sm.reserveVariantId(ADDRESS);
  Object.assign(sm.getAssetState(ADDRESS).variants![id]!, {
    status: "accepted",
    file: "/tmp/test.png",
    definitionHash: computeDefinitionHash(made),
  });
  writeDefinitionSnapshot(root, ADDRESS, id, made);
  await applyResolutionDefinitions({
    videoRoot: root,
    state: sm.getState(),
    patchHashes: new Map(),
    definitions: {
      reference: { shots: [], topLevelAssets: { test: current } } as unknown as ReferenceDefinition,
    },
  });
  return { sm, id };
}

async function driftOf(made: AssetDefinition, current: AssetDefinition): Promise<boolean> {
  const { sm, id } = await acceptUnder(made, current);
  return sm.registeredAdapterDrift(ADDRESS, id);
}

async function signsOff(made: AssetDefinition, current: AssetDefinition): Promise<boolean> {
  const { sm } = await acceptUnder(made, current);
  return sm.acceptedAsDefined(ADDRESS, computeDefinitionHash(current));
}

describe("adapter drift", () => {
  it("reads a default the adapter moved as the adapter's change", async () => {
    const made = adapter(4).createDefinition({ prompt: "a cat" });
    const current = adapter(8).createDefinition({ prompt: "a cat" });
    expect(await driftOf(made, current)).toBe(true);
  });

  it("reads a value the call site dropped back to the default as the call site's edit", async () => {
    const made = adapter(8).createDefinition({ prompt: "a cat", steps: 12 });
    const current = adapter(8).createDefinition({ prompt: "a cat" });
    expect(await driftOf(made, current)).toBe(false);
  });

  it("reads a default the adapter added or removed as the adapter's change", async () => {
    const without = adapter(undefined).createDefinition({ prompt: "a cat" });
    const with8 = adapter(8).createDefinition({ prompt: "a cat" });
    expect(await driftOf(without, with8)).toBe(true);
    expect(await driftOf(with8, without)).toBe(true);
  });

  it("reads a value the call site dropped where the adapter has no default as its edit", async () => {
    const made = adapter(undefined).createDefinition({ prompt: "a cat", steps: 12 });
    const current = adapter(undefined).createDefinition({ prompt: "a cat" });
    expect(await driftOf(made, current)).toBe(false);
  });

  it("reads a nested default the adapter added or removed as the adapter's change", async () => {
    const nested = (format: string | undefined) =>
      defineFalAsset({
        endpointId: "fal-ai/test",
        description: "test adapter",
        mediaType: "audio",
        inputs: {
          text: { field: "text", type: "spokenText", required: true },
          format: { field: "audio_setting.format", type: "string", default: format },
        },
      });
    const without = nested(undefined).createDefinition({ text: "hello" });
    const withMp3 = nested("mp3").createDefinition({ text: "hello" });
    expect(await driftOf(without, withMp3)).toBe(true);
    expect(await driftOf(withMp3, without)).toBe(true);
  });

  it("reads an input re-pointed at another node as the adapter's change", async () => {
    const pointedAt = (nodeId: string) =>
      defineComfyAsset({
        workflow: "w.json",
        description: "test adapter",
        inputs: { prompt: { nodeId, field: "text", type: "prompt", required: true } },
        outputs: { image: { nodeId: "9", type: "image" } },
      });
    const made = pointedAt("1").createDefinition({ prompt: "a cat" });
    expect(await driftOf(made, pointedAt("2").createDefinition({ prompt: "a cat" }))).toBe(true);
    expect(await driftOf(made, pointedAt("2").createDefinition({ prompt: "a dog" }))).toBe(false);
  });

  it("reads a moved call-site input as the call site's edit", async () => {
    const made = adapter(8).createDefinition({ prompt: "a dog" });
    const current = adapter(4).createDefinition({ prompt: "a cat" });
    expect(await driftOf(made, current)).toBe(false);
  });
});

describe("acceptedAsDefined", () => {
  it("signs off an accept whose definition is unchanged", async () => {
    const def = adapter(8).createDefinition({ prompt: "a cat" });
    expect(await signsOff(def, def)).toBe(true);
  });

  it("signs off an accept whose definition moved only under its adapter", async () => {
    const made = adapter(4).createDefinition({ prompt: "a cat" });
    const current = adapter(8).createDefinition({ prompt: "a cat" });
    expect(await signsOff(made, current)).toBe(true);
  });

  it("does not sign off an accept whose call site moved", async () => {
    const made = adapter(8).createDefinition({ prompt: "a dog" });
    const current = adapter(8).createDefinition({ prompt: "a cat" });
    expect(await signsOff(made, current)).toBe(false);
  });
});
