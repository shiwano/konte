import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FalHttpClient } from "../../fal/http-client.js";
import { TransientHttpError } from "../../core/http-retry.js";
import { defineComfyAsset } from "../../core/dsl/comfy-asset.js";
import { asset, defineVideo } from "../../core/dsl/index.js";
import { Composition } from "../../core/dsl/composition/composition.js";
import {
  emptyAnimatic,
  emptyReference,
  shot,
  videoTimeline,
} from "../../core/__tests__/helpers/shot.js";
import { testDirection } from "../../core/__tests__/helpers/direction.js";
import { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/index.js";
import type { VideoDefinition } from "../../core/types/index.js";
import { variantDir } from "../../core/variant-dir.js";
import { waitForJob } from "../wait-for-job.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { VideoRoots } from "../../core/roots.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const motionComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "video" } },
});

const FORMAT = { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } };

function buildVideo(): VideoDefinition {
  return defineVideo(testDirection(FORMAT), {
    timeline: () =>
      videoTimeline([
        shot("01", {
          duration: 5,
          build: () => {
            asset("motion", motionComfy, {});
            return el();
          },
        }),
      ]),
  });
}

let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"], seedState: false });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ws.cleanup();
});

const ADDRESS = "video:shot.01.motion";

// Create a `local` generation job whose output already sits on disk (LocalBackend just reads
// `output.*` from the variant dir — no network), already "running" with a backendJobId so
// waitForJob goes straight to the claim-or-monitor path.
async function setupLocalRunningJob(
  address = ADDRESS,
): Promise<{ jobManager: JobManager; variantId: string }> {
  await StateManager.init(tmpDir);
  let variantId = "";
  await StateManager.withLock(tmpDir, async (m) => {
    variantId = m.reserveVariantId(address);
  });

  const outDir = variantDir(tmpDir, address, variantId);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "output.png"), "fake-output");

  const jobManager = new JobManager(tmpDir);
  await jobManager.createJob({
    address,
    variantId,
    resolvedDeps: {},
    backendKind: "local",
  });
  await jobManager.updateJob(variantId, {
    status: "running",
    backendJobId: `local-${variantId}`,
  });
  return { jobManager, variantId };
}

