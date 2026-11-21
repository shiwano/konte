import * as path from "node:path";
import { KonteError } from "../core/errors.js";
import { observeOrTransient } from "../core/poll-until-terminal.js";
import { sleep } from "../core/sleep.js";
import type { ComfyModelDeclaration, ComfyNodeDeclaration } from "../core/types/index.js";
import { type ComfyUIConfig, resolveComfyUITiming } from "./config.js";
import { UNOBSERVABLE } from "./error-utils.js";
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

// Liveness probe before a reboot: short, because the server either answers now or there is
// nothing to restart.
const REBOOT_PREFLIGHT_TIMEOUT_MS = 5_000;
// How long ComfyUI-Manager gets to start answering after the core server is back.
const MANAGER_SETTLE_MS = 60_000;

// The outcome of installing one model / node pack via ComfyUI-Manager. `timedOut` (the waiter's
// deadline elapsed) is returned, not thrown, so the async install job can leave itself
// re-observable; the Manager keeps installing server-side regardless.
export type ComfyInstallOutcome =
  | { kind: "alreadyPresent" }
  | { kind: "installed" }
  | { kind: "cancelled" }
  | { kind: "timedOut" };

type InstallOpts = {
  onProgress?: (status: ManagerQueueStatus) => void;
  onLog?: (msg: string) => void;
  shouldCancel?: () => boolean | Promise<boolean>;
};

function logOf(opts: { onLog?: (msg: string) => void } | undefined): (msg: string) => void {
  return opts?.onLog ?? ((msg: string) => console.error(`[konte] ${msg}`));
}

// Installs models and custom node packs into a ComfyUI, and reboots it to load new packs.
export class ComfyProvisioner {
  readonly httpClient: ComfyUIHttpClient;
  readonly managerClient: ComfyUIManagerClient;
  private readonly baseUrl: string;
  private readonly autoRebootAfterNodeInstall: boolean;
  private readonly pollIntervalMs: number;

