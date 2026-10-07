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
import type { BackendKind, DeliveryUpscaleFn, VideoDefinition } from "../types/index.js";
import { emptyAnimatic, emptyReference } from "./helpers/shot.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

const fakeUpscale: AssetAdapter<Record<string, unknown>, "video"> = {
  type: "video",
  meta: {
    backend: "fal",
    mediaType: "video",
    description: "test upscaler",
    ref: "fake/upscale",
    inputs: {},
  },
  createDefinition(inputs) {
    const video = inputs.video as { src: string };
    return {
      kind: "fal",
      endpointId: "fake/upscale",
      mediaType: "video",
      inputs: { video_url: video.src, scale: inputs.scale },
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

const SOURCE = "video:shot.01.motion";
const ADDRESS = `${SOURCE}#delivery`;
const TARGET: DeliveryTarget = { scale: 1.5, width: 1920, height: 1080 };

class RecordingBackend implements GenerationBackend {
  readonly requests: GenerationRequest[] = [];
  async submit(request: GenerationRequest): Promise<string> {
    this.requests.push(request);
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

it("submits a delivery upscale from the target its variant snapshotted", async () => {
  const def = synthesizeDeliveryAssetDefinition(VIDEO, ADDRESS, TARGET);
  const variantId = await StateManager.withLock(roots.video, async (m) => {
    const vid = m.reserveVariantId(ADDRESS);
    m.getAssetState(ADDRESS).variants![vid]!.deliveryTarget = TARGET;
    return vid;
  });
  const jobManager = new JobManager(roots.video);
  await jobManager.createJob({
    address: ADDRESS,
    variantId,
    resolvedDeps: { [SOURCE]: "assets/video/shot.01.motion/v-src.mp4" },
    backendKind: "fal",
    metadata: { definitionHash: computeDefinitionHash(def) },
  });

  const backend = new RecordingBackend();
  const res = await submitReadyPendingJobs(
    jobManager,
    roots,
    new Map<BackendKind, GenerationBackend>(),
    async () => backend,
    async () => ({ video: VIDEO, animatic: emptyAnimatic(), reference: emptyReference() }),
  );

  expect(res).toEqual({ submitted: [variantId], failed: [], released: [] });
  expect(backend.requests[0]!.assetDefinition).toEqual(def);
  expect(backend.requests[0]!.resolvedDependencies).toEqual({
    [SOURCE]: "assets/video/shot.01.motion/v-src.mp4",
  });
});
