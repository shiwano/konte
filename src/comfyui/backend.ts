import { openAsBlob } from "node:fs";
import * as path from "node:path";
import type {
  GenerationBackend,
  GenerationRequest,
  SubmitResult,
  WaitForCompletionResult,
  WaitOptions,
} from "../core/backend.js";
import { uniqueOutputPath } from "../backends/http-util.js";
import { assertSubmitNotCancelled } from "../core/backend.js";
import { hashFile } from "../core/content-hash.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { requireFileWithinRoot } from "../core/path-containment.js";
import { observeOrTransient } from "../core/poll-until-terminal.js";
import type { VideoRoots } from "../core/roots.js";
import type { JobRecord } from "../core/types/index.js";
import { type ComfyUIConfig, resolveComfyUITiming } from "./config.js";
import { historyFailure, historyOutcome, UNOBSERVABLE } from "./error-utils.js";
import { ComfyUIHttpClient } from "./http-client.js";
import type { ComfyUIHistoryOutput, ComfyUIOutputFile } from "./types.js";
import { loadWorkflow, parameterizeWorkflow } from "./workflow.js";
import { ComfyUIWsClient } from "./ws-client.js";

// The one class that holds both roots: its workflows come from the workspace's shared
// `adapters/comfy/`, while every file it reads or writes belongs to a single video.
export class ComfyUIBackend implements GenerationBackend {
  readonly httpClient: ComfyUIHttpClient;
  readonly wsClient: ComfyUIWsClient;
  readonly workspaceRoot: string;
  readonly videoRoot: string;
  private readonly config: ComfyUIConfig;

  constructor(config: ComfyUIConfig, roots: VideoRoots) {
    this.config = config;
    this.workspaceRoot = roots.workspace;
    this.videoRoot = roots.video;
    this.httpClient = new ComfyUIHttpClient(config.baseUrl, {
      clientId: config.clientId,
      headers: config.headers,
    });
    this.wsClient = new ComfyUIWsClient(
      config.baseUrl,
      this.httpClient.clientId,
      resolveComfyUITiming(config.timing),
      config.headers,
    );
  }

  async submit(
    request: GenerationRequest,
    _jobRecord: JobRecord,
    seed: number,
  ): Promise<SubmitResult> {
    if (request.assetDefinition.kind !== "comfy") {
      throw new KonteError(
        "INVALID_ASSET_TYPE",
        `Expected comfy asset, got "${request.assetDefinition.kind}"`,
      );
    }

    const workflowPath = path.join(
      this.workspaceRoot,
      "adapters",
      "comfy",
      request.assetDefinition.workflow,
    );
    const workflow = await loadWorkflow(workflowPath);

    // Models are guaranteed available by the comfy-model-download jobs this job
    // depends on (see pending-jobs / generate), so submit() no longer installs
    // anything — it just queues the prompt and returns fast.
    const preparedDeps = await this.prepareResolvedDependencies(request.resolvedDependencies ?? {});
    const parameterized = parameterizeWorkflow(
      workflow,
      request.assetDefinition.inputs,
      seed,
      preparedDeps,
      request.assetDefinition.prunedNodes,
      request.assetDefinition.prunedPassThroughs,
    );

    await assertSubmitNotCancelled(request);
    const promptRes = await this.httpClient.queuePrompt(parameterized);

    // ComfyUI queues a prompt with some outputs failing validation, minus those outputs.
    const rejected = this.httpClient.describePromptErrors({ node_errors: promptRes.node_errors });
    if (rejected) {
      const id = promptRes.prompt_id;
      const stopped = await this.cancel(id).then(
        () => "konte cancelled it",
        (err: unknown) => `konte could not cancel it (${errorMessage(err)}), so it may still run`,
      );
      throw new KonteError(
        "COMFYUI_ERROR",
        `ComfyUI queued prompt ${id} without the outputs of the nodes it rejected, and ${stopped} ` +
          `— fix the nodes ComfyUI names`,
        rejected,
      );
    }

    // Progress events reach only the websocket of the client that queued the prompt.
    return {
      backendJobId: promptRes.prompt_id,
      metadata: { comfyClientId: this.httpClient.clientId },
    };
  }

