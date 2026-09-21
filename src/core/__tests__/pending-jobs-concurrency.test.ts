import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForJob } from "../../backends/wait-for-job.js";
import type { GenerationBackend, GenerationRequest, WaitForCompletionResult } from "../backend.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineVideo } from "../dsl/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { emptyAnimatic, emptyReference, shot, videoTimeline } from "./helpers/shot.js";
import { testDirection } from "./helpers/direction.js";
import { KonteError } from "../errors.js";
import { JobManager } from "../job-manager.js";
import { submitToBackend } from "../submit-generation.js";
import { submitReadyPendingJobs } from "../pending-jobs.js";
import { resolveRefs } from "../ref-resolver.js";
import { StateManager } from "../state/index.js";
import type { BackendKind, VideoDefinition } from "../types/index.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";
import type { VideoRoots } from "../roots.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const animateWithImageComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { image: { nodeId: "1", field: "image", type: "image" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

function buildVideo(): VideoDefinition {
  return defineVideo(
    testDirection({
      fps: 30,
      size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
    }),
    {
      timeline: () => {
        const character = asset("character", imageComfy, { prompt: "a girl" });
        return videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              asset("motion", animateWithImageComfy, { image: character });
              return el();
            },
          }),
          shot("02", {
            duration: 5,
            build: () => {
              asset("motion", animateWithImageComfy, { image: character });
              return el();
            },
          }),
          shot("03", {
            duration: 5,
            build: () => {
              asset("motion", animateWithImageComfy, { image: character });
              return el();
            },
          }),
        ]);
      },
    },
  );
}

/** Backend that records every submit() call into a shared counter, keyed by variant. */
class CountingBackend implements GenerationBackend {
  constructor(
    private readonly counts: Map<string, number>,
    private readonly delayMs = 10,
  ) {}

  async submit(request: GenerationRequest): Promise<string> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const n = (this.counts.get(request.variantId) ?? 0) + 1;
    this.counts.set(request.variantId, n);
    return `fake-${request.variantId}-${n}`;
  }

  async waitForCompletion(): Promise<WaitForCompletionResult> {
    throw new Error("not used");
  }
  async cancel(): Promise<void> {}
}

let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;
let jobManager: JobManager;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"], seedState: false });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
  await fs.mkdir(path.join(tmpDir, ".konte"), { recursive: true });
  jobManager = new JobManager(tmpDir);
});

afterEach(async () => {
  await ws.cleanup();
});

describe("JobManager.claimForSubmission", () => {
  it("lets exactly one of N concurrent claimers win", { timeout: 15_000 }, async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-aaa11111",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: ["video:timeline.character"],
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        jobManager.claimForSubmission("v-aaa11111", `w-${i}`, 60_000),
      ),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe("running");

    const job = await jobManager.getJob("v-aaa11111");
    expect(job.status).toBe("running");
    expect(job.lease?.owner).toBe(winners[0]?.lease?.owner);
  });

  it("claims a fresh queued job (eager no-deps path)", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-bbb22222",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    // Created without deps → status "queued". The eager path claims it under a lease before
    // submitting, so a crash mid-submit strands a reclaimable "running" job, not a lease-less
    // "queued" orphan.
    const claimed = await jobManager.claimForSubmission("v-bbb22222", "w-x", 60_000);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lease?.owner).toBe("w-x");
  });

  it("returns null once a job is claimed by a live worker", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-ccc33333",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    expect(await jobManager.claimForSubmission("v-ccc33333", "w-1", 60_000)).not.toBeNull();
    // Now "running" under a live lease w-1 holds — no other worker can steal it.
    expect(await jobManager.claimForSubmission("v-ccc33333", "w-2", 60_000)).toBeNull();
  });

  it("reclaims a stranded submit (running, no backendJobId, no lease) but not a live one", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-ccc33333",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: ["video:timeline.character"],
    });

    // Submitter crashed mid-transaction: flipped to "running" but never committed a
    // backendJobId and left no lease.
    await jobManager.updateJob("v-ccc33333", { status: "running" });

    const reclaimed = await jobManager.claimForSubmission("v-ccc33333", "w-recover", 60_000);
    expect(reclaimed?.status).toBe("running");
    expect(reclaimed?.lease?.owner).toBe("w-recover");

    // Now it's owned by a live worker (valid lease) — a second claimer must not reclaim it.
    expect(await jobManager.claimForSubmission("v-ccc33333", "w-other", 60_000)).toBeNull();
  });
});

