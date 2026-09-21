import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reserveVariantsBatch } from "../../cli/generate-orchestrator.js";
import { takeDefinitionSnapshot } from "../../cli/commands/preview/review-shared.js";
import { turboTakes } from "../../cli/turbo-takes.js";
import type { GenerationBackend, GenerationRequest } from "../backend.js";
import { computeDefinitionHash } from "../definition-hash.js";
import { applyTurboInputs, isTurboTake } from "../turbo.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineFalAsset } from "../dsl/fal-asset.js";
import type { JobManager } from "../job-manager.js";
import { StateManager } from "../state/index.js";
import { submitToBackend } from "../submit-generation.js";
import type {
  AssetState,
  ComfyAssetDefinition,
  FalAssetDefinition,
  GenerationJob,
  VariantState,
} from "../types/index.js";

const turboComfy = defineComfyAsset({
  workflow: "turbo.json",
  description: "test adapter with a turbo switch",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "prompt", required: true },
    steps: { nodeId: "4", field: "steps", type: "number", default: 20 },
    useTurbo: {
      nodeId: "5",
      field: "value",
      type: "boolean",
      default: false,
      also: [{ nodeId: "6", field: "switch" }],
    },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
  turbo: { useTurbo: true },
});

const plainComfy = defineComfyAsset({
  workflow: "plain.json",
  description: "test adapter without a turbo",
  inputs: { prompt: { nodeId: "3", field: "text", type: "prompt", required: true } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const speedFal = defineFalAsset({
  endpointId: "fal-ai/test",
  description: "test fal adapter with a speed mode",
  mediaType: "image",
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    mode: { field: "options.mode", type: "string", values: ["fast", "full"], default: "full" },
  },
  turbo: { mode: "fast" },
});

function comfyDef(): ComfyAssetDefinition {
  return turboComfy.createDefinition({ prompt: "a cat" }) as ComfyAssetDefinition;
}

function variant(file: string | null): VariantState {
  return { status: "none", file, createdAt: "2026-01-01T00:00:00.000Z" } as VariantState;
}

describe("turbo declaration", () => {
  it("builds the definition on the default and carries the turbo beside it", () => {
    const def = comfyDef();
    expect(def.inputs["5.value"]).toBe(false);
    expect(def.inputs["6.switch"]).toBe(false);
    expect(def.turboInputs).toEqual({ "5.value": true, "6.switch": true });
  });

  it("keeps a turbo input out of the call options and the adapter's inputs", () => {
    // @ts-expect-error — konte sets a turbo input; a stage file cannot.
    const def = turboComfy.createDefinition({ prompt: "a cat", useTurbo: true });
    expect((def as ComfyAssetDefinition).inputs["5.value"]).toBe(false);
    expect(turboComfy.meta.inputs.useTurbo).toBeUndefined();
    expect(turboComfy.meta.turbo).toEqual({ useTurbo: true });
  });

  it("leaves a definition without a turbo unchanged", () => {
    const def = plainComfy.createDefinition({ prompt: "a cat" }) as ComfyAssetDefinition;
    expect(def.turboInputs).toBeUndefined();
  });

  it("keys a fal turbo by the provider field path", () => {
    const def = speedFal.createDefinition({ prompt: "a cat" }) as FalAssetDefinition;
    expect(def.turboInputs).toEqual({ "options.mode": "fast" });
    expect((applyTurboInputs(def) as FalAssetDefinition).inputs).toEqual({
      prompt: "a cat",
      options: { mode: "fast" },
    });
    expect(def.inputs).toEqual({ prompt: "a cat", options: { mode: "full" } });
  });

  it.each([
    ["an undeclared input", { missing: true }, /does not declare/],
    ["a media input", { image: "x" }, /string, number or boolean/],
    ["a required input", { prompt: "x" }, /fixed or required/],
    ["a value of another type", { steps: "8" }, /typed "number"/],
  ])("rejects %s", (_label, turbo, message) => {
    expect(() =>
      defineComfyAsset({
        workflow: "bad.json",
        description: "bad turbo",
        inputs: {
          prompt: { nodeId: "3", field: "text", type: "string", required: true },
          steps: { nodeId: "4", field: "steps", type: "number", default: 20 },
          image: { nodeId: "7", field: "image", type: "image" },
        },
        outputs: { result: { nodeId: "9", type: "image" } },
        turbo: turbo as never,
      }),
    ).toThrow(message);
  });

  it("does not move the definition hash", () => {
    const def = comfyDef();
    const { turboInputs: _, ...withoutTurbo } = def;
    expect(computeDefinitionHash(def)).toBe(computeDefinitionHash(withoutTurbo));
  });
});

describe("isTurboTake", () => {
  const def = comfyDef();

  it("takes the first take on turbo of a shot or timeline asset", () => {
    expect(isTurboTake("animatic:shot.01.first", def, undefined)).toBe(true);
    expect(isTurboTake("video:timeline.bed", def, { variants: {} })).toBe(true);
  });

  it("takes nothing on turbo once a take produced a file", () => {
    const asset: AssetState = { variants: { "v-a": { ...variant("a.png"), status: "dismissed" } } };
    expect(isTurboTake("animatic:shot.01.first", def, asset)).toBe(false);
  });

  it("still takes turbo after a take that failed", () => {
    const asset: AssetState = { variants: { "v-a": variant(null) } };
    expect(isTurboTake("animatic:shot.01.first", def, asset)).toBe(true);
  });

  it.each(["reference:cook", "animatic:plate.kitchen", "video:shot.01.clip#delivery"])(
    "never takes %s on turbo",
    (address) => {
      expect(isTurboTake(address, def, undefined)).toBe(false);
    },
  );

  it("never takes turbo for a deterministic asset or one whose adapter declares no turbo", () => {
    expect(isTurboTake("animatic:shot.01.first", { ...def, deterministic: true }, undefined)).toBe(
      false,
    );
    const plain = plainComfy.createDefinition({ prompt: "a cat" });
    expect(isTurboTake("animatic:shot.01.first", plain, undefined)).toBe(false);
  });
});

describe("turbo takes through reservation and submission", () => {
  let videoRoot: string;

  beforeEach(async () => {
    videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "konte-turbo-"));
    await StateManager.init(videoRoot);
  });

  afterEach(async () => {
    await fs.rm(videoRoot, { recursive: true, force: true });
  });

  async function reserve(address: string): Promise<string> {
    const def = comfyDef();
    const ids = await reserveVariantsBatch(videoRoot, [
      { address, variantCount: 1, definitionHash: computeDefinitionHash(def), assetDef: def },
    ]);
    return ids.get(address)![0]!;
  }

  async function submitted(address: string, variantId: string): Promise<GenerationRequest> {
    let seen: GenerationRequest | undefined;
    const backend = {
      submit: async (req: GenerationRequest) => {
        seen = req;
        return "backend-1";
      },
    } as unknown as GenerationBackend;
    const jobManager = {
      videoRoot,
      beginSubmission: async () => {},
      appendLog: () => {},
    } as unknown as JobManager;
    const job = {
      id: variantId,
      variantId,
      address,
      backendKind: "comfy",
      lease: { owner: "w-test" },
    } as unknown as GenerationJob;
    await submitToBackend(jobManager, backend, job, {
      address,
      assetDefinition: comfyDef(),
      variantId,
      outputDir: videoRoot,
      resolvedDependencies: {},
    });
    return seen!;
  }

  it("submits the first take on turbo and the next on the defaults", async () => {
    const address = "animatic:shot.01.first";
    const first = await reserve(address);
    const firstReq = await submitted(address, first);
    expect((firstReq.assetDefinition as ComfyAssetDefinition).inputs["5.value"]).toBe(true);

    await StateManager.withLock(videoRoot, async (m) => {
      m.getAssetState(address).variants![first]!.file = "first.png";
    });

    const second = await reserve(address);
    const state = (await StateManager.load(videoRoot)).getState();
    expect(state.assets[address]!.variants![first]!.turbo).toBe(true);
    expect(state.assets[address]!.variants![second]!.turbo).toBeUndefined();
    const secondReq = await submitted(address, second);
    expect((secondReq.assetDefinition as ComfyAssetDefinition).inputs["5.value"]).toBe(false);

    const manager = await StateManager.load(videoRoot);
    const shown = (vid: string) =>
      (takeDefinitionSnapshot(manager, videoRoot, address, vid) as ComfyAssetDefinition).inputs[
        "5.value"
      ];
    expect(shown(first)).toBe(true);
    expect(shown(second)).toBe(false);

    expect(
      await turboTakes(videoRoot, [
        { address, variantId: first },
        { address, variantId: second },
      ]),
    ).toEqual([{ address, variantId: first }]);
  });
});