  async waitForCompletion(
    backendJobId: string,
    outputDir: string,
    options?: WaitOptions,
  ): Promise<WaitForCompletionResult> {
    const start = performance.now();

    let waitOutcome: { kind: "done" } | { kind: "timedOut" };
    try {
      waitOutcome = await this.wsClient.waitForPrompt(backendJobId, {
        onProgress: (progress) => {
          options?.onProgress?.(progress);
          if (progress.node) {
            options?.onLog?.(`Executing node: ${progress.node}`);
          }
        },
        onExecutionStarted: options?.onExecutionStarted,
        onLog: options?.onLog,
        timeoutMs: options?.timeoutMs,
        unconfirmedThresholdMs: options?.unconfirmedThresholdMs,
        unreachableTimeoutMs: this.config.unreachableTimeoutMs,
        onUnconfirmedChange: options?.onUnconfirmedChange,
      });
    } catch (err) {
      options?.onLog?.(`Error: ${errorMessage(err)}`);
      throw err;
    } finally {
      this.wsClient.disconnect();
    }
    // The waiter's deadline elapsed — leave the prompt re-observable, don't fetch/commit.
    if (waitOutcome.kind === "timedOut") return { kind: "timedOut" };

    // Reads of a finished prompt repeat safely; a ComfyUI too long silent ends at the next wait.
    const history = await observeOrTransient(UNOBSERVABLE, () =>
      this.httpClient.getHistory(backendJobId),
    );
    if (!history) {
      throw new KonteError("COMFYUI_ERROR", "No history found for completed prompt");
    }

    if (historyOutcome(history) === "error") {
      const err = historyFailure(history);
      options?.onLog?.(`Error: ${err.message}`);
      throw err;
    }

    const outputFiles = selectOutputFiles(history.outputs, options?.outputNodeId);
    if (outputFiles.length === 0) {
      throw new KonteError(
        "COMFYUI_ERROR",
        `ComfyUI prompt ${backendJobId} succeeded with no output`,
      );
    }
    const savedFiles: string[] = [];

    for (const file of outputFiles) {
      options?.onLog?.(`Downloading: ${file.filename}`);
      const outputPath = uniqueOutputPath(outputDir, file.filename, savedFiles);
      await observeOrTransient(UNOBSERVABLE, () =>
        this.httpClient.downloadOutputToFile(file, outputPath),
      );
      savedFiles.push(outputPath);
    }

    options?.onLog?.(`Completed (${savedFiles.length} file(s))`);

    return {
      kind: "done",
      result: {
        files: savedFiles,
        metadata: { promptId: backendJobId },
        durationMs: Math.round(performance.now() - start),
      },
    };
  }

  private async prepareResolvedDependencies(
    resolvedDependencies: Record<string, string>,
  ): Promise<Record<string, string>> {
    const prepared: Record<string, string> = {};
    for (const [address, depPath] of Object.entries(resolvedDependencies)) {
      const absPath = await requireFileWithinRoot(this.videoRoot, depPath);
      const filename = generateUploadFilename(absPath, await hashFile(absPath));
      const uploadResult = await this.httpClient.uploadImage(filename, await openAsBlob(absPath));
      prepared[address] = uploadResult.subfolder
        ? `${uploadResult.subfolder}/${uploadResult.name}`
        : uploadResult.name;
    }
    return prepared;
  }

  async cancel(jobId: string): Promise<void> {
    const queue = await this.httpClient.getQueue();
    const isRunning = queue.queue_running.some((item) => Array.isArray(item) && item[1] === jobId);
    const isPending = queue.queue_pending.some((item) => Array.isArray(item) && item[1] === jobId);

    if (isRunning) {
      // ComfyUI's /interrupt is global — it stops whatever is executing right now, not a named
      // prompt. Re-read the queue immediately before firing and only interrupt if OUR prompt is
      // still the running one, so a prompt that finished and handed the GPU to an unrelated job
      // in the gap isn't killed. This narrows the race but can't close it: ComfyUI exposes no
      // per-prompt interrupt.
      const fresh = await this.httpClient.getQueue();
      const stillRunning = fresh.queue_running.some(
        (item) => Array.isArray(item) && item[1] === jobId,
      );
      if (stillRunning) await this.httpClient.interrupt();
    } else if (isPending) {
      await this.httpClient.deleteQueueItems([jobId]);
    } else {
      const history = await this.httpClient.getHistory(jobId);
      if (!history) {
        throw new KonteError("JOB_NOT_FOUND", `Job "${jobId}" not found in queue or history`);
      }
    }
  }
}

function nodeOutputFiles(output: ComfyUIHistoryOutput): ComfyUIOutputFile[] {
  return [...(output.images ?? []), ...(output.gifs ?? []), ...(output.audio ?? [])];
}

// A preview node's `temp` file is taken only from a workflow that saves nothing.
function collectOutputFiles(outputs: Record<string, ComfyUIHistoryOutput>): ComfyUIOutputFile[] {
  const files = Object.values(outputs).flatMap(nodeOutputFiles);
  const saved = files.filter((f) => f.type === "output");
  return saved.length > 0 ? saved : files;
}

function selectOutputFiles(
  outputs: Record<string, ComfyUIHistoryOutput>,
  outputNodeId: string | undefined,
): ComfyUIOutputFile[] {
  const nodeOutput = outputNodeId ? outputs[outputNodeId] : undefined;
  const own = nodeOutput ? nodeOutputFiles(nodeOutput) : [];
  return own.length > 0 ? own : collectOutputFiles(outputs);
}

function generateUploadFilename(filePath: string, contentHash: string): string {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return `konte-${base}-${contentHash.slice(0, 8)}${ext}`;
}