describe("submitReadyPendingJobs concurrency", () => {
  it.each(["fal", "comfy"] as const)(
    "does not resubmit a %s request after losing its acknowledgement",
    async (backendKind) => {
      await StateManager.init(tmpDir);
      const video = buildVideo();
      const address = "video:timeline.character";
      let variantId = "";
      await StateManager.withLock(tmpDir, async (manager) => {
        variantId = manager.reserveVariantId(address);
      });
      await jobManager.createJob({ address, variantId, resolvedDeps: {}, backendKind });
      const claimed = await jobManager.claimForSubmission(variantId, "w-original", 60_000);
      if (!claimed || claimed.kind !== "generation") throw new Error("claim failed");
      const counts = new Map<string, number>();
      const backend = new CountingBackend(counts, 0);
      await submitToBackend(jobManager, backend, claimed, {
        address,
        variantId,
        outputDir: path.join(tmpDir, "output"),
        resolvedDependencies: {},
        assetDefinition: { kind: "fal", endpointId: "fal-ai/test", mediaType: "image", inputs: {} },
      });
      await jobManager.updateJob(variantId, {
        lease: { owner: "w-original", expiresAt: new Date(0).toISOString() },
      });
      const run = () =>
        submitReadyPendingJobs(
          jobManager,
          roots,
          new Map(),
          async () => backend,
          async () => ({ video, animatic: emptyAnimatic(), reference: emptyReference() }),
        );
      const recovered = await run();
      expect(recovered.failed).toEqual([variantId]);
      expect((await jobManager.getJob(variantId)).error).toContain(
        "Automatic resubmission stopped",
      );
      await run();
      expect(counts.get(variantId)).toBe(1);
    },
  );

  it("retries a reclaimed job when submission had not started", async () => {
    await StateManager.init(tmpDir);
    const variantId = "v-before-submit";
    await jobManager.createJob({
      address: "video:timeline.character",
      variantId,
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.claimForSubmission(variantId, "w-original", 60_000);
    await jobManager.updateJob(variantId, { lease: null });
    const counts = new Map<string, number>();
    const result = await submitReadyPendingJobs(
      jobManager,
      roots,
      new Map(),
      async () => new CountingBackend(counts, 0),
      async () => ({ video: buildVideo(), animatic: emptyAnimatic(), reference: emptyReference() }),
    );
    expect(result.submitted).toEqual([variantId]);
    expect(counts.get(variantId)).toBe(1);
  });
  it("submits each pending job exactly once across concurrent submitters", async () => {
    const video = buildVideo();

    // The dependency must have a ready (file) variant so evaluateJob returns "submit".
    await StateManager.init(tmpDir);
    await StateManager.withLock(tmpDir, async (m) => {
      const depAddr = "video:timeline.character";
      const dvid = m.reserveVariantId(depAddr);
      const target = m.getAssetState(depAddr);
      if (target.variants) target.variants[dvid]!.file = "out/character.png";
      m.setAccepted(depAddr, dvid);
    });

    const variantIds = ["v-shot01aa", "v-shot02bb", "v-shot03cc"];
    const addresses = ["video:shot.01.motion", "video:shot.02.motion", "video:shot.03.motion"];
    for (let i = 0; i < variantIds.length; i++) {
      await jobManager.createJob({
        address: addresses[i]!,
        variantId: variantIds[i]!,
        resolvedDeps: {},
        backendKind: "comfy",
        dependsOnAssets: ["video:timeline.character"],
      });
    }

    // Two independent submitters (mirrors the MCP watcher vs `konte job wait`
    // two-process race), each with its own backend cache + backend instance,
    // but sharing the submit counter so we can assert the global total.
    const counts = new Map<string, number>();
    const resolveA = async (): Promise<GenerationBackend> => new CountingBackend(counts);
    const resolveB = async (): Promise<GenerationBackend> => new CountingBackend(counts);

    const [resA, resB] = await Promise.all([
      submitReadyPendingJobs(
        jobManager,
        roots,
        new Map<BackendKind, GenerationBackend>(),
        resolveA,
        async () => ({ video: video, animatic: emptyAnimatic(), reference: emptyReference() }),
      ),
      submitReadyPendingJobs(
        jobManager,
        roots,
        new Map<BackendKind, GenerationBackend>(),
        resolveB,
        async () => ({ video: video, animatic: emptyAnimatic(), reference: emptyReference() }),
      ),
    ]);

    // Each job was submitted to the backend exactly once.
    for (const vid of variantIds) {
      expect(counts.get(vid)).toBe(1);
    }

    // Each job is reported as submitted by exactly one of the two callers.
    const allSubmitted = [...resA.submitted, ...resB.submitted];
    expect(allSubmitted.sort()).toEqual([...variantIds].sort());
    expect(resA.failed).toEqual([]);
    expect(resB.failed).toEqual([]);

    for (const vid of variantIds) {
      const job = await jobManager.getJob(vid);
      if (job.kind !== "generation") throw new Error("expected a generation job");
      expect(job.status).toBe("running");
      expect(job.backendJobId).toBe(`fake-${vid}-1`);
    }
  });
});

describe("submitReadyPendingJobs upstream gating", () => {
  it("holds a downstream job while its upstream regenerates, then submits it against the fresh upstream", async () => {
    const video = buildVideo();

    // Upstream (shot.01.motion) already has a stale variant with a file — the exact trap
    // the old evaluateJob fell into: "a file exists ⇒ downstream is submittable", ignoring
    // the job currently regenerating that upstream.
    await StateManager.init(tmpDir);
    const upstreamAddr = "video:shot.01.motion";
    await StateManager.withLock(tmpDir, async (m) => {
      const oldVid = m.reserveVariantId(upstreamAddr);
      const s = m.getAssetState(upstreamAddr);
      if (s.variants) {
        s.variants[oldVid]!.file = "out/shot01-old.png";
        s.variants[oldVid]!.createdAt = "2026-01-01T00:00:00.000Z";
      }
    });

    // The upstream job actively regenerating shot.01.motion: running with a committed
    // backendJobId, so it is not itself re-submittable this pass.
    await jobManager.createJob({
      address: upstreamAddr,
      variantId: "v-up111111",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-up111111", { status: "running", backendJobId: "live-up" });

    // The downstream job consumes the upstream asset.
    await jobManager.createJob({
      address: "video:shot.02.motion",
      variantId: "v-down2222",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: [upstreamAddr],
    });

    const counts = new Map<string, number>();
    const resolve = async (): Promise<GenerationBackend> => new CountingBackend(counts);

    // Phase 1 — upstream still running: the downstream must NOT submit, despite the file.
    const r1 = await submitReadyPendingJobs(
      jobManager,
      roots,
      new Map<BackendKind, GenerationBackend>(),
      resolve,
      async () => ({ video: video, animatic: emptyAnimatic(), reference: emptyReference() }),
    );
    expect(counts.get("v-down2222")).toBeUndefined();
    expect(r1.submitted).not.toContain("v-down2222");
    expect((await jobManager.getJob("v-down2222")).status).toBe("pending");

    // Upstream completes, landing a fresher variant (newer createdAt) with its own file.
    await jobManager.updateJob("v-up111111", {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    const freshFile = "out/shot01-new.png";
    await StateManager.withLock(tmpDir, async (m) => {
      const newVid = m.reserveVariantId(upstreamAddr);
      const s = m.getAssetState(upstreamAddr);
      if (s.variants) {
        s.variants[newVid]!.file = freshFile;
        s.variants[newVid]!.createdAt = "2026-06-01T00:00:00.000Z";
      }
    });

    // Phase 2 — no active upstream job: the downstream submits, resolving to the FRESH
    // upstream variant (newest non-stale), not the stale one it also could have used.
    const r2 = await submitReadyPendingJobs(
      jobManager,
      roots,
      new Map<BackendKind, GenerationBackend>(),
      resolve,
      async () => ({ video: video, animatic: emptyAnimatic(), reference: emptyReference() }),
    );
    expect(counts.get("v-down2222")).toBe(1);
    expect(r2.submitted).toContain("v-down2222");

    const down = await jobManager.getJob("v-down2222");
    if (down.kind !== "generation") throw new Error("expected a generation job");
    expect(down.status).toBe("running");
    expect(down.provenance.resolvedDependencies[upstreamAddr]).toBe(freshFile);
  });
});

// The shape `patch apply` failed on: a chain's later step waits on its earlier one, pinned to the
// exact take that step produced. That take is input-stale — a newer variant landed at the address it
// was built from — so ordinary resolution has nothing to offer for it, and resolving it anyway
// failed the submit before the pin it does not need could be applied.
describe("submitReadyPendingJobs pinned dependencies", () => {
  const UPSTREAM = "video:shot.01.motion";
  const PINNED_FILE = "out/shot01-pinned.mp4";

  // Lands a stale-but-ready variant at UPSTREAM, produced by a completed job, and returns its id.
  async function seedStaleUpstream(): Promise<string> {
    await StateManager.init(tmpDir);
    await StateManager.withLock(tmpDir, async (m) => {
      // Two takes of the upstream's own input, neither accepted: the newer one is what the
      // address resolves to now.
      const charAddr = "video:timeline.character";
      for (const [hash, createdAt] of [
        ["hash-old", "2026-01-01T00:00:00.000Z"],
        ["hash-new", "2026-06-01T00:00:00.000Z"],
      ]) {
        const vid = m.reserveVariantId(charAddr);
        const v = m.getAssetState(charAddr).variants![vid]!;
        v.file = `out/character-${hash}.png`;
        v.outputHash = hash!;
        v.createdAt = createdAt!;
      }
    });
    return StateManager.withLock(tmpDir, async (m) => {
      const vid = m.reserveVariantId(UPSTREAM);
      const v = m.getAssetState(UPSTREAM).variants![vid]!;
      v.file = PINNED_FILE;
      // Built from the older take, so this variant is input-stale against what the address
      // resolves to now — and unaccepted, so nothing selects it.
      v.inputFingerprints = { "video:timeline.character": "hash-old" };
      return vid;
    });
  }

  it("submits against the pinned variant even when its own resolution has gone stale", async () => {
    const video = buildVideo();
    const pinned = await seedStaleUpstream();

    // Control: the pin is load-bearing here — the ordinary rule resolves this upstream to nothing.
    const manager = await StateManager.load(tmpDir);
    expect(() => resolveRefs([UPSTREAM], manager)).toThrow(KonteError);

    await jobManager.createJob({
      address: UPSTREAM,
      variantId: pinned,
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob(pinned, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    await jobManager.createJob({
      address: "video:shot.02.motion",
      variantId: "v-down1111",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: [UPSTREAM],
      dependsOnJobs: [pinned],
      metadata: { pinnedDeps: { [UPSTREAM]: pinned } },
    });

    const counts = new Map<string, number>();
    const res = await submitReadyPendingJobs(
      jobManager,
      roots,
      new Map<BackendKind, GenerationBackend>(),
      async () => new CountingBackend(counts),
      async () => ({ video: video, animatic: emptyAnimatic(), reference: emptyReference() }),
    );

    expect(res.failed).toEqual([]);
    expect(res.submitted).toContain("v-down1111");
    const down = await jobManager.getJob("v-down1111");
    if (down.kind !== "generation") throw new Error("expected a generation job");
    expect(down.status).toBe("running");
    expect(down.provenance.resolvedDependencies[UPSTREAM]).toBe(PINNED_FILE);
  });

  it("does not hold a pinned job behind another job at the same address", async () => {
    const video = buildVideo();
    const pinned = await seedStaleUpstream();

    await jobManager.createJob({
      address: UPSTREAM,
      variantId: pinned,
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob(pinned, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    // A rival at the same address — a concurrent reroll of the take being corrected. It produces a
    // variant this job will never read, so it is none of its business.
    await jobManager.createJob({
      address: UPSTREAM,
      variantId: "v-rival111",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-rival111", { status: "running", backendJobId: "live-rival" });

    await jobManager.createJob({
      address: "video:shot.02.motion",
      variantId: "v-down2222",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: [UPSTREAM],
      dependsOnJobs: [pinned],
      metadata: { pinnedDeps: { [UPSTREAM]: pinned } },
    });

    const counts = new Map<string, number>();
    const res = await submitReadyPendingJobs(
      jobManager,
      roots,
      new Map<BackendKind, GenerationBackend>(),
      async () => new CountingBackend(counts),
      async () => ({ video: video, animatic: emptyAnimatic(), reference: emptyReference() }),
    );

    expect(res.submitted).toContain("v-down2222");
    const down = await jobManager.getJob("v-down2222");
    if (down.kind !== "generation") throw new Error("expected a generation job");
    expect(down.provenance.resolvedDependencies[UPSTREAM]).toBe(PINNED_FILE);
  });
});

describe("waitForJob backendJobId polling", () => {
  const video = buildVideo();

  it("does not fail instantly when a claimed job has no backendJobId yet", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-poll0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-poll0001", { status: "running" }); // backendJobId still null

    const promise = waitForJob(jobManager, "v-poll0001", roots, {
      video,
      animatic: emptyAnimatic(),
      reference: emptyReference(),
    });

    // Simulate the in-flight submit finishing terminally before the id is observed.
    await jobManager.updateJob("v-poll0001", {
      status: "completed",
      outputFiles: ["out/shot01.mp4"],
      completedAt: new Date().toISOString(),
    });

    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.alreadyTerminal).toBe(true);
    expect(result.error).toBeNull();
  });

  it(
    "reports submitPending (not failed) when the id never appears in the window",
    { timeout: 15_000 },
    async () => {
      await jobManager.createJob({
        address: "video:shot.01.motion",
        variantId: "v-poll0002",
        resolvedDeps: {},
        backendKind: "comfy",
      });
      await jobManager.updateJob("v-poll0002", { status: "running" });

      const result = await waitForJob(jobManager, "v-poll0002", roots, {
        video,
        animatic: emptyAnimatic(),
        reference: emptyReference(),
      });

      // A still-in-flight submit must not be reported as a terminal failure: that
      // would emit a false completion and poison dedup against the real one.
      expect(result.submitPending).toBe(true);
      expect(result.status).not.toBe("failed");
      expect(result.alreadyTerminal).toBe(false);
      expect(result.error).toBeNull();
    },
  );
});
