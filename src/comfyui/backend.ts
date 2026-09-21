import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  GenerationBackend,
  GenerationRequest,
  WaitForCompletionResult,
  WaitOptions,
} from "../core/backend.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { requireFileWithinRoot } from "../core/path-containment.js";
import { redactErrorBody } from "../core/redact-url.js";
import type { VideoRoots } from "../core/roots.js";
import { buildTokenRedactor } from "./token-resolver.js";
import { sleep } from "../core/sleep.js";

// The outcome of installing one model / node pack via ComfyUI-Manager. `timedOut` (the waiter's
// deadline elapsed) is returned, not thrown, so the async install job can leave itself
// re-observable; the Manager keeps installing server-side regardless.
export type ComfyInstallOutcome =
  | { kind: "alreadyPresent" }
  | { kind: "installed" }
  | { kind: "cancelled" }
  | { kind: "timedOut" };
import type {
  ComfyAssetDefinition,
  ComfyModelDeclaration,
  ComfyNodeDeclaration,
  JobRecord,
} from "../core/types/index.js";
import { type ComfyUIConfig, type ComfyUITiming, resolveComfyUITiming } from "./config.js";
import { extractHistoryError, historyOutcome } from "./error-utils.js";
import { ComfyUIHttpClient } from "./http-client.js";
import { ComfyUIManagerClient, type ManagerQueueStatus } from "./manager-client.js";
import {
  ensureWritableDir,
  joinReported,
  type ModelDestination,
  resolveModelDir,
  toLocalPath,
} from "./model-destination.js";
import { downloadModelFile, type ModelDownloadProgress } from "./model-downloader.js";
import type { ComfyUIHistoryOutput, ComfyUIOutputFile } from "./types.js";
import { loadWorkflow, parameterizeWorkflow } from "./workflow.js";
import { ComfyUIWsClient } from "./ws-client.js";

// Liveness probe before a reboot: short, because the server either answers now or there is
// nothing to restart.
const REBOOT_PREFLIGHT_TIMEOUT_MS = 5_000;
// How long ComfyUI-Manager gets to start answering after the core server is back.
const MANAGER_SETTLE_MS = 60_000;

// The one class that holds both roots: its workflows come from the workspace's shared
// `adapters/comfy/`, while every file it reads or writes belongs to a single video.
export class ComfyUIBackend implements GenerationBackend {
  readonly httpClient: ComfyUIHttpClient;
  readonly wsClient: ComfyUIWsClient;
  readonly managerClient: ComfyUIManagerClient;
  readonly workspaceRoot: string;
  readonly videoRoot: string;
  private readonly config: ComfyUIConfig;
  private readonly timing: ComfyUITiming;
  private outputNodeIds = new Map<string, string>();

  constructor(config: ComfyUIConfig, roots: VideoRoots) {
    this.config = config;
    this.timing = resolveComfyUITiming(config.timing);
    this.workspaceRoot = roots.workspace;
    this.videoRoot = roots.video;
    this.httpClient = new ComfyUIHttpClient(config.baseUrl, {
      clientId: config.clientId,
      headers: config.headers,
    });
    this.wsClient = new ComfyUIWsClient(
      config.baseUrl,
      this.httpClient.clientId,
      this.timing,
      config.headers,
    );
    this.managerClient = new ComfyUIManagerClient(config.baseUrl, this.httpClient);
  }

  setOutputNodeId(backendJobId: string, nodeId: string | undefined): void {
    if (nodeId) {
      this.outputNodeIds.set(backendJobId, nodeId);
    }
  }

