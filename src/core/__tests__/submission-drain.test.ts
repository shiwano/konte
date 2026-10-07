import { afterEach, beforeEach, expect, it } from "vitest";
import type { GenerationBackend, GenerationRequest, WaitForCompletionResult } from "../backend.js";
import { computeDefinitionHash } from "../definition-hash.js";
import { type DeliveryTarget, synthesizeDeliveryAssetDefinition } from "../delivery.js";
import type { AssetAdapter } from "../dsl/adapter.js";
import { upscale } from "../dsl/delivery-upscale.js";
import { JobManager } from "../job-manager.js";
import { submitReadyPendingJobs } from "../pending-jobs.js";
import type { VideoRoots } from "../roots.js";
import { StateManager } from "../state/index.js";
import { drainSubmissions } from "../submission-drain.js";
import type { BackendKind, DeliveryUpscaleFn, VideoDefinition } from "../types/index.js";
import { emptyAnimatic, emptyReference } from "./helpers/shot.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

const fakeUpscale: AssetAdapter<Record<string, unknown>, "video"> = {
  type: "video",
  meta: {
    backend: "fal",
    mediaType: "video",
    description: "test upscaler",
    ref: "fake",
    inputs: {},
  },
  createDefinition(inputs) {
    const video = inputs.video as { src: string };
    return {
      kind: "fal",
      endpointId: "fake",
      mediaType: "video",
      inputs: { video_url: video.src },
    };
  },
};
const fn: DeliveryUpscaleFn = ({ video, scale }) => upscale(fakeUpscale, { video, scale });
const VIDEO = {
  stage: "video" as const,
  format: { size: { width: 1280, height: 720 }, fps: 24 },
  typography: { lang: "en" as const },
  export: { delivery: { size: { width: 1920, height: 1080 }, upscale: { video: fn } } },
  shots: [{ id: "01", duration: 3, assets: {} }],
} as unknown as VideoDefinition;
const TARGET: DeliveryTarget = { scale: 1.5, width: 1920, height: 1080 };

// Holds every submit open until released.
class GatedBackend implements GenerationBackend {
  readonly started: string[] = [];
  private release: () => void = () => {};
  readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  open(): void {
    this.release();
  }
  async submit(request: GenerationRequest): Promise<string> {
    this.started.push(request.variantId);
    await this.gate;
    return `fake-${request.variantId}`;
  }
  async waitForCompletion(): Promise<WaitForCompletionResult> {
    throw new Error("not used");
  }
  async cancel(): Promise<void> {}
}

let ws: Workspace;
let roots: VideoRoots;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"], seedState: false });
  roots = ws.videos.v1!;
  await StateManager.init(roots.video);
});

afterEach(async () => {
  await ws.cleanup();
});

async function registerUpscale(jobManager: JobManager, source: string): Promise<string> {
  const address = `${source}#delivery`;
  const def = synthesizeDeliveryAssetDefinition(VIDEO, address, TARGET);
  const variantId = await StateManager.withLock(roots.video, async (m) => {
    const vid = m.reserveVariantId(address);
    m.getAssetState(address).variants![vid]!.deliveryTarget = TARGET;
    return vid;
  });
  await jobManager.createJob({
    address,
    variantId,
    resolvedDeps: { [source]: "assets/src.mp4" },
    backendKind: "fal",
    metadata: { definitionHash: computeDefinitionHash(def) },
  });
  return variantId;
}

it("lets a submit in flight commit its backend job id, and starts no other", async () => {
  const jobManager = new JobManager(roots.video);
  const first = await registerUpscale(jobManager, "video:shot.01.motion");
  const second = await registerUpscale(jobManager, "video:shot.01.other");
  const backend = new GatedBackend();

  const cascade = submitReadyPendingJobs(
    jobManager,
    roots,
    new Map<BackendKind, GenerationBackend>(),
    async () => backend,
    async () => ({ video: VIDEO, animatic: emptyAnimatic(), reference: emptyReference() }),
  );
  while (backend.started.length === 0) await new Promise((r) => setTimeout(r, 5));

  let drainedEarly = false;
  const drained = drainSubmissions(5_000).then(() => (drainedEarly = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(drainedEarly).toBe(false);
  backend.open();
  await drained;
  const res = await cascade;

  expect(backend.started).toHaveLength(1);
  const sent = backend.started[0]!;
  expect(res.submitted).toEqual([sent]);
  const job = await jobManager.getJob(sent);
  expect(job.kind === "generation" && job.backendJobId).toBe(`fake-${sent}`);
  const other = sent === first ? second : first;
  expect((await jobManager.getJob(other)).status).toBe("queued");
});