  constructor(config: ComfyUIConfig) {
    this.baseUrl = config.baseUrl;
    this.autoRebootAfterNodeInstall = config.autoRebootAfterNodeInstall;
    this.pollIntervalMs = resolveComfyUITiming(config.timing).pollIntervalMs;
    this.httpClient = new ComfyUIHttpClient(config.baseUrl, {
      clientId: config.clientId,
      headers: config.headers,
    });
    this.managerClient = new ComfyUIManagerClient(config.baseUrl, this.httpClient);
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
        `comfy.comfyui.url points at a server sharing this filesystem, and that the declaration's ` +
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
    opts?: InstallOpts & { onBytes?: (p: ModelDownloadProgress) => void },
  ): Promise<ComfyInstallOutcome> {
    const log = logOf(opts);

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

    // Names the target, and stays stable so a resumed observation finds the task a previous owner
    // queued. The filename alone collides — one adapter declares `config.json` under several
    // savePaths. The URL is never part of it: it carries the token.
    const uiId = `konte-${[decl.savePath, decl.filename].filter(Boolean).join("/")}`;
    const wait = await this.queueManagerInstall(
      {
        uiId,
        noun: "Model",
        label: decl.filename,
        queueLine: `Installing model: ${decl.filename} (${decl.type}) from ${decl.url}`,
        queue: () => this.managerClient.queueInstall({ model: decl, resolvedUrl, uiId }),
        unavailable: () =>
          new KonteError(
            "COMFYUI_MANAGER_UNAVAILABLE",
            `Missing model: ${decl.filename}. konte cannot write to this ComfyUI's model directory, ` +
              `and ComfyUI-Manager was not detected at ${this.baseUrl} to install it remotely — ` +
              "install it from https://docs.comfy.org/ja/manager/install, or set " +
              "comfy.comfyui.autoInstallModels: false in konte.config.json and run this on the ComfyUI host",
            manualDownloadCommands(decl, reportedDir),
          ),
      },
      log,
      opts,
    );
    if (wait !== null) return wait;

    // An emptied queue means the task settled — succeeded OR failed (404, expired token, a
    // security denial that never reached HTTP). What is on disk decides; the history is consulted
    // only to explain a model that did not arrive, so a stale entry cannot overturn a present one.
    // probeModel (strict) lets a transient comms failure here propagate so the install is
    // re-observed, not falsely reported as "still missing".
    const probe = await observeOrTransient(UNOBSERVABLE, () => this.managerClient.probeModel(decl));
    if (probe === "present") {
      log(`Installed model: ${decl.filename}`);
      return { kind: "installed" };
    }

    // The Manager echoes the resolved download URL in its failure text, `${VAR}` tokens already
    // expanded; redact it back before this reaches the job file or log.
    const failure = await this.managerFailure(uiId, [decl.url]);
    if (failure) {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager did not install ${decl.filename} — it reported "${failure.detail}". ` +
          (failure.denialHint ?? "Check ComfyUI-Manager's logs and the model URL.") +
          " Or run this on the ComfyUI host",
        manualDownloadCommands(decl, reportedDir),
      );
    }

    if (probe === "absent") {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `Model install reported complete but ${decl.filename} is still missing from ComfyUI. ` +
          `The download likely failed (e.g. a 404, or a gated repo the Manager cannot ` +
          "authenticate for) — run this on the ComfyUI host",
        manualDownloadCommands(decl, reportedDir),
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
  async installNode(decl: ComfyNodeDeclaration, opts?: InstallOpts): Promise<ComfyInstallOutcome> {
    const log = logOf(opts);

    if ((await this.managerClient.filterMissingNodes([decl.id])).missing.length === 0) {
      return { kind: "alreadyPresent" };
    }

    const uiId = `konte-${decl.id}`;
    const wait = await this.queueManagerInstall(
      {
        uiId,
        noun: "Node",
        label: decl.id,
        queueLine: `Installing custom node pack: ${decl.id}`,
        queue: () => this.managerClient.queueInstallNode({ node: decl, uiId }),
        unavailable: () =>
          new KonteError(
            "COMFYUI_MANAGER_UNAVAILABLE",
            `Missing custom node pack: ${decl.id}. ComfyUI-Manager is required to auto-install custom ` +
              `nodes but was not detected at ${this.baseUrl} — install it from ` +
              "https://docs.comfy.org/ja/manager/install, or set comfy.comfyui.autoInstallNodes: false in " +
              "konte.config.json and install the nodes manually.",
          ),
      },
      log,
      opts,
    );
    if (wait !== null) return wait;

    // An emptied queue means the task settled (succeeded OR failed); see installModel for why what
    // is on disk decides. getInstalledNodeIds (strict, no fallback) lets a transient comms failure
    // here propagate so the install is re-observed, not falsely "missing".
    if ((await this.managerClient.getInstalledNodeIds("default")).has(decl.id)) {
      log(`Installed custom node pack: ${decl.id}`);
      return { kind: "installed" };
    }

    const failure = await this.managerFailure(uiId);
    if (failure) {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager did not install "${decl.id}" — it reported "${failure.detail}". ` +
          (failure.denialHint ?? unregisteredNodeHint(decl.id)),
      );
    }

    throw new KonteError(
      "COMFYUI_MANAGER_UNAVAILABLE",
      `Node install reported complete but "${decl.id}" is still missing from ComfyUI. ` +
        `Check ComfyUI-Manager's logs. ${unregisteredNodeHint(decl.id)}`,
    );
  }

  /**
   * Queue one install on ComfyUI-Manager and wait for its queue to empty. null once the queue has
   * emptied; the outcome itself when the wait was cancelled or timed out — the waiter's deadline
   * elapsing leaves the install running server-side, re-observable.
   *
   * A previous owner of this job (a reclaim reuses the job's persisted client_id) may already have
   * queued this install. The Manager's queue is client_id scoped, so re-queueing blindly races the
   * in-flight task and can trip the caller's strict presence check into a false failure — instead,
   * observe the existing task to completion.
   */
  private async queueManagerInstall(
    task: {
      uiId: string;
      noun: "Model" | "Node";
      label: string;
      queueLine: string;
      queue: () => Promise<void>;
      unavailable: () => KonteError;
    },
    log: (msg: string) => void,
    opts: InstallOpts | undefined,
  ): Promise<{ kind: "cancelled" } | { kind: "timedOut" } | null> {
    if (!(await this.managerClient.isAvailable())) throw task.unavailable();

    if (await this.hasPendingManagerWork()) {
      log(
        `Resuming in-progress ${task.noun.toLowerCase()} install for ${task.label} ` +
          `(already queued for this client).`,
      );
    } else {
      log(task.queueLine);
      await task.queue();
      await this.managerClient.startQueue();
    }
    const wait = await this.managerClient.waitForQueueCompletion({
      expectedTotal: 1,
      pollIntervalMs: this.pollIntervalMs,
      onLog: log,
      onProgress: opts?.onProgress,
      shouldCancel: opts?.shouldCancel,
    });
    if (wait.kind === "cancelled") {
      log(`${task.noun} install cancelled: ${task.label}`);
      return { kind: "cancelled" };
    }
    if (wait.kind === "timedOut") return { kind: "timedOut" };
    return null;
  }