  async submit(request: GenerationRequest, _jobRecord: JobRecord, seed: number): Promise<string> {
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

    const promptRes = await this.httpClient.queuePrompt(parameterized);

    const comfyDef = request.assetDefinition as ComfyAssetDefinition;
    if (comfyDef.outputNodeId) {
      this.outputNodeIds.set(promptRes.prompt_id, comfyDef.outputNodeId);
    }

    return promptRes.prompt_id;
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

    const history = await this.httpClient.getHistory(backendJobId);
    if (!history) {
      throw new KonteError("COMFYUI_ERROR", "No history found for completed prompt");
    }

    if (historyOutcome(history) === "error") {
      const detail = extractHistoryError(history);
      const err = new KonteError("COMFYUI_ERROR", detail ?? "ComfyUI execution failed");
      options?.onLog?.(`Error: ${err.message}`);
      throw err;
    }

    const outputNodeId = this.outputNodeIds.get(backendJobId);

    const outputFiles = selectOutputFiles(history.outputs, outputNodeId);
    const savedFiles: string[] = [];

    for (const file of outputFiles) {
      options?.onLog?.(`Downloading: ${file.filename}`);
      // basename guards against a crafted server returning a traversal in filename.
      const outputPath = path.join(outputDir, path.basename(file.filename));
      await this.httpClient.downloadOutputToFile(file, outputPath);
      savedFiles.push(outputPath);
    }

    options?.onLog?.(`Completed (${savedFiles.length} file(s))`);
    this.outputNodeIds.delete(backendJobId);

    return {
      kind: "done",
      result: {
        files: savedFiles,
        metadata: { promptId: backendJobId },
        durationMs: Math.round(performance.now() - start),
      },
    };
  }

  // Spelled as ComfyUI spells it, which on a Windows host is a `C:\...` path this process may not
  // be able to reach. null when the server serves no folder listing, or names no directory konte
  // is willing to target — either way the Manager owns the download.
  private async reportedModelDir(decl: ComfyModelDeclaration): Promise<ModelDestination | null> {
    const folders = await this.httpClient.getModelFolders();
    return folders === null ? null : resolveModelDir(decl, folders);
  }

