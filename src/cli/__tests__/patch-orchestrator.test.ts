import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerationBackend, WaitForCompletionResult } from "../../core/backend.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import { JobManager } from "../../core/job-manager.js";
import type { LoadedPatch } from "../../core/patch.js";
import { patchAssetAddress } from "../../core/patch.js";
import type { PatchOutputOrigin } from "../../core/patch-output.js";
import type { VideoRoots } from "../../core/roots.js";
import { StateManager } from "../../core/state/index.js";
import type { AssetDefinition, BackendKind, KonteConfig } from "../../core/types/index.js";
import { applyPatch } from "../patch-orchestrator.js";

const SOURCE_ADDRESS = "animatic:shot.01.first";
const CONFIG = { comfyui: { url: "http://127.0.0.1:8188" } } as KonteConfig;

class FakeBackend implements GenerationBackend {
  async submit(): Promise<string> {
    return "fake-job";
  }
  async waitForCompletion(): Promise<WaitForCompletionResult> {
    throw new Error("not used");
  }
  async cancel(): Promise<void> {}
}

function resize(inputs: Record<string, unknown>): AssetDefinition {
  return { kind: "local", operation: "resize", mediaType: "image", inputs } as AssetDefinition;
}

let ws: Workspace;
let roots: VideoRoots;
let jobManager: JobManager;
let backendCache: Map<BackendKind, GenerationBackend>;
let sourceVariantId: string;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"], seedState: false });
  roots = ws.videos.v1!;
  jobManager = new JobManager(roots.video);
  backendCache = new Map<BackendKind, GenerationBackend>([["local", new FakeBackend()]]);

  await StateManager.init(roots.video);
  sourceVariantId = await StateManager.withLock(roots.video, async (m) => {
    const vid = m.reserveVariantId(SOURCE_ADDRESS);
    const target = m.getAssetState(SOURCE_ADDRESS);
    if (target.variants) {
      target.variants[vid]!.file = "assets/animatic/shot.01.first/src.png";
      target.variants[vid]!.outputHash = "hash-source";
    }
    return vid;
  });
});

afterEach(async () => {
  await ws.cleanup();
});

function chain(patchHash: string, steps: "one" | "two"): LoadedPatch {
  const flattenedAddress = `animatic:patch.${sourceVariantId}.flattened`;
  const assets: Record<string, AssetDefinition> =
    steps === "one"
      ? { patched: resize({ image: `__konte:${SOURCE_ADDRESS}__`, width: 32, height: 32 }) }
      : {
          flattened: resize({ image: `__konte:${SOURCE_ADDRESS}__`, width: 64, height: 64 }),
          squared: resize({ image: `__konte:${flattenedAddress}__`, width: 32, height: 32 }),
        };
  return {
    assets,
    outputName: steps === "one" ? "patched" : "squared",
    sourceVariantId,
    sourceAddress: SOURCE_ADDRESS,
    filePath: `${roots.video}/patches/${sourceVariantId}.ts`,
    patchHash,
  };
}

function originOf(patch: LoadedPatch): PatchOutputOrigin {
  return {
    sourceAddress: patch.sourceAddress,
    sourceVariantId: patch.sourceVariantId,
    patchHash: patch.patchHash,
  };
}

/** A step's job from an earlier apply, still running: a reserved variant and a live job file. */
async function inFlightStep(
  patch: LoadedPatch,
  name: string,
  output: PatchOutputOrigin | null,
): Promise<string> {
  const address = patchAssetAddress(patch, name);
  const definitionHash = computeDefinitionHash(patch.assets[name]!);
  const variantId = await StateManager.withLock(roots.video, async (m) => {
    const vid = m.reserveVariantId(address);
    const target = m.getAssetState(address);
    if (target.variants) target.variants[vid]!.definitionHash = definitionHash;
    return vid;
  });
  await jobManager.createJob({
    address,
    variantId,
    resolvedDeps: {},
    backendKind: "local",
    metadata: {
      definitionHash,
      patchFinalize: { ...(output ? { output } : {}) },
    },
  });
  await jobManager.updateJob(variantId, { status: "running", backendJobId: "live" });
  return variantId;
}

describe("applyPatch in-flight steps", () => {
  it("joins an in-flight returned step from the same chain", async () => {
    const patch = chain("hash-a", "one");
    const running = await inFlightStep(patch, "patched", originOf(patch));

    const result = await applyPatch(patch, roots, jobManager, backendCache, CONFIG);

    expect(result.jobs).toEqual([{ variantId: running, status: "running" }]);
    expect(await jobManager.listJobs()).toHaveLength(1);
  });

  // patchHash spans every step, so a job queued before ANY of them was edited belongs to the
  // previous script: joining it would finalize this run's patched take under that one.
  it("queues a fresh job beside an in-flight step left by a different script", async () => {
    const stale = chain("hash-old", "one");
    const running = await inFlightStep(stale, "patched", originOf(stale));

    const result = await applyPatch(
      chain("hash-new", "one"),
      roots,
      jobManager,
      backendCache,
      CONFIG,
    );

    const launched = result.jobs[0]!.variantId;
    expect(launched).not.toBe(running);
    const job = await jobManager.getJob(launched);
    expect(job.metadata.patchFinalize).toMatchObject({ output: { patchHash: "hash-new" } });
    expect((await jobManager.getJob(running)).status).toBe("running");
  });

  // The reported failure's shape, one step earlier: editing `flattened` mid-flight rebuilds it, so
  // the in-flight `squared` — unedited, and therefore hash-matched — is building on a take this run
  // has already replaced.
  it("does not join a later step while an earlier one is being rebuilt", async () => {
    const patch = chain("hash-new", "two");
    // The old chain's `squared`: same definition as the current one, queued under the old script.
    const running = await inFlightStep(patch, "squared", {
      ...originOf(patch),
      patchHash: "hash-old",
    });

    const result = await applyPatch(patch, roots, jobManager, backendCache, CONFIG);

    const launched = result.jobs[0]!.variantId;
    expect(launched).not.toBe(running);
    expect(result.address).toBe(patchAssetAddress(patch, "squared"));

    // It waits on the `flattened` job this run started, and pins that job's variant so the ordinary
    // newest-ready rule cannot hand it the take the rebuild replaced.
    const flattenedAddress = patchAssetAddress(patch, "flattened");
    const jobs = await jobManager.listJobs();
    const flattened = jobs.find((j) => j.kind === "generation" && j.address === flattenedAddress);
    expect(flattened).toBeDefined();
    const job = await jobManager.getJob(launched);
    if (job.kind !== "generation") throw new Error("expected a generation job");
    expect(job.status).toBe("pending");
    expect(job.dependsOnJobs).toContain(flattened!.id);
    expect(job.metadata.pinnedDeps).toEqual({
      [SOURCE_ADDRESS]: sourceVariantId,
      [flattenedAddress]: flattened!.id,
    });
  });
});