describe("waitForJob completion ordering", () => {
  it("leaves a transient result failure resumable when the wait times out", async () => {
    const { jobManager, variantId } = await setupLocalRunningJob();
    await jobManager.updateJob(variantId, {
      backendKind: "fal",
      backendJobId: "fal-ai/test|req-1",
    });
    vi.stubEnv("FAL_KEY", "test-key");
    const submit = vi.spyOn(FalHttpClient.prototype, "submit");
    vi.spyOn(FalHttpClient.prototype, "getStatus").mockResolvedValue({ status: "COMPLETED" });
    const getResult = vi
      .spyOn(FalHttpClient.prototype, "getResult")
      .mockRejectedValue(new TransientHttpError("temporary outage"));
    const definitions = {
      video: buildVideo(),
      animatic: emptyAnimatic(),
      reference: emptyReference(),
    };
    const timedOut = await waitForJob(jobManager, variantId, roots, definitions, {
      timeoutMs: 100,
    });
    expect(timedOut.waitTimedOut).toBe(true);
    const pending = await jobManager.getJob(variantId);
    expect(pending.status).toBe("running");
    expect(pending.lease).toBeNull();
    getResult.mockResolvedValue({
      image: { url: "https://fal.media/result", file_name: "output.png" },
    });
    vi.spyOn(FalHttpClient.prototype, "downloadFile").mockResolvedValue();
    const recovered = await waitForJob(jobManager, variantId, roots, definitions);
    expect(recovered.status).toBe("completed");
    expect(submit).not.toHaveBeenCalled();
  });
  it("does not restore a cancelled variant while waiting for the state lock", async () => {
    const { jobManager, variantId } = await setupLocalRunningJob();
    const realWithLock = StateManager.withLock.bind(StateManager);
    vi.spyOn(StateManager, "withLock").mockImplementationOnce(async (root, fn) => {
      await jobManager.updateIfNotTerminal(variantId, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
      });
      await realWithLock(root, async (manager) => {
        const variant = manager.getAssetState(ADDRESS).variants![variantId]!;
        variant.file = null;
        variant.readyAt = null;
        variant.metadata = { cancelledAt: new Date().toISOString() };
      });
      return realWithLock(root, fn);
    });
    const result = await waitForJob(jobManager, variantId, roots, {
      video: buildVideo(),
      animatic: emptyAnimatic(),
      reference: emptyReference(),
    });
    expect(result.status).toBe("cancelled");
    const variant = (await StateManager.load(tmpDir)).getAssetState(ADDRESS).variants![variantId]!;
    expect(variant.file).toBeNull();
    expect(variant.readyAt).toBeNull();
    expect(variant.metadata).toHaveProperty("cancelledAt");
  });

  it("recovers a completed FAL result after a transient fetch failure without resubmitting", async () => {
    const { jobManager, variantId } = await setupLocalRunningJob();
    await jobManager.updateJob(variantId, {
      backendKind: "fal",
      backendJobId: "fal-ai/test|req-1",
    });
    vi.stubEnv("FAL_KEY", "test-key");
    const submit = vi.spyOn(FalHttpClient.prototype, "submit");
    vi.spyOn(FalHttpClient.prototype, "getStatus").mockResolvedValue({ status: "COMPLETED" });
    const getResult = vi
      .spyOn(FalHttpClient.prototype, "getResult")
      .mockRejectedValueOnce(new TransientHttpError("temporary outage"))
      .mockResolvedValue({ image: { url: "https://fal.media/result", file_name: "output.png" } });
    vi.spyOn(FalHttpClient.prototype, "downloadFile").mockImplementation(async (_url, dest) => {
      await fs.writeFile(dest, "recovered-output");
    });
    const result = await waitForJob(jobManager, variantId, roots, {
      video: buildVideo(),
      animatic: emptyAnimatic(),
      reference: emptyReference(),
    });
    expect(result.status).toBe("completed");
    expect(getResult).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    expect(await fs.readFile(path.resolve(tmpDir, result.outputFiles[0]!), "utf-8")).toBe(
      "recovered-output",
    );
  });
  it("commits the variant file to state before marking the job ready", async () => {
    const address = ADDRESS;
    const { jobManager, variantId } = await setupLocalRunningJob();

    // Observe the state exactly when the job is flipped to "completed" (now an ownership-guarded
    // finishIfOwner commit). With the fix, the variant file must already be present then.
    let fileAtReady: string | null | undefined = "UNOBSERVED" as unknown as string;
    const realFinish = jobManager.finishIfOwner.bind(jobManager);
    jobManager.finishIfOwner = (async (id, ownerId, update) => {
      if (update?.status === "completed") {
        const sm = await StateManager.load(tmpDir);
        fileAtReady = sm.tryGetAssetState(address)?.variants?.[id]?.file ?? null;
      }
      return realFinish(id, ownerId, update);
    }) as typeof jobManager.finishIfOwner;

    const result = await waitForJob(jobManager, variantId, roots, {
      video: buildVideo(),
      animatic: emptyAnimatic(),
      reference: emptyReference(),
    });

    expect(result.status).toBe("completed");
    expect(fileAtReady).not.toBe("UNOBSERVED");
    expect(fileAtReady).not.toBeNull();
    expect(fileAtReady).toContain("output.png");

    const finalState = await StateManager.load(tmpDir);
    expect(finalState.tryGetAssetState(address)?.variants?.[variantId]?.file).toContain(
      "output.png",
    );
  });

  it("does not mark the job completed when the state commit fails", async () => {
    const { jobManager, variantId } = await setupLocalRunningJob();

    // Force every state-commit attempt to fail (lock timeout, disk error, …).
    const realWithLock = StateManager.withLock.bind(StateManager);
    StateManager.withLock = (async () => {
      throw new Error("simulated state lock failure");
    }) as typeof StateManager.withLock;

    // The job must never flip to "completed" while its file is uncommitted in state.
    let completedCommits = 0;
    const realFinish = jobManager.finishIfOwner.bind(jobManager);
    jobManager.finishIfOwner = (async (id, ownerId, update) => {
      if (update?.status === "completed") completedCommits += 1;
      return realFinish(id, ownerId, update);
    }) as typeof jobManager.finishIfOwner;

    let sawStateError = false;
    try {
      const result = await waitForJob(
        jobManager,
        variantId,
        roots,
        { video: buildVideo(), animatic: emptyAnimatic(), reference: emptyReference() },
        { timeoutMs: 500, onStateUpdateError: () => (sawStateError = true) },
      );
      expect(result.status).not.toBe("completed");
    } finally {
      StateManager.withLock = realWithLock;
    }

    expect(sawStateError).toBe(true);
    expect(completedCommits).toBe(0);

    // Left non-terminal so a reclaimer can re-observe the backend job and retry the write.
    const job = await jobManager.getJob(variantId);
    expect(job.status).toBe("running");
  });

  it("stores the variant file as a project-relative path, not the backend's absolute one", async () => {
    const { jobManager, variantId } = await setupLocalRunningJob();

    const result = await waitForJob(jobManager, variantId, roots, {
      video: buildVideo(),
      animatic: emptyAnimatic(),
      reference: emptyReference(),
    });
    expect(result.status).toBe("completed");

    const stored = (await StateManager.load(tmpDir)).tryGetAssetState(ADDRESS)?.variants?.[
      variantId
    ]?.file;
    expect(stored).toBeDefined();
    expect(path.isAbsolute(stored as string)).toBe(false);
    expect(path.resolve(tmpDir, stored as string)).toBe(
      variantDir(tmpDir, ADDRESS, variantId) + "/output.png",
    );

    const job = await jobManager.getJob(variantId);
    if (job.kind !== "generation") throw new Error("expected a generation job");
    expect(job.outputFiles.every((f) => !path.isAbsolute(f))).toBe(true);
  });
});

