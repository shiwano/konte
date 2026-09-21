import { z } from "zod";
import { parseApiResponse } from "../backends/http-util.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { fetchWithRetry } from "../core/http-retry.js";
import { pollUntilTerminal, TransientPollError } from "../core/poll-until-terminal.js";
import { isAuthFailure } from "./error-utils.js";
import { resolveHeaderTokens } from "./token-resolver.js";
import type { ComfyModelDeclaration, ComfyNodeDeclaration } from "../core/types/index.js";
import type { ComfyUIHttpClient } from "./http-client.js";
import type { ComfyUIInputSpec, ComfyUINodeDefinition } from "./types.js";
import { sleep } from "../core/sleep.js";

const DEFAULT_TIMEOUT_MS = 30_000;
// After a reboot the server is down briefly; poll its readiness for up to this long.
const DEFAULT_REBOOT_TIMEOUT_MS = 5 * 60 * 1000;

// ComfyUI-Manager route paths, verified against a live Manager V4.2.1. In V4 every route is
// served under the /api/v2 prefix; the legacy V3 paths (/customnode/*, /manager/reboot) return
// 404. The customnode/reboot handlers live in ComfyUI-Manager's glob/manager_server.py.
const ROUTE_VERSION = "/api/v2/manager/version";
const ROUTE_QUEUE_TASK = "/api/v2/manager/queue/task";
const ROUTE_INSTALLED = "/api/v2/customnode/installed";
const ROUTE_GETMAPPINGS = "/api/v2/customnode/getmappings";
const ROUTE_REBOOT = "/api/v2/manager/reboot";
const ROUTE_HISTORY_LIST = "/api/v2/manager/queue/history_list";
const ROUTE_HISTORY = "/api/v2/manager/queue/history";

// konte speaks the ComfyUI-Manager V4 API (every route lives under /api/v2). An older Manager
// serves a different route surface, so V4 is the minimum supported major version.
export const MIN_MANAGER_MAJOR_VERSION = 4;

// Both install routes only validate the request body; the gate runs later, in the Manager's task
// worker (`is_allowed_security_level('middle+')`), so a denial never reaches this response.
const SECURITY_LEVEL_HINT =
  'Installing requires ComfyUI-Manager\'s security_level to be "normal", "normal-" or "weak", ' +
  'and either a loopback listener or network_mode "personal_cloud". ' +
  "See: https://docs.comfy.org/ja/manager/install";

// Each finished batch records one entry per task, keyed by the `ui_id` konte sent, plus the
// server state it ran under.
const ManagerHistoryListSchema = z.object({ ids: z.array(z.string()) });

// The live session's record of one task, keyed by the `ui_id` konte sent; `result` carries the
// worker's own message.
const ManagerSessionHistorySchema = z.object({
  history: z
    .object({
      result: z.string().nullish(),
      status: z
        .object({ status_str: z.string(), messages: z.array(z.string()).default([]) })
        .nullish(),
    })
    .nullish(),
});

