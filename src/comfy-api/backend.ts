import * as path from "node:path";
import { loadWorkflow, parameterizeWorkflow } from "../comfyui/workflow.js";
import type {
  GenerationBackend,
  GenerationRequest,
  WaitForCompletionResult,
  WaitOptions,
} from "../core/backend.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { TransientHttpError } from "../core/http-retry.js";
import { requireFileWithinRoot } from "../core/path-containment.js";
import { pollUntilTerminal } from "../core/poll-until-terminal.js";
import type { VideoRoots } from "../core/roots.js";
import { sleep } from "../core/sleep.js";
import type { ComfyAssetDefinition, ComfyTarget, JobRecord } from "../core/types/index.js";
import { loadDeploymentState } from "./deploy-state.js";
import { usableDeployment } from "./deployment.js";
import { ComfyApiHttpError, COMFY_CLOUD_ORIGIN } from "./http.js";
import { ComfyPlatformClient } from "./platform-client.js";
import { comfyApiKey, COMFY_API_KEY_ENV, deploymentNameOf } from "./routing.js";
import {
  type ComfyApiJob,
  type ComfyApiJobError,
  type ComfyApiOutput,
  ComfyApiRuntimeClient,
} from "./runtime-client.js";
import { missingCredentialMessage } from "../core/credentials.js";

// A deployment answers 429 while it warms up or its queue is full; the key is released, so the
// same submission is sent again.
const SUBMIT_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const SUBMIT_RETRY_WINDOW_MS = 15 * 60_000;
// How far back a deployment's job list is read to find a submission whose answer was lost.
const RECOVERY_LIST_LIMIT = 100;
const MEDIA_OUTPUT_TYPES = new Set(["image", "video", "audio"]);

/** Where a submitted job runs: Comfy Cloud, or one deployment by id. */
export type ComfyApiSite = { target: ComfyTarget; deploymentId: string | null };

/** `<target>|<jobId>` on Cloud, `<target>|<deploymentId>|<jobId>` on a deployment. */
export function encodeComfyApiJobId(site: ComfyApiSite, jobId: string): string {
  return site.deploymentId === null
    ? `${site.target}|${jobId}`
    : `${site.target}|${site.deploymentId}|${jobId}`;
}

export function decodeComfyApiJobId(backendJobId: string): ComfyApiSite & { jobId: string } {
  const parts = backendJobId.split("|");
  if (parts.length === 2) {
    return { target: parts[0] as ComfyTarget, deploymentId: null, jobId: parts[1]! };
  }
  if (parts.length === 3) {
    return { target: parts[0] as ComfyTarget, deploymentId: parts[1]!, jobId: parts[2]! };
  }
  throw new KonteError("COMFY_API_ERROR", `Invalid Comfy API backend job id: ${backendJobId}`);
}

function requireKey(): string {
  const key = comfyApiKey();
  if (key === null) {
    throw new KonteError("BACKEND_NOT_CONFIGURED", missingCredentialMessage(COMFY_API_KEY_ENV));
  }
  return key;
}

/**
 * A comfy asset on Comfy Cloud or a Comfy API deployment, through the v2 runtime API both serve.
 * The adapter and its workflow are the same ones a ComfyUI runs; inputs travel as `core/ASSET`
 * references.
 */
export class ComfyApiBackend implements GenerationBackend {
  private readonly roots: VideoRoots;
  private readonly outputNodeIds = new Map<string, string>();
  private readonly endpoints = new Map<string, string>();
  private readonly clientFactory: (
    endpoint: string,
    surface: "cloud" | "deployment",
  ) => ComfyApiRuntimeClient;
  private readonly platformFactory: () => ComfyPlatformClient;

  constructor(
    roots: VideoRoots,
    opts: {
      clientFactory?: (endpoint: string, surface: "cloud" | "deployment") => ComfyApiRuntimeClient;
      platformFactory?: () => ComfyPlatformClient;
    } = {},
  ) {
    this.roots = roots;
    this.clientFactory =
      opts.clientFactory ??
      ((endpoint, surface) => new ComfyApiRuntimeClient(endpoint, requireKey(), surface));
    this.platformFactory = opts.platformFactory ?? (() => new ComfyPlatformClient(requireKey()));
  }