  /**
   * Confirm ComfyUI can see what konte just wrote, by reading back the listing of the root it
   * targeted. This is what makes the local path safe to take: "the directory was writable" says
   * nothing about whose directory it is, so a remote ComfyUI reporting a path that happens to
   * exist here (a container's `/workspace`, say) would otherwise be written to and believed.
   *
   * A listing konte cannot read at all only warns, matching how `probeModel` separates "absent"
   * from "unobservable".
   */
  private async verifyLanded(
    decl: ComfyModelDeclaration,
    dest: ModelDestination,
    log: (msg: string) => void,
  ): Promise<void> {
    // A listing that came back keeps its weight even if a later attempt cannot be made: falling
    // back to "unobservable" because attempt 3 blipped would discard the absence this check exists
    // to catch.
    let sawListing = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(500);
      const files = await this.httpClient.getModelFiles(dest.root).catch(() => null);
      if (files === null) continue;
      sawListing = true;
      if (files.includes(dest.relative)) return;
    }
    if (!sawListing) {
      log(`Could not confirm ${decl.filename} in ComfyUI's "${dest.root}" listing; continuing.`);
      return;
    }
    throw new KonteError(
      "COMFYUI_ERROR",
      `Downloaded ${decl.filename} to ${dest.dir}, but ComfyUI does not list it under ` +
        `"${dest.root}". That directory is not the one this ComfyUI reads — check that ` +
        `comfyui.url points at a server sharing this filesystem, and that the declaration's ` +
        `type/savePath are right.`,
    );
  }

  /**
   * Install a single comfy model, returning early if it is already present. Drives the
   * comfy-model-download job (see run-comfy-model-job).
   *
   * Where konte can write into ComfyUI's own model directory it fetches the file itself: that is
   * the only path that can authenticate, since ComfyUI-Manager's downloader reads no token.
   * Otherwise the download goes to the Manager, whose queue is `shouldCancel`-polled but has no
   * abort API — a cancelled install may still finish server-side, and is then simply cached.
   */
  async installModel(
    decl: ComfyModelDeclaration,
    resolvedUrl: string,
    opts?: {
      onProgress?: (status: ManagerQueueStatus) => void;
      onBytes?: (p: ModelDownloadProgress) => void;
      onLog?: (msg: string) => void;
      shouldCancel?: () => boolean | Promise<boolean>;
    },
  ): Promise<ComfyInstallOutcome> {
    const log = opts?.onLog ?? ((msg: string) => console.error(`[konte] ${msg}`));

    if (await this.managerClient.isModelAvailable(decl)) {
      return { kind: "alreadyPresent" };
    }

    const dest = await this.reportedModelDir(decl).catch(() => null);
    const localDir = dest === null ? null : toLocalPath(dest.dir);
    const localRoot = dest === null ? null : toLocalPath(dest.rootDir);
    if (
      dest !== null &&
      localDir !== null &&
      localRoot !== null &&
      (await ensureWritableDir(localDir, localRoot))
    ) {
      log(`Downloading model: ${decl.filename} (${decl.type}) into ${dest.dir}`);
      const result = await downloadModelFile({
        resolvedUrl,
        declaredUrl: decl.url,
        destPath: path.join(localDir, decl.filename),
        onLog: log,
        ...(opts?.onBytes ? { onProgress: opts.onBytes } : {}),
        ...(opts?.shouldCancel ? { shouldCancel: opts.shouldCancel } : {}),
      });
      if (result.kind === "cancelled") {
        log(`Model download cancelled: ${decl.filename}`);
        return { kind: "cancelled" };
      }
      // Leave the job non-terminal so the owner's result is what settles it.
      if (result.kind === "busy") {
        log(`Another worker is already downloading ${decl.filename}; leaving it to finish.`);
        return { kind: "timedOut" };
      }
      await this.verifyLanded(decl, dest, log);
      log(`Installed model: ${decl.filename}`);
      return { kind: "installed" };
    }
    const reportedDir = dest?.dir ?? null;

    if (!(await this.managerClient.isAvailable())) {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `Missing model: ${decl.filename}.\n` +
          `konte cannot write to this ComfyUI's model directory, and ComfyUI-Manager was not ` +
          `detected at ${this.config.baseUrl} to install it remotely.\n` +
          `Install it from: https://docs.comfy.org/ja/manager/install\n` +
          `Or set comfyui.autoInstallModels: false in konte.config.json and place the file yourself:\n` +
          manualDownloadHint(decl, reportedDir),
      );
    }

    // A previous owner of this job (a reclaim reuses the job's persisted client_id) may already
    // have queued this download. The Manager's queue is client_id scoped, so re-queueing blindly
    // races the in-flight download and can trip the strict presence check below into a false
    // failure — instead, observe the existing task to completion.
    // Names the target, and stays stable so a resumed observation finds the task a previous owner
    // queued. The filename alone collides — one adapter declares `config.json` under several
    // savePaths. The URL is never part of it: it carries the token.
    const uiId = `konte-${[decl.savePath, decl.filename].filter(Boolean).join("/")}`;
    if (await this.hasPendingManagerWork()) {
      log(
        `Resuming in-progress model install for ${decl.filename} (already queued for this client).`,
      );
    } else {
      log(`Installing model: ${decl.filename} (${decl.type}) from ${decl.url}`);
      await this.managerClient.queueInstall({ model: decl, resolvedUrl, uiId });
      await this.managerClient.startQueue();
    }
    const wait = await this.managerClient.waitForQueueCompletion({
      expectedTotal: 1,
      pollIntervalMs: this.timing.pollIntervalMs,
      onLog: log,
      onProgress: opts?.onProgress,
      shouldCancel: opts?.shouldCancel,
    });
    if (wait.kind === "cancelled") {
      log(`Model install cancelled: ${decl.filename}`);
      return { kind: "cancelled" };
    }
    if (wait.kind === "timedOut") {
      // The waiter's deadline elapsed — the download keeps running server-side; leave it
      // re-observable rather than treating it as settled.
      return { kind: "timedOut" };
    }

    // An emptied queue means the task settled — succeeded OR failed (404, expired token, a
    // security denial that never reached HTTP). What is on disk decides; the history is consulted
    // only to explain a model that did not arrive, so a stale entry cannot overturn a present one.
    // probeModel (strict) lets a transient comms failure here propagate so the install is
    // re-observed, not falsely reported as "still missing".
    const probe = await this.managerClient.probeModel(decl);
    if (probe === "present") {
      log(`Installed model: ${decl.filename}`);
      return { kind: "installed" };
    }

    const outcome = await this.managerClient.getTaskOutcome(uiId);
    if (outcome && outcome.result !== "success") {
      // The Manager echoes the resolved download URL in its failure text, `${VAR}` tokens already
      // expanded; redact it back before this reaches the job file or log.
      const redact = buildTokenRedactor([decl.url]);
      const detail = [outcome.result, outcome.errorMessage]
        .filter((part): part is string => !!part)
        .map((part) => redactErrorBody(redact(part)))
        .join(": ");
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager did not install ${decl.filename} — it reported "${detail}". ` +
          (outcome.denialHint ?? "Check ComfyUI-Manager's logs and the model URL.") +
          `\n${manualDownloadHint(decl, reportedDir)}`,
      );
    }

    if (probe === "absent") {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `Model install reported complete but ${decl.filename} is still missing from ComfyUI. ` +
          `The download likely failed (e.g. a 404, or a gated repo the Manager cannot ` +
          `authenticate for).\n${manualDownloadHint(decl, reportedDir)}`,
      );
    }
    // No listing could show this file, so its absence is not evidence of a failed download; the
    // history check above is what catches a real failure here.
    log(
      `Installed model: ${decl.filename} (unverified — ComfyUI lists no file of its kind under ` +
        `${decl.savePath ?? "the default model folder"})`,
    );
    return { kind: "installed" };
  }

  /**
   * Install a single custom node pack via ComfyUI-Manager, returning early if already present
   * on disk. Installs to disk only — it never reboots ComfyUI; loading the new node classes is
   * `activateNodes`' job (one coordinated reboot per run). `shouldCancel` is polled while
   * waiting so the job can be cancelled mid-install (the manager has no abort API, so a
   * cancelled install may still finish server-side — harmless).
   */
  async installNode(
    decl: ComfyNodeDeclaration,
    opts?: {
      onProgress?: (status: ManagerQueueStatus) => void;
      onLog?: (msg: string) => void;
      shouldCancel?: () => boolean | Promise<boolean>;
    },
  ): Promise<ComfyInstallOutcome> {
    const log = opts?.onLog ?? ((msg: string) => console.error(`[konte] ${msg}`));

    if ((await this.managerClient.filterMissingNodes([decl.id])).missing.length === 0) {
      return { kind: "alreadyPresent" };
    }

    if (!(await this.managerClient.isAvailable())) {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `Missing custom node pack: ${decl.id}.\n` +
          `ComfyUI-Manager is required to auto-install custom nodes but was not detected at ${this.config.baseUrl}.\n` +
          `Install it from: https://docs.comfy.org/ja/manager/install\n` +
          `Or set comfyui.autoInstallNodes: false in konte.config.json and install the nodes manually.`,
      );
    }

    // See installModel: a reclaim reuses the job's persisted client_id, so an already-queued
    // install must be observed, not re-queued.
    const uiId = `konte-${decl.id}`;
    if (await this.hasPendingManagerWork()) {
      log(`Resuming in-progress node install for ${decl.id} (already queued for this client).`);
    } else {
      log(`Installing custom node pack: ${decl.id}`);
      await this.managerClient.queueInstallNode({ node: decl, uiId });
      await this.managerClient.startQueue();
    }
    const wait = await this.managerClient.waitForQueueCompletion({
      expectedTotal: 1,
      pollIntervalMs: this.timing.pollIntervalMs,
      onLog: log,
      onProgress: opts?.onProgress,
      shouldCancel: opts?.shouldCancel,
    });
    if (wait.kind === "cancelled") {
      log(`Node install cancelled: ${decl.id}`);
      return { kind: "cancelled" };
    }
    if (wait.kind === "timedOut") {
      return { kind: "timedOut" };
    }

    // An emptied queue means the task settled (succeeded OR failed); see installModel for why what
    // is on disk decides. getInstalledNodeIds (strict, no fallback) lets a transient comms failure
    // here propagate so the install is re-observed, not falsely "missing".
    if ((await this.managerClient.getInstalledNodeIds("default")).has(decl.id)) {
      log(`Installed custom node pack: ${decl.id}`);
      return { kind: "installed" };
    }

    const outcome = await this.managerClient.getTaskOutcome(uiId);
    if (outcome && outcome.result !== "success") {
      const detail = [outcome.result, outcome.errorMessage]
        .filter((part): part is string => !!part)
        .map((part) => redactErrorBody(part))
        .join(": ");
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager did not install "${decl.id}" — it reported "${detail}". ` +
          (outcome.denialHint ?? unregisteredNodeHint(decl.id)),
      );
    }

    throw new KonteError(
      "COMFYUI_MANAGER_UNAVAILABLE",
      `Node install reported complete but "${decl.id}" is still missing from ComfyUI. ` +
        `Check ComfyUI-Manager's logs. ${unregisteredNodeHint(decl.id)}`,
    );
  }

  /**
   * Make newly-installed custom node packs live. Custom nodes only register after a ComfyUI
   * restart, so if any of `cnrIds` is installed-but-not-loaded this reboots ComfyUI once (when
   * autoRebootAfterNodeInstall is enabled), waits for it to come back, and verifies the packs
   * loaded. When auto-reboot is disabled, or the server does not return, it raises
   * COMFY_NODE_RESTART_REQUIRED so the caller surfaces a manual-restart instruction rather than
   * proceeding into an opaque "node not found" generation failure.
   */
  async activateNodes(
    cnrIds: readonly string[],
    opts?: { onLog?: (msg: string) => void },
  ): Promise<{ rebooted: boolean }> {
    const log = opts?.onLog ?? ((msg: string) => console.error(`[konte] ${msg}`));
    if (cnrIds.length === 0) return { rebooted: false };

    const observed = await this.managerClient.filterUnloadedNodes(cnrIds);
    // Never reboot a server konte cannot inspect: "no answer" is not "nothing is loaded", and
    // acting on the conflation restarts a ComfyUI that may be mid-boot — undoing the very restart
    // someone just performed by hand.
    if (observed.kind === "unobservable") {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `Cannot tell whether custom node pack(s) [${cnrIds.join(", ")}] are loaded: ` +
          `ComfyUI-Manager at ${this.config.baseUrl} did not answer (${observed.error}). ` +
          `Not rebooting a server konte cannot inspect — make sure ComfyUI is up with ` +
          `ComfyUI-Manager installed, then re-run the command.`,
      );
    }
    const unloaded = observed.unloaded;
    if (unloaded.length === 0) return { rebooted: false };

    if (!this.config.autoRebootAfterNodeInstall) {
      throw new KonteError(
        "COMFY_NODE_RESTART_REQUIRED",
        `Installed custom node pack(s) [${unloaded.join(", ")}] require a ComfyUI restart to load. ` +
          `Auto-reboot is disabled (comfyui.autoRebootAfterNodeInstall: false). ` +
          `Restart ComfyUI, then re-run the command.`,
      );
    }

    // A reboot request to a server that is already down is indistinguishable from a successful
    // one — both just drop the connection — so `reboot()` returns either way and the wait below
    // then burns its full window on a corpse, reporting "did not come back" about a restart that
    // never happened. Confirm the server is there to reboot, and say the true thing when it isn't.
    if (!(await this.httpClient.ping(REBOOT_PREFLIGHT_TIMEOUT_MS))) {
      throw new KonteError(
        "COMFYUI_UNAVAILABLE",
        `ComfyUI at ${this.config.baseUrl} is not responding, so there is nothing to reboot for ` +
          `[${unloaded.join(", ")}]. Start ComfyUI, then re-run the command.`,
      );
    }

    log(`Rebooting ComfyUI to load custom node(s): ${unloaded.join(", ")}`);
    await this.managerClient.reboot();
    const back = await this.managerClient.waitUntilReachable();
    if (!back) {
      throw new KonteError(
        "COMFY_NODE_RESTART_REQUIRED",
        `ComfyUI did not come back after a reboot to load [${unloaded.join(", ")}]. ` +
          `If ComfyUI is not launched under a relauncher it will not auto-restart — ` +
          `restart it manually, then re-run the command.`,
      );
    }

    // The core server answers before ComfyUI-Manager does, so give the Manager its own window to
    // start rather than reading a still-booting one as "the pack failed to import".
    const after = await this.managerClient.filterUnloadedNodes(cnrIds, {
      settleMs: MANAGER_SETTLE_MS,
    });
    if (after.kind === "unobservable") {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI restarted, but ComfyUI-Manager did not answer within ` +
          `${Math.round(MANAGER_SETTLE_MS / 1000)}s (${after.error}), so whether ` +
          `[${unloaded.join(", ")}] loaded is unknown. Check the ComfyUI log, then re-run.`,
      );
    }
    if (after.unloaded.length > 0) {
      throw new KonteError(
        "COMFY_NODE_RESTART_REQUIRED",
        `ComfyUI restarted but node pack(s) [${after.unloaded.join(", ")}] still did not load. ` +
          `Check ComfyUI-Manager logs (the pack may have failed to import).`,
      );
    }
    log(`Custom node(s) loaded after reboot: ${unloaded.join(", ")}`);
    return { rebooted: true };
  }

  // Whether the Manager's install queue already holds pending/running work for OUR client_id — a
  // task a prior owner of this job queued before we reclaimed it. Best-effort: an unobservable
  // queue (transient comms failure, non-ok) reads as "no pending work" so the caller queues
  // normally, no worse than the pre-reclaim behavior.
  private async hasPendingManagerWork(): Promise<boolean> {
    try {
      const status = await this.managerClient.getQueueStatus(this.httpClient.clientId);
      return status.total_count > 0;
    } catch {
      return false;
    }
  }

  private async prepareResolvedDependencies(
    resolvedDependencies: Record<string, string>,
  ): Promise<Record<string, string>> {
    const prepared: Record<string, string> = {};
    for (const [address, depPath] of Object.entries(resolvedDependencies)) {
      const absPath = await requireFileWithinRoot(this.videoRoot, depPath);
      const data = await fs.readFile(absPath);
      const filename = generateUploadFilename(absPath, data);
      const uploadResult = await this.httpClient.uploadImage(filename, data);
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

function collectOutputFiles(outputs: Record<string, ComfyUIHistoryOutput>): ComfyUIOutputFile[] {
  const files: ComfyUIOutputFile[] = [];
  for (const output of Object.values(outputs)) {
    if (output.images) files.push(...output.images);
    if (output.gifs) files.push(...output.gifs);
    if (output.audio) files.push(...output.audio);
  }
  return files;
}

function selectOutputFiles(
  outputs: Record<string, ComfyUIHistoryOutput>,
  outputNodeId: string | undefined,
): ComfyUIOutputFile[] {
  if (!outputNodeId) {
    return collectOutputFiles(outputs);
  }

  const nodeOutput = outputs[outputNodeId];
  if (nodeOutput) {
    const files: ComfyUIOutputFile[] = [];
    if (nodeOutput.images) files.push(...nodeOutput.images);
    if (nodeOutput.gifs) files.push(...nodeOutput.gifs);
    if (nodeOutput.audio) files.push(...nodeOutput.audio);
    if (files.length > 0) return files;
  }

  return collectOutputFiles(outputs);
}

/**
 * A copy-pasteable command that puts this model where ComfyUI reads it, for a ComfyUI whose
 * filesystem is out of reach — where a gated repo is beyond ComfyUI-Manager too.
 *
 * `curl` rather than `hf download`: it writes the exact `filename` konte declared, where
 * `hf download --local-dir` would recreate the file's repo-relative directories underneath it.
 * The URL is the declared one, `${VAR}` placeholders intact, so the line is safe to persist and
 * a `?token=${CIVITAI_TOKEN}` style URL still expands in the shell that runs it.
 *
 * The destination is single-quoted: ComfyUI supplied it over HTTP, and double quotes would still
 * run a `$(…)` inside it. The URL keeps double quotes so its placeholders expand.
 */
// A pack outside ComfyUI-Manager's registry never installs by id, and the Manager's installed
// listing keys on the `custom_nodes` directory name.
function unregisteredNodeHint(id: string): string {
  return (
    `If "${id}" is not on ComfyUI-Manager's registry it cannot be auto-installed: clone it on ` +
    `the ComfyUI host into <ComfyUI>/custom_nodes/${id}, then restart ComfyUI.`
  );
}

function manualDownloadHint(decl: ComfyModelDeclaration, reportedDir: string | null): string {
  const dest = shellSingleQuote(
    reportedDir === null
      ? `<ComfyUI>/models/<folder>/${decl.filename}`
      : joinReported(reportedDir, [decl.filename]),
  );
  const isHuggingFace = /^https:\/\/(?:[a-z0-9-]+\.)*(?:huggingface\.co|hf\.co)\//i.test(decl.url);
  const lines = ["Run this on the ComfyUI host:"];
  if (isHuggingFace) {
    lines.push(
      `  export HF_TOKEN=...   # https://huggingface.co/settings/tokens`,
      `  curl -L -H "Authorization: Bearer $HF_TOKEN" -o ${dest} "${decl.url}"`,
    );
  } else {
    lines.push(`  curl -L -o ${dest} "${decl.url}"`);
  }
  return lines.join("\n");
}

// POSIX single-quoting: everything inside is literal, and the only character needing care is the
// quote itself, which ends the run and is re-introduced escaped.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function generateUploadFilename(filePath: string, data: Buffer | Uint8Array): string {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const hash = crypto.createHash("sha256").update(data).digest("hex").slice(0, 8);
  return `konte-${base}-${hash}${ext}`;
}