const ManagerHistorySchema = z.object({
  operations: z
    .array(
      z.object({
        operation_id: z.string(),
        result: z.string(),
        error_message: z.string().nullish(),
      }),
    )
    .default([]),
  state_before: z
    .object({
      security_level: z.string().nullish(),
      network_mode: z.string().nullish(),
      cli_args: z.object({ listen: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
type ManagerHistoryState = z.infer<typeof ManagerHistorySchema>["state_before"];

interface ManagerTaskOutcome {
  // "success" on the happy path; otherwise the worker's own failure string.
  result: string;
  errorMessage?: string;
  // Which term of the install gate this server has closed, where its recorded state says.
  denialHint?: string;
}

const ManagerQueueStatusSchema = z.object({
  total_count: z.number(),
  done_count: z.number(),
  in_progress_count: z.number(),
  is_processing: z.boolean(),
});
export type ManagerQueueStatus = z.infer<typeof ManagerQueueStatusSchema>;

type ModelProbe = "present" | "absent" | "unobservable";

// A presence sweep, and whether the server actually answered for every entry. `confirmed: false`
// means at least one "missing" is an assumption, not an observation — enough to queue a download
// or install (both re-check), never enough to conclude a previously-installed file is GONE.
type MissingComfyModels = { missing: ComfyModelDeclaration[]; confirmed: boolean };
type MissingComfyNodes = { missing: string[]; confirmed: boolean };

// Which of a set of node packs are installed but not loaded. `unobservable` is the answer when
// ComfyUI-Manager did not respond at all — a distinct state from "none are loaded", because the
// caller reboots on the latter. See filterUnloadedNodes.
type UnloadedNodesResult =
  | { kind: "known"; unloaded: string[] }
  | { kind: "unobservable"; error: string };

// Re-poll cadence while waiting for ComfyUI-Manager to start answering after a reboot.
const MANAGER_SETTLE_POLL_MS = 2000;

interface ManagerInstallArgs {
  model: ComfyModelDeclaration;
  resolvedUrl: string;
  uiId?: string;
}

interface ManagerNodeInstallArgs {
  node: ComfyNodeDeclaration;
  uiId?: string;
}

export interface WaitOptions {
  // Number of models queued, used as the progress denominator. V4's queue
  // status reports total_count as remaining work (it shrinks as tasks finish),
  // so it can't serve as a fixed total.
  expectedTotal: number;
  // Bounds only how long THIS waiter blocks; undefined = wait until the queue settles. Crash
  // recovery is the run lease's job (the heartbeat lapses and another worker reclaims), not this
  // deadline — so the long-lived watcher and `job wait` loop pass none and just wait to the end.
  timeoutMs?: number;
  pollIntervalMs?: number;
  onLog?: (msg: string) => void;
  // Fired once per change in done_count (i.e. when a model finishes), not per
  // poll — the manager only reports model-level progress, so this is naturally
  // sparse.
  onProgress?: (status: ManagerQueueStatus) => void;
  // Polled each iteration; returning true stops waiting and resolves with
  // { cancelled: true }. The manager has no abort API, so the install may keep
  // running server-side (harmless — the model just finishes and is cached).
  shouldCancel?: () => boolean | Promise<boolean>;
}

// Memoizes the two lookups a presence check needs, so filtering N models costs one /object_info
// and one listing per distinct `savePath` root instead of one pair per model.
class ModelLookupCache {
  private objectInfoPromise?: Promise<Record<string, ComfyUINodeDefinition>>;
  private readonly modelFilesPromises = new Map<string, Promise<string[] | null>>();

  objectInfo(load: () => Promise<Record<string, ComfyUINodeDefinition>>) {
    this.objectInfoPromise ??= load();
    return this.objectInfoPromise;
  }

  modelFiles(root: string, load: () => Promise<string[] | null>) {
    let promise = this.modelFilesPromises.get(root);
    if (!promise) {
      promise = load();
      this.modelFilesPromises.set(root, promise);
    }
    return promise;
  }
}

export class ComfyUIManagerClient {
  readonly baseUrl: string;
  private readonly httpClient: ComfyUIHttpClient;

  constructor(baseUrl: string, httpClient: ComfyUIHttpClient) {
    this.baseUrl = baseUrl;
    this.httpClient = httpClient;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetchManager(ROUTE_VERSION, { method: "GET" });
      // A reachable server that isn't a Manager (non-ok) is a definitive "not available".
      return res.ok;
    } catch (err) {
      // Couldn't reach the server at all — not a verdict on whether the Manager exists. Surface
      // transient so an install job is left re-observable (the job waits for the Manager to come
      // back) rather than being failed with a misleading "not detected".
      if (err instanceof TransientPollError) throw err;
      return false;
    }
  }

  // The Manager's version string (e.g. "V4.2.1"), or null if unreachable. Returns the raw,
  // trimmed text; parse the major with `parseManagerMajorVersion`.
  async getVersion(): Promise<string | null> {
    try {
      const res = await this.fetchManager(ROUTE_VERSION, { method: "GET" });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  // The Manager's verdict on the task konte queued under `uiId`, or null when it cannot be read —
  // an older Manager, an unreachable server, a batch not yet finalized.
  //
  // The session history answers first: it is keyed by the task and carries the worker's own
  // failure text, which the batch record drops. The batch is still read for `state_before` — the
  // only place a security denial is visible — and is what answers once the session has rolled over.
  async getTaskOutcome(uiId: string): Promise<ManagerTaskOutcome | null> {
    const session = await this.readSessionTask(uiId);
    if (session?.result === "success") return session;
    const batch = await this.readBatchTask(uiId);
    if (session === null) return batch;
    return {
      ...session,
      ...(batch?.denialHint !== undefined ? { denialHint: batch.denialHint } : {}),
    };
  }

  private async readSessionTask(uiId: string): Promise<ManagerTaskOutcome | null> {
    try {
      const res = await this.fetchManager(`${ROUTE_HISTORY}?ui_id=${encodeURIComponent(uiId)}`, {
        method: "GET",
      });
      if (!res.ok) return null;
      const { history } = ManagerSessionHistorySchema.parse(await res.json());
      const message = history?.result ?? history?.status?.messages.join("; ");
      const result = history?.status?.status_str ?? (message === "success" ? "success" : undefined);
      if (result === undefined) return null;
      return {
        result,
        ...(result !== "success" && message && message !== result ? { errorMessage: message } : {}),
      };
    } catch {
      return null;
    }
  }

  // Only the newest batch is consulted, and `ui_id` names a target rather than an attempt, so an
  // older batch can still hold a stale entry for it.
  private async readBatchTask(uiId: string): Promise<ManagerTaskOutcome | null> {
    try {
      const listRes = await this.fetchManager(ROUTE_HISTORY_LIST, { method: "GET" });
      if (!listRes.ok) return null;
      const { ids } = ManagerHistoryListSchema.parse(await listRes.json());
      const batchId = ids[0];
      if (batchId === undefined) return null;

      const res = await this.fetchManager(`${ROUTE_HISTORY}?id=${encodeURIComponent(batchId)}`, {
        method: "GET",
      });
      if (!res.ok) return null;
      const batch = ManagerHistorySchema.parse(await res.json());
      const operation = batch.operations.find((op) => op.operation_id === uiId);
      if (!operation) return null;
      const hint = denialHint(batch.state_before);
      return {
        result: operation.result,
        ...(operation.error_message ? { errorMessage: operation.error_message } : {}),
        ...(hint !== undefined ? { denialHint: hint } : {}),
      };
    } catch {
      return null;
    }
  }

  // Tolerant availability check: an unreachable ComfyUI reads as "not available" so callers fall
  // back to queuing a download. Use for the PRE-install check; use `probeModel` to VERIFY a
  // finished install (where "couldn't observe" must not be conflated with "absent").
  async isModelAvailable(model: ComfyModelDeclaration): Promise<boolean> {
    try {
      return (await this.lookupModel(model, new ModelLookupCache())) === "present";
    } catch {
      return false;
    }
  }

  // Strict probe for post-install verification: a transient comms failure propagates
  // (getObjectInfo throws TransientHttpError) instead of being swallowed into a false "absent", so
  // a brief blip while confirming the download leaves the job re-observable rather than failing it.
  async probeModel(model: ComfyModelDeclaration): Promise<ModelProbe> {
    return this.lookupModel(model, new ModelLookupCache());
  }

  /**
   * Of the given models, those NOT yet available in ComfyUI, reusing one object_info and one
   * listing per `savePath` root across the whole set. An unreachable ComfyUI still reports every
   * model missing, so a caller queuing downloads keeps working offline.
   *
   * `confirmed` is what separates that fallback from a real answer: false when any model could not
   * actually be observed. Queuing a download on an unconfirmed miss is harmless (the worker
   * re-checks), but treating one as proof the file is GONE is not — see ensureComfyModelJobs.
   */
  async filterMissingModels(models: readonly ComfyModelDeclaration[]): Promise<MissingComfyModels> {
    if (models.length === 0) return { missing: [], confirmed: true };
    const cache = new ModelLookupCache();
    const missing: ComfyModelDeclaration[] = [];
    let confirmed = true;
    for (const model of models) {
      let probe: ModelProbe;
      try {
        probe = await this.lookupModel(model, cache);
      } catch {
        probe = "unobservable";
      }
      if (probe === "present") continue;
      if (probe === "unobservable") confirmed = false;
      missing.push(model);
    }
    return { missing, confirmed };
  }

  // Where the declaration names a `savePath` whose root ComfyUI knows, that listing is the whole
  // answer: it is the only check that distinguishes one install target from another, and a bare
  // filename hit elsewhere in /object_info says nothing about whether THIS target is filled (a
  // `model.safetensors` sits in half the loader combos). Otherwise — no savePath, or a root
  // ComfyUI does not serve — fall back to the combo scan, which is how every loader-selected
  // weight is observed.
  //
  // "Not found" reads as `absent` only where the observation could have witnessed the file: a
  // served folder lists just the extensions its owner registered, and a combo scan speaks only for
  // a target pinned by filename alone. Everything else is `unobservable`.
  private async lookupModel(
    model: ComfyModelDeclaration,
    cache: ModelLookupCache,
  ): Promise<ModelProbe> {
    const segments = model.savePath?.split("/").filter((s) => s.length > 0) ?? [];
    const root = segments[0];
    if (root !== undefined) {
      const files = await cache.modelFiles(root, () => this.httpClient.getModelFiles(root));
      if (files !== null) {
        if (files.includes([...segments.slice(1), model.filename].join("/"))) return "present";
        return listsExtensionOf(files, model.filename) ? "absent" : "unobservable";
      }
    }
    const objectInfo = await cache.objectInfo(() => this.httpClient.getObjectInfo());
    if (findFilenameInObjectInfo(objectInfo, model.filename)) return "present";
    return root === undefined ? "absent" : "unobservable";
  }

  async queueInstall(args: ManagerInstallArgs): Promise<void> {
    const { model, resolvedUrl, uiId } = args;
    // ComfyUI-Manager V4 validates the body as ModelMetadata and requires
    // client_id + ui_id; name/type/url/filename are all mandatory.
    const body: Record<string, unknown> = {
      url: resolvedUrl,
      filename: model.filename,
      type: model.type,
      save_path: model.savePath ?? "default",
      name: model.displayName ?? model.filename,
      client_id: this.httpClient.clientId,
      ui_id: uiId ?? `konte-${model.filename}`,
    };
    if (model.base) body.base = model.base;

    const res = await this.fetchManager("/api/v2/manager/queue/install_model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // The Manager may echo the request's resolved URL (with its `${VAR}` token) in the error
      // body; redact it back to the placeholder before this message is persisted to job/log.
      const text = this.httpClient.redactBody(await res.text().catch(() => ""), [model.url]);
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager rejected install request for ${model.filename} (${res.status}): ${text || res.statusText}. ` +
          SECURITY_LEVEL_HINT,
      );
    }
  }

  async startQueue(): Promise<void> {
    const res = await this.fetchManager("/api/v2/manager/queue/start", { method: "POST" });
    if (!res.ok) {
      const text = this.httpClient.redactBody(await res.text().catch(() => ""));
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager queue/start failed (${res.status}): ${text || res.statusText}`,
      );
    }
  }

  async getQueueStatus(clientId?: string): Promise<ManagerQueueStatus> {
    // Scope the status to our own client_id so concurrent installs from other
    // clients (e.g. the ComfyUI web UI) don't skew the completion check.
    const path =
      clientId !== undefined
        ? `/api/v2/manager/queue/status?client_id=${encodeURIComponent(clientId)}`
        : "/api/v2/manager/queue/status";
    const res = await this.fetchManager(path, { method: "GET" });
    if (!res.ok) {
      const text = this.httpClient.redactBody(await res.text().catch(() => ""));
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager queue/status failed (${res.status}): ${text || res.statusText}`,
      );
    }
    return parseApiResponse(
      res,
      ManagerQueueStatusSchema,
      "COMFYUI_MANAGER_UNAVAILABLE",
      "ComfyUI-Manager queue/status",
    );
  }

  // `timedOut` (this waiter's deadline elapsed) and `cancelled` are NOT install failures and are
  // returned, never thrown: the Manager has no abort API, so the download keeps running
  // server-side and is re-observable via the queue. Returning them lets the job runner leave the
  // job non-terminal (reclaimed and re-attached by a later pass) — only a genuine error throws.
  async waitForQueueCompletion(
    opts: WaitOptions,
  ): Promise<{ kind: "done" } | { kind: "timedOut" } | { kind: "cancelled" }> {
    const { expectedTotal } = opts;
    let lastReported = -1;

    const poll = await pollUntilTerminal<void>(
      async () => {
        let status: ManagerQueueStatus;
        try {
          status = await this.getQueueStatus(this.httpClient.clientId);
        } catch (err) {
          // A rejected credential is the server ANSWERING, so it is terminal: polling on would
          // wait out a token that has been revoked, and this waiter often runs with no deadline.
          if (err instanceof KonteError && isAuthFailure(err)) throw err;
          // The Manager HTTP layer being briefly unreachable is a comms problem, not an
          // install failure — keep polling rather than failing the download.
          throw new TransientPollError(errorMessage(err), {
            cause: err,
          });
        }
        if (status.done_count !== lastReported) {
          opts.onLog?.(
            `Model install progress: ${status.done_count}/${expectedTotal} done` +
              (status.in_progress_count > 0 ? ` (${status.in_progress_count} in progress)` : ""),
          );
          opts.onProgress?.(status);
          lastReported = status.done_count;
        }
        // total_count is remaining (pending + running); 0 means everything queued
        // for this client has settled (succeeded or failed).
        if (status.total_count === 0) {
          return { state: "done", result: undefined };
        }
        return { state: "pending" };
      },
      {
        deadline: opts.timeoutMs ? Date.now() + opts.timeoutMs : undefined,
        pollIntervalMs: opts.pollIntervalMs,
        shouldCancel: opts.shouldCancel,
        onLog: opts.onLog,
        label: "model install",
      },
    );

    if (poll.kind === "cancelled") return { kind: "cancelled" };
    if (poll.kind === "timedOut") return { kind: "timedOut" };
    return { kind: "done" };
  }

  // Of the given cnr_ids, those NOT installed on disk in ComfyUI (so they need installing).
  // Mirrors filterMissingModels, `confirmed` included: an unreachable Manager still reports every
  // id missing, but says so.
  async filterMissingNodes(ids: readonly string[]): Promise<MissingComfyNodes> {
    if (ids.length === 0) return { missing: [], confirmed: true };
    const installed = await this.getInstalledNodeIds("default").catch(() => null);
    if (installed === null) return { missing: [...ids], confirmed: false };
    return { missing: ids.filter((id) => !installed.has(id)), confirmed: true };
  }

  /**
   * Of the given cnr_ids, which are installed on disk but NOT yet loaded into the running ComfyUI
   * process (so a reboot is needed to register their node classes). A pack is "loaded" when it
   * appears in the `imported` snapshot, captured at server startup.
   *
   * "Unobservable" is its own answer, never folded into "unloaded". The caller acts on this by
   * REBOOTING, and reading an unanswered Manager as "nothing is loaded" is what let konte reboot a
   * server it could not see — including one that had just been restarted by hand and whose Manager
   * had not finished booting, so the restart was undone as fast as it was made.
   *
   * `settleMs` re-polls while unobservable, for exactly that window: right after a reboot the core
   * server answers `/system_stats` before ComfyUI-Manager can answer its own routes.
   */
  async filterUnloadedNodes(
    ids: readonly string[],
    opts?: { settleMs?: number },
  ): Promise<UnloadedNodesResult> {
    if (ids.length === 0) return { kind: "known", unloaded: [] };
    const deadline = Date.now() + (opts?.settleMs ?? 0);
    let lastError = "ComfyUI-Manager did not answer";
    for (;;) {
      try {
        const imported = await this.getInstalledNodeIds("imported");
        return { kind: "known", unloaded: ids.filter((id) => !imported.has(id)) };
      } catch (err) {
        lastError = errorMessage(err);
      }
      if (Date.now() >= deadline) return { kind: "unobservable", error: lastError };
      await sleep(MANAGER_SETTLE_POLL_MS);
    }
  }

  // The set of installed node-pack identifiers reported by ComfyUI-Manager. `mode=default`
  // is the current on-disk state; `mode=imported` is the snapshot of packs loaded at server
  // startup. The response shape varies by Manager version, so this is defensive: it collects
  // both object keys and any nested cnr_id/id fields.
  async getInstalledNodeIds(mode: "default" | "imported"): Promise<Set<string>> {
    const res = await this.fetchManager(`${ROUTE_INSTALLED}?mode=${mode}`, { method: "GET" });
    if (!res.ok) {
      const text = this.httpClient.redactBody(await res.text().catch(() => ""));
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager ${ROUTE_INSTALLED} failed (${res.status}): ${text || res.statusText}`,
      );
    }
    return collectNodePackIds(await res.json());
  }

  async queueInstallNode(args: ManagerNodeInstallArgs): Promise<void> {
    const { node, uiId } = args;
    // V4 wraps the install in a generic queue task: { kind: "install", params: InstallPackParams }.
    // The worker resolves the target by `id` alone against the Manager's own node database;
    // `InstallPackParams.repository` is recorded in the task history but never read.
    const body = {
      kind: "install",
      ui_id: uiId ?? `konte-${node.id}`,
      client_id: this.httpClient.clientId,
      params: {
        id: node.id,
        version: "latest",
        selected_version: "latest",
        channel: "default",
        mode: "cache",
        skip_post_install: false,
      },
    };

    const res = await this.fetchManager(ROUTE_QUEUE_TASK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = this.httpClient.redactBody(await res.text().catch(() => ""));
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager rejected node install for "${node.id}" (${res.status}): ${text || res.statusText}. ` +
          SECURITY_LEVEL_HINT,
      );
    }
  }

  // Map each given node class_type to its owning node-pack cnr_id, via the Manager's
  // node→pack mapping DB. Core/built-in classes (no mapping) are omitted. Used by
  // `konte comfy import` to scaffold a `nodes: [...]` block from a workflow.
  async resolveClassToPack(classTypes: readonly string[]): Promise<Map<string, string>> {
    if (classTypes.length === 0) return new Map();
    const res = await this.fetchManager(`${ROUTE_GETMAPPINGS}?mode=nickname`, { method: "GET" });
    if (!res.ok) {
      const text = this.httpClient.redactBody(await res.text().catch(() => ""));
      throw new KonteError(
        "COMFYUI_MANAGER_UNAVAILABLE",
        `ComfyUI-Manager ${ROUTE_GETMAPPINGS} failed (${res.status}): ${text || res.statusText}`,
      );
    }
    const classToPack = invertNodeMappings(await res.json());
    const result = new Map<string, string>();
    for (const cls of classTypes) {
      const pack = classToPack.get(cls);
      if (pack) result.set(cls, pack);
    }
    return result;
  }

  // Reboot ComfyUI (required for newly-installed custom nodes to register). The server drops
  // its connection as it restarts, so a transient connection error here is the expected
  // outcome, not a failure — readiness is confirmed separately via waitUntilReachable.
  async reboot(): Promise<void> {
    try {
      await this.fetchManager(ROUTE_REBOOT, { method: "POST", timeout: 5_000 });
    } catch (err) {
      // The server drops the connection as it restarts — a transient comms failure here is the
      // expected outcome, not a failure; readiness is confirmed separately via waitUntilReachable.
      if (err instanceof TransientPollError) return;
      throw err;
    }
  }

  // Poll until ComfyUI answers again (after a reboot) or the timeout elapses.
  async waitUntilReachable(timeoutMs = DEFAULT_REBOOT_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // Give the process a moment to actually go down before the first probe, so we don't
    // immediately see the pre-reboot server as "reachable".
    await sleep(1_000);
    while (Date.now() < deadline) {
      if (await this.httpClient.ping(5_000)) return true;
      await sleep(2_000);
    }
    return false;
  }

  // A transient comms failure (network error, request timeout, 408/429/5xx) is NOT a Manager
  // verdict — it surfaces as a `TransientHttpError` (a `TransientPollError`) so callers can keep
  // polling or leave the install job re-observable, matching how generation waits treat transient
  // failures. A reachable Manager's permanent non-ok (e.g. 403 security_level, 404) is returned as
  // a Response so the caller raises its own typed error. `maxRetries: 0` keeps this a single
  // classifying attempt: the poll loop / job re-observe owns the retry cadence, and a POST is never
  // silently re-sent.
  private async fetchManager(
    path: string,
    options?: RequestInit & { timeout?: number },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const { timeout, ...init } = options ?? {};
    const headers = {
      ...resolveHeaderTokens(this.httpClient.headerTemplates),
      ...(init.headers as Record<string, string>),
    };
    const res = await fetchWithRetry(
      url,
      { ...init, headers },
      { maxRetries: 0, timeoutMs: timeout ?? DEFAULT_TIMEOUT_MS },
    );
    // The Manager answers 403 for its own `security_level` restriction, but only ever to refuse an
    // ACTION — which konte only asks for with a POST. A route konte merely reads from has no such
    // refusal to express, so a 403 there is the auth front, and must be terminal: a queue poll
    // touches nothing else, so nothing would re-observe it as an auth failure.
    const method = (init.method ?? "GET").toUpperCase();
    if (res.status === 401 || (res.status === 403 && method === "GET")) {
      throw new KonteError(
        "COMFYUI_UNAUTHORIZED",
        `ComfyUI-Manager at ${this.baseUrl} rejected the credentials (${res.status}).`,
      );
    }
    return res;
  }
}

// Extract the major version from a ComfyUI-Manager version string (e.g. "V4.2.1" -> 4).
// Tolerates an optional leading "V"; returns null when no leading numeric major is present.
export function parseManagerMajorVersion(version: string): number | null {
  const match = version.trim().match(/^v?(\d+)/i);
  return match ? Number(match[1]) : null;
}

// Collect node-pack identifiers from a ComfyUI-Manager /customnode/installed response.
// The exact shape varies by Manager version (object keyed by pack id, or by directory with a
// nested cnr_id/id), so this gathers both the keys and any nested cnr_id/aux_id/id strings.
export function collectNodePackIds(data: unknown): Set<string> {
  const ids = new Set<string>();
  if (data === null || typeof data !== "object") return ids;
  const entries = Array.isArray(data)
    ? data.map((v) => [undefined, v] as const)
    : Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, v] as const);
  for (const [key, value] of entries) {
    if (typeof key === "string" && key.length > 0) ids.add(key);
    if (value && typeof value === "object") {
      for (const field of ["cnr_id", "aux_id", "id"] as const) {
        const v = (value as Record<string, unknown>)[field];
        if (typeof v === "string" && v.length > 0) ids.add(v);
      }
    }
  }
  return ids;
}

// Invert a ComfyUI-Manager /customnode/getmappings response into class_type → pack id.
// The response maps pack id → [nodeClassNames[], metadata]; only the first element matters.
export function invertNodeMappings(data: unknown): Map<string, string> {
  const classToPack = new Map<string, string>();
  if (data === null || typeof data !== "object") return classToPack;
  for (const [packId, value] of Object.entries(data as Record<string, unknown>)) {
    const nodeList = Array.isArray(value) ? value[0] : undefined;
    if (!Array.isArray(nodeList)) continue;
    for (const cls of nodeList) {
      if (typeof cls === "string" && !classToPack.has(cls)) classToPack.set(cls, packId);
    }
  }
  return classToPack;
}

// Name every closed term of the install gate, from the state recorded for the batch.
// `is_allowed_security_level('middle+')` wants a security_level of weak/normal/normal- AND either
// a loopback listener or network_mode personal_cloud, so both can be closed at once.
function denialHint(state: ManagerHistoryState): string | undefined {
  const listen = state?.cli_args?.listen ?? undefined;
  const networkMode = state?.network_mode ?? undefined;
  const securityLevel = state?.security_level ?? undefined;
  const closed: string[] = [];

  if (listen !== undefined && !isLoopbackAddress(listen) && networkMode !== "personal_cloud") {
    closed.push(
      `ComfyUI listens on ${listen} and ComfyUI-Manager's network_mode is "${networkMode ?? "unset"}" — ` +
        `it installs nothing from a non-loopback listener unless network_mode is "personal_cloud"`,
    );
  }
  if (securityLevel !== undefined && !INSTALL_SECURITY_LEVELS.has(securityLevel)) {
    closed.push(
      `ComfyUI-Manager's security_level is "${securityLevel}" — installing requires ` +
        `"normal", "normal-" or "weak"`,
    );
  }
  if (closed.length === 0) return undefined;
  return `${closed.join(". Also: ")}.`;
}

// Matches the Manager's own test (Python's `ip_address(...).is_loopback`), which takes all of
// 127.0.0.0/8.
function isLoopbackAddress(listen: string): boolean {
  return listen === "localhost" || listen === "::1" || listen.startsWith("127.");
}

const INSTALL_SECURITY_LEVELS = new Set(["weak", "normal", "normal-"]);

// Whether the folder's registered extension set covers this file: another entry with the same
// extension is what makes a miss an absence rather than a filter.
function listsExtensionOf(files: readonly string[], filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = filename.slice(dot).toLowerCase();
  return files.some((f) => f.toLowerCase().endsWith(ext));
}

function findFilenameInObjectInfo(
  objectInfo: Record<string, ComfyUINodeDefinition>,
  filename: string,
): boolean {
  for (const node of Object.values(objectInfo)) {
    if (hasFilenameInInputSpec(node.input?.required, filename)) return true;
    if (hasFilenameInInputSpec(node.input?.optional, filename)) return true;
  }
  return false;
}

function hasFilenameInInputSpec(
  spec: Record<string, ComfyUIInputSpec> | undefined,
  filename: string,
): boolean {
  if (!spec) return false;
  for (const value of Object.values(spec)) {
    // Loader fields are encoded as [<combo array>, <metadata?>]; the combo array
    // contains the available filenames.
    const head = value[0];
    if (Array.isArray(head) && head.includes(filename)) return true;
  }
  return false;
}