  setOutputNodeId(backendJobId: string, nodeId: string | undefined): void {
    if (nodeId) this.outputNodeIds.set(backendJobId, nodeId);
  }

  // Where an observer reads a job: Cloud, or the endpoint of the deployment it was sent to.
  private async clientFor(site: ComfyApiSite): Promise<ComfyApiRuntimeClient> {
    if (site.deploymentId === null) return this.clientFactory(COMFY_CLOUD_ORIGIN, "cloud");
    let endpoint = this.endpoints.get(site.deploymentId);
    if (!endpoint) {
      const deployment = await this.platformFactory().getDeployment(site.deploymentId);
      if (!deployment?.endpointUrl) {
        throw new KonteError(
          "COMFY_API_ERROR",
          `Comfy API deployment ${site.deploymentId} is gone; the job sent to it is lost with it`,
        );
      }
      endpoint = deployment.endpointUrl;
      this.endpoints.set(site.deploymentId, endpoint);
    }
    return this.clientFactory(endpoint, "deployment");
  }

  async submit(request: GenerationRequest, jobRecord: JobRecord, seed: number): Promise<string> {
    const def = request.assetDefinition;
    if (def.kind !== "comfy") {
      throw new KonteError("INVALID_ASSET_TYPE", `Expected comfy asset, got "${def.kind}"`);
    }
    const target =
      jobRecord.kind === "generation" ? (jobRecord.comfyTarget as ComfyTarget | null) : null;
    if (target === null || target === "comfyui") {
      throw new KonteError(
        "COMFY_API_ERROR",
        `Job ${jobRecord.id} carries no Comfy API target; re-run generate to route it`,
      );
    }
    const log = request.onLog ?? (() => {});
    const name = deploymentNameOf(target);
    const deploymentId =
      name === null ? null : (request.submissionSite ?? (await this.deploymentFor(name)).id);
    const site: ComfyApiSite = { target, deploymentId };
    const client = await this.clientFor(site);
    const jobId = await this.submitTo(client, request, seed, log);
    const backendJobId = encodeComfyApiJobId(site, jobId);
    this.setOutputNodeId(backendJobId, def.outputNodeId);
    return backendJobId;
  }

  // The deployment a job on one goes to, recorded before it is sent.
  async chooseSubmissionSite(
    _request: GenerationRequest,
    jobRecord: JobRecord,
  ): Promise<string | null> {
    const target =
      jobRecord.kind === "generation" ? (jobRecord.comfyTarget as ComfyTarget | null) : null;
    const name = target === null ? null : deploymentNameOf(target);
    if (name === null) return null;
    const deployment = await this.deploymentFor(name);
    this.endpoints.set(deployment.id, deployment.endpointUrl);
    return deployment.id;
  }

  // The ready deployment of the release `konte adapter comfy build` last cut for this name.
  private async deploymentFor(name: string): Promise<{ id: string; endpointUrl: string }> {
    const { releaseId } = await loadDeploymentState(this.roots.workspace, name);
    const deployment = releaseId
      ? usableDeployment(await this.platformFactory().listDeployments(), releaseId)
      : null;
    if (!deployment?.endpointUrl) {
      throw new KonteError(
        "COMFY_API_DEPLOYMENT_NOT_READY",
        `Comfy API deployment ${name} has no ready deployment of its release. Run ` +
          `\`konte adapter comfy build ${name}\`, deploy the Build on the page it opens, then generate again.`,
      );
    }
    return { id: deployment.id, endpointUrl: deployment.endpointUrl };
  }