describe("waitForJob run lease (owner/monitor)", () => {
  it("with two concurrent waiters, only the lease owner commits — the other monitors", async () => {
    const { jobManager, variantId } = await setupLocalRunningJob();

    // Count terminal "completed" commits: the owner makes exactly one; a monitor makes none.
    let readyCommits = 0;
    const realFinish = jobManager.finishIfOwner.bind(jobManager);
    jobManager.finishIfOwner = (async (id, ownerId, update) => {
      if (update?.status === "completed") readyCommits += 1;
      return realFinish(id, ownerId, update);
    }) as typeof jobManager.finishIfOwner;

    const [a, b] = await Promise.all([
      waitForJob(jobManager, variantId, roots, {
        video: buildVideo(),
        animatic: emptyAnimatic(),
        reference: emptyReference(),
      }),
      waitForJob(jobManager, variantId, roots, {
        video: buildVideo(),
        animatic: emptyAnimatic(),
        reference: emptyReference(),
      }),
    ]);

    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    expect(readyCommits).toBe(1);
  });

  it("reclaims a job whose previous owner's lease has lapsed", async () => {
    const { jobManager, variantId } = await setupLocalRunningJob();

    // Simulate a crashed owner: still "running" but holding an already-expired lease.
    await jobManager.updateJob(variantId, {
      lease: { owner: "w-dead", expiresAt: new Date(Date.now() - 1000).toISOString() },
    });

    const result = await waitForJob(jobManager, variantId, roots, {
      video: buildVideo(),
      animatic: emptyAnimatic(),
      reference: emptyReference(),
    });

    expect(result.status).toBe("completed");
    const job = await jobManager.getJob(variantId);
    expect(job.lease?.owner).not.toBe("w-dead");
  });
});