  // The failure the Manager recorded for `uiId`, redacted; null when it recorded none.
  private async managerFailure(
    uiId: string,
    extraTemplates?: readonly string[],
  ): Promise<{ detail: string; denialHint: string | undefined } | null> {
    const outcome = await this.managerClient.getTaskOutcome(uiId);
    if (!outcome || outcome.result === "success") return null;
    const detail = [outcome.result, outcome.errorMessage]
      .filter((part): part is string => !!part)
      .map((part) => this.httpClient.redactBody(part, extraTemplates))
      .join(": ");
    return { detail, denialHint: outcome.denialHint };
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
    const log = logOf(opts);
    if (cnrIds.length === 0) return { rebooted: false };

    const observed = await this.managerClient.filterUnloadedNodes(cnrIds);
    // Never reboot a server konte cannot inspect: "no answer" is not "nothing is loaded", and
    // acting on the conflation restarts a ComfyUI that may be mid-boot — undoing the very restart
    // someone just performed by hand.
    if (observed.kind === "unobservable") {
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `Cannot tell whether custom node pack(s) [${cnrIds.join(", ")}] are loaded: ` +
          `ComfyUI-Manager at ${this.baseUrl} did not answer (${observed.error}). ` +
          `Not rebooting a server konte cannot inspect — make sure ComfyUI is up with ` +
          `ComfyUI-Manager installed, then re-run the command.`,
      );
    }
    const unloaded = observed.unloaded;
    if (unloaded.length === 0) return { rebooted: false };

    if (!this.autoRebootAfterNodeInstall) {
      throw new KonteError(
        "COMFY_NODE_RESTART_REQUIRED",
        `Installed custom node pack(s) [${unloaded.join(", ")}] require a ComfyUI restart to load. ` +
          `Auto-reboot is disabled (comfy.comfyui.autoRebootAfterNodeInstall: false). ` +
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
        `ComfyUI at ${this.baseUrl} is not responding, so there is nothing to reboot for ` +
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
}

// A pack outside ComfyUI-Manager's registry never installs by id, and the Manager's installed
// listing keys on the `custom_nodes` directory name.
function unregisteredNodeHint(id: string): string {
  return (
    `If "${id}" is not on ComfyUI-Manager's registry it cannot be auto-installed: clone it on ` +
    `the ComfyUI host into <ComfyUI>/custom_nodes/${id}, then restart ComfyUI.`
  );
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
function manualDownloadCommands(decl: ComfyModelDeclaration, reportedDir: string | null): string[] {
  const dest = shellSingleQuote(
    reportedDir === null
      ? `<ComfyUI>/models/<folder>/${decl.filename}`
      : joinReported(reportedDir, [decl.filename]),
  );
  const isHuggingFace = /^https:\/\/(?:[a-z0-9-]+\.)*(?:huggingface\.co|hf\.co)\//i.test(decl.url);
  return isHuggingFace
    ? [
        `  export HF_TOKEN=...   # https://huggingface.co/settings/tokens`,
        `  curl -L -H "Authorization: Bearer $HF_TOKEN" -o ${dest} "${decl.url}"`,
      ]
    : [`  curl -L -o ${dest} "${decl.url}"`];
}

// POSIX single-quoting: everything inside is literal, and the only character needing care is the
// quote itself, which ends the run and is re-introduced escaped.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
