import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationBackend, GenerationRequest, WaitForCompletionResult } from "../backend.js";
import { getAssetEntryByAddress } from "../address.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineVideo } from "../dsl/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { computeDefinitionHash } from "../definition-hash.js";
import { JobManager } from "../job-manager.js";
import { submitReadyPendingJobs } from "../pending-jobs.js";
import type { VideoRoots } from "../roots.js";
import type { LoadedDefinitions } from "../select-definition.js";
import { StateManager } from "../state/index.js";
import type { AssetDefinition, BackendKind, VideoDefinition } from "../types/index.js";
import { testDirection } from "./helpers/direction.js";
import { emptyAnimatic, emptyReference, shot, videoTimeline } from "./helpers/shot.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

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
        ]);
      },
    },
  );
}

class RecordingBackend implements GenerationBackend {
  readonly submitted: string[] = [];
  async submit(request: GenerationRequest): Promise<string> {
    this.submitted.push(request.variantId);
    return `fake-${request.variantId}`;
  }
  async waitForCompletion(): Promise<WaitForCompletionResult> {
    throw new Error("not used");
  }
  async cancel(): Promise<void> {}
}

const ADDRESS = "video:shot.01.motion";
const DEP = "video:timeline.character";

let ws: Workspace;
let roots: VideoRoots;
let videoRoot: string;
let jobManager: JobManager;
let backend: RecordingBackend;
let definitions: LoadedDefinitions;

function currentHash(): string {
  return computeDefinitionHash(
    getAssetEntryByAddress(definitions.video, ADDRESS) as AssetDefinition,
  );
}

async function createPendingJob(variantId: string, definitionHash: string): Promise<void> {
  await jobManager.createJob({
    address: ADDRESS,
    variantId,
    resolvedDeps: {},
    backendKind: "comfy",
    dependsOnAssets: [DEP],
    metadata: { definitionHash },
  });
}

function cascade(load: () => Promise<LoadedDefinitions> = async () => definitions) {
  return submitReadyPendingJobs(
    jobManager,
    roots,
    new Map<BackendKind, GenerationBackend>(),
    async () => backend,
    load,
  );
}

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"], seedState: false });
  roots = ws.videos.v1!;
  videoRoot = roots.video;
  // A stage entry on disk, so the fingerprint a job records has something to move with.
  await fs.writeFile(path.join(videoRoot, "video.tsx"), "// v1\n");
  jobManager = new JobManager(videoRoot);
  backend = new RecordingBackend();
  definitions = { video: buildVideo(), animatic: emptyAnimatic(), reference: emptyReference() };

  await StateManager.init(videoRoot);
  await StateManager.withLock(videoRoot, async (m) => {
    const dvid = m.reserveVariantId(DEP);
    const target = m.getAssetState(DEP);
    if (target.variants) target.variants[dvid]!.file = "out/character.png";
    m.setAccepted(DEP, dvid);
  });
});

afterEach(async () => {
  await ws.cleanup();
});

describe("submitReadyPendingJobs and a stale judge", () => {
  it("submits a job whose recorded hash matches the definition it reads", async () => {
    await createPendingJob("v-fresh001", currentHash());
    const res = await cascade();
    expect(res).toEqual({ submitted: ["v-fresh001"], failed: [], released: [] });
    expect(backend.submitted).toEqual(["v-fresh001"]);
  });

  it("reads definitions after listing the jobs, once per pass", async () => {
    await createPendingJob("v-order001", "000000000000");
    await fs.writeFile(path.join(videoRoot, "video.tsx"), "// v2 — the definition moved\n");
    const events: string[] = [];
    const listJobs = jobManager.listJobs.bind(jobManager);
    vi.spyOn(jobManager, "listJobs").mockImplementation(async (filter) => {
      events.push("list");
      return listJobs(filter);
    });
    const res = await cascade(async () => {
      events.push("load");
      return definitions;
    });
    expect(res.failed).toEqual(["v-order001"]);
    // The failure re-lists (a dependent may be doomed); with nothing left pending, no re-read.
    expect(events).toEqual(["list", "load", "list"]);
  });

  it("judges a job that landed mid-pass by definitions read after it was listed", async () => {
    await createPendingJob("v-first0001", "000000000000");
    await fs.writeFile(path.join(videoRoot, "video.tsx"), "// v2 — the definition moved\n");
    let loads = 0;
    const res = await cascade(async () => {
      loads++;
      // An agent's reroll landing while this pass runs: its hash is right for the files now.
      if (loads === 1) await createPendingJob("v-second001", currentHash());
      return definitions;
    });
    expect(res.failed).toEqual(["v-first0001"]);
    expect(res.submitted).toEqual(["v-second001"]);
    expect(loads).toBe(2);
  });

  it("fails a job whose definition files changed after it was queued", async () => {
    await createPendingJob("v-changed01", "000000000000");
    await fs.writeFile(path.join(videoRoot, "video.tsx"), "// v2 — the definition moved\n");
    const res = await cascade();
    expect(res.failed).toEqual(["v-changed01"]);
    expect(res.released).toEqual([]);
    const job = await jobManager.getJob("v-changed01");
    expect(job.status).toBe("failed");
    expect(job.error).toContain("changed after this job was queued");
    expect(job.error).toContain(`queued 000000000000, current ${currentHash()}`);
    expect(backend.submitted).toEqual([]);
  });

  it("hands a job back once when the files are unchanged but its own hash disagrees", async () => {
    // The job's hash is what the files on disk gave its creator; this judge's definitions say
    // otherwise while the fingerprint still matches — the judge, not the definition, is stale.
    await createPendingJob("v-stale0001", "000000000000");
    const first = await cascade();
    expect(first.submitted).toEqual([]);
    expect(first.failed).toEqual([]);
    expect(first.released).toEqual([
      {
        variantId: "v-stale0001",
        address: ADDRESS,
        queuedHash: "000000000000",
        currentHash: currentHash(),
      },
    ]);
    const released = await jobManager.getJob("v-stale0001");
    expect(released.status).toBe("pending");
    expect(released.lease).toBeNull();
    expect(released.startedAt).toBeNull();
    expect(released.staleReleases).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await jobManager.readLog("v-stale0001")).toContain("Released without submitting");
    expect(backend.submitted).toEqual([]);

    // A second judge that still disagrees fails it, naming what no fingerprinted file explains.
    const second = await cascade();
    expect(second.released).toEqual([]);
    expect(second.failed).toEqual(["v-stale0001"]);
    const failed = await jobManager.getJob("v-stale0001");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("in two processes");
    expect(failed.error).toContain("pid");
    expect(backend.submitted).toEqual([]);
  });

  it("stops judging for the pass after a release, leaving the rest to a fresh reader", async () => {
    await createPendingJob("v-stale0002", "000000000000");
    await createPendingJob("v-other0001", currentHash());
    await jobManager.updateJob("v-stale0002", { createdAt: "2026-01-01T00:00:00.000Z" });
    await jobManager.updateJob("v-other0001", { createdAt: "2026-01-01T00:00:00.001Z" });
    const res = await cascade();
    expect(res.released.map((r) => r.variantId)).toEqual(["v-stale0002"]);
    // Whatever this process would have judged next is left pending, untouched.
    expect(res.submitted).toEqual([]);
    expect((await jobManager.getJob("v-other0001")).status).toBe("pending");
  });
});