  private async submitTo(
    client: ComfyApiRuntimeClient,
    request: GenerationRequest,
    seed: number,
    log: (line: string) => void,
  ): Promise<string> {
    const def = request.assetDefinition as ComfyAssetDefinition;
    await assertNotCancelled(request);
    const workflow = await loadWorkflow(
      path.join(this.roots.workspace, "adapters", "comfy", def.workflow),
    );
    const assets: Record<string, unknown> = {};
    for (const [address, depPath] of Object.entries(request.resolvedDependencies ?? {})) {
      const absPath = await requireFileWithinRoot(this.roots.video, depPath);
      const id = await client.uploadInput(absPath);
      assets[address] = {
        __type: "core/ASSET",
        info: { id, file_path: path.basename(absPath) },
      };
    }
    const graph = parameterizeWorkflow(
      workflow,
      def.inputs,
      seed,
      assets,
      def.prunedNodes,
      def.prunedPassThroughs,
    );
    return (
      await this.submitWithRecovery(client, graph, request.variantId, log, () =>
        assertNotCancelled(request),
      )
    ).id;
  }

  private async submitWithRecovery(
    client: ComfyApiRuntimeClient,
    graph: Record<string, unknown>,
    idempotencyKey: string,
    log: (line: string) => void,
    // Asked before every send: uploads and a 429 backoff can outlast a `job cancel`.
    notCancelled: () => Promise<void>,
  ): Promise<ComfyApiJob> {
    const giveUpAt = Date.now() + SUBMIT_RETRY_WINDOW_MS;
    for (let attempt = 0; ; attempt++) {
      await notCancelled();
      try {
        return await client.submitJob(graph, idempotencyKey);
      } catch (err) {
        if (err instanceof TransientHttpError && err.status === 429 && Date.now() < giveUpAt) {
          const wait = SUBMIT_BACKOFF_MS[Math.min(attempt, SUBMIT_BACKOFF_MS.length - 1)]!;
          log(`Comfy API is not taking jobs yet (${err.message}); retrying in ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
        const reused =
          err instanceof ComfyApiHttpError && err.serverCode === "idempotency_key_reuse";
        const unknown = err instanceof TransientHttpError;
        if (!reused && !unknown) throw err;
        const found = await this.findSubmitted(client, idempotencyKey);
        if (found) {
          log(`Recovered submission ${found.id} by its Idempotency-Key`);
          return found;
        }
        throw new KonteError(
          "SUBMISSION_UNCONFIRMED",
          `The Comfy API submission's outcome is unknown (${errorMessage(err)}). It may already be ` +
            `running; ${client.surface === "cloud" ? "Comfy Cloud cannot be searched by key, so " : ""}` +
            `automatic resubmission stopped. Check the jobs on ${client.origin} before rerolling.`,
        );
      }
    }
  }

  // Only a deployment lists its jobs with their keys; Cloud answers 405.
  private async findSubmitted(
    client: ComfyApiRuntimeClient,
    idempotencyKey: string,
  ): Promise<ComfyApiJob | null> {
    if (client.surface !== "deployment") return null;
    try {
      const jobs = await client.listJobs(RECOVERY_LIST_LIMIT);
      return jobs.find((j) => j.idempotency_key === idempotencyKey) ?? null;
    } catch {
      return null;
    }
  }

  async waitForCompletion(
    backendJobId: string,
    outputDir: string,
    options?: WaitOptions,
  ): Promise<WaitForCompletionResult> {
    const startMark = performance.now();
    const { jobId, ...site } = decodeComfyApiJobId(backendJobId);
    const { target } = site;
    const log = options?.onLog ?? (() => {});
    const client = await this.clientFor(site);

    let started = false;
    const poll = await pollUntilTerminal(
      async () => {
        const job = await client.getJob(jobId);
        if (!started && job.status === "running" && job.started_at) {
          started = true;
          options?.onExecutionStarted?.();
        }
        if (job.status === "succeeded") return { state: "done" as const, result: job };
        if (job.status === "failed" || job.status === "canceled" || job.status === "expired") {
          throw await this.failure(client, job, log);
        }
        const progress = job.progress
          ? {
              value: Math.round(job.progress.value * 100),
              max: 100,
              ...(job.progress.current_node_class ? { node: job.progress.current_node_class } : {}),
            }
          : undefined;
        return { state: "pending" as const, progress };
      },
      {
        deadline: options?.timeoutMs ? Date.now() + options.timeoutMs : undefined,
        unconfirmedThresholdMs: options?.unconfirmedThresholdMs,
        onProgress: options?.onProgress,
        onLog: log,
        onUnconfirmedChange: options?.onUnconfirmedChange,
        label: `job ${jobId}`,
      },
    );
    if (poll.kind !== "done") return { kind: "timedOut" };

    const outputs = selectOutputs(poll.value.outputs, this.outputNodeIds.get(backendJobId));
    if (outputs.length === 0) {
      throw new KonteError("COMFY_API_ERROR", `Comfy API job ${jobId} succeeded with no output`);
    }
    const files: string[] = [];
    for (const output of outputs) {
      const base = path.basename(output.name || output.id);
      let outputPath = path.join(outputDir, base);
      for (let n = 1; files.includes(outputPath); n++) {
        outputPath = path.join(outputDir, `${n}-${base}`);
      }
      log(`Downloading: ${base}`);
      await client.downloadOutput(output, outputPath);
      files.push(outputPath);
    }
    log(`Completed (${files.length} file(s))`);
    this.outputNodeIds.delete(backendJobId);
    return {
      kind: "done",
      result: {
        files,
        metadata: { comfyApiJobId: jobId, comfyTarget: target },
        durationMs: Math.round(performance.now() - startMark),
      },
    };
  }

  // The job's failure, naming what ComfyUI refused; on a deployment what the run printed goes to
  // the job log first.
  private async failure(
    client: ComfyApiRuntimeClient,
    job: ComfyApiJob,
    log: (line: string) => void,
  ): Promise<KonteError> {
    if (client.surface === "deployment") {
      const text = await client.getLogs(job.id).catch(() => null);
      if (text) {
        log("--- Comfy API execution log ---");
        for (const line of text.split("\n")) log(line);
        log("--- end of execution log ---");
      }
    }
    const detail = describeJobError(job.error ?? null);
    const err = new KonteError(
      "COMFY_API_ERROR",
      `Comfy API job ${job.id} ${job.status}${detail ? `: ${detail}` : ""}`,
    );
    log(`Error: ${err.message}`);
    return err;
  }

  async cancel(backendJobId: string): Promise<void> {
    const { jobId, ...site } = decodeComfyApiJobId(backendJobId);
    const client = await this.clientFor(site);
    await client.cancelJob(jobId);
  }
}

// A job cancelled while its submit was still being prepared: nothing is sent.
async function assertNotCancelled(request: GenerationRequest): Promise<void> {
  if (await request.shouldCancel?.()) {
    throw new KonteError(
      "COMFY_API_SUBMIT_CANCELLED",
      `Job ${request.variantId} was cancelled before it was sent`,
    );
  }
}

export function describeJobError(error: ComfyApiJobError | null): string {
  if (!error) return "";
  const nodes = Object.entries(error.node_errors ?? {}).map(([nodeId, node]) => {
    const reasons = node.errors
      .map((e) => (e.details ? `${e.message} (${e.details})` : e.message))
      .join("; ");
    return `node ${nodeId}${node.class_type ? ` ${node.class_type}` : ""}: ${reasons}`;
  });
  if (nodes.length > 0) return nodes.join(" | ");
  const where = error.node_id
    ? ` at node ${error.node_id}${error.class_type ? ` ${error.class_type}` : ""}`
    : "";
  return `${error.message}${where}`;
}

// The adapter's output node when it names one; otherwise every media output. A deployment also
// lists nodes that only preview an input.
function selectOutputs(
  outputs: readonly ComfyApiOutput[],
  nodeId: string | undefined,
): ComfyApiOutput[] {
  if (nodeId) {
    const own = outputs.filter((o) => o.node_id === nodeId);
    if (own.length > 0) return own;
  }
  return outputs.filter((o) => MEDIA_OUTPUT_TYPES.has(o.type));
}
