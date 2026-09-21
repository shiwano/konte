import { type ComfyUITiming, DEFAULT_COMFYUI_TIMING } from "./config.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { pollUntilTerminal, TransientPollError } from "../core/poll-until-terminal.js";
import { extractHistoryError, historyOutcome, isAuthFailure } from "./error-utils.js";
import { ComfyUIHttpClient } from "./http-client.js";
import { resolveHeaderTokens } from "./token-resolver.js";
import type { ComfyUIWsMessage, ProgressCallback } from "./types.js";
import { sleep } from "../core/sleep.js";

// The outcome of a prompt wait. `timedOut` (the waiter's deadline elapsed) is a returned value,
// never a thrown error, so the job is left re-observable and can't be caught-and-failed. Only a
// genuine execution/orphan failure throws.
type PromptWaitResult = { kind: "done" } | { kind: "timedOut" };

// Shared shape for the resilience knobs threaded from WaitOptions down into the waiters.
type WaitForPromptOptions = {
  onProgress?: ProgressCallback;
  // See WaitOptions.onExecutionStarted — fired from every path that observes the prompt actually
  // running (a WebSocket executing/progress event, an HTTP running-history, or presence in
  // queue_running), so a job whose WebSocket was evicted still records when execution began.
  onExecutionStarted?: () => void;
  onLog?: (line: string) => void;
  // Absolute timestamp this waiter stops blocking at. Undefined = wait until the job
  // reaches a terminal state (matches the cloud backends; the watcher passes none).
  deadline?: number;
  signal?: AbortSignal;
  unconfirmedThresholdMs?: number;
  // Fail the prompt once ComfyUI has answered nothing at all for this long. 0/undefined polls
  // forever. See DEFAULT_COMFYUI_UNREACHABLE_TIMEOUT_MS for why ComfyUI, alone, sets one.
  unreachableTimeoutMs?: number;
  onUnconfirmedChange?: (info: { unconfirmed: boolean; lastError: string | null }) => void;
};
// Consecutive polls where the prompt is absent from both queue and history before
// we conclude it was cancelled/removed externally in ComfyUI's UI. Absorbs the brief
// window when a prompt transitions from the queue to history.
const GONE_CONFIRM_THRESHOLD = 2;
// How long a prompt may stay absent from a REACHABLE ComfyUI's queue AND history — without
// ever having been observed alive this session — before we conclude it was lost to a ComfyUI
// crash/restart. Such a prompt never resumes, so we fail the job (orphaned) instead of polling
// "running" forever. Comfortably past the seconds-long queue→history handoff window; absence is
// only counted on successful observations (a backend outage throws transient and never advances
// it), so this can't fire while ComfyUI is merely unreachable.
const ORPHAN_CONFIRM_MS = 60_000;

export type GoneState = { seen: boolean; goneStreak: number; absentSince: number | null };

// The outcome of one presence poll for a prompt:
// - "present": observed alive (in the queue or history).
// - "absent": not observed, but not yet conclusive — keep polling.
// - "gone": seen alive this session, then absent for GONE_CONFIRM_THRESHOLD consecutive polls —
//   a deliberate cancel/removal in ComfyUI's UI (absorbs the brief queue→history window).
// - "orphaned": never seen alive this session and absent from a reachable server for
//   ORPHAN_CONFIRM_MS — ComfyUI crashed/restarted and dropped the prompt.
type PromptPresence = "present" | "absent" | "gone" | "orphaned";

// Pure state transition for the disappearance reconciler. `present` is whether the prompt was
// observed alive on this poll; `now` is the current epoch ms (used to time the orphan grace).
export function registerGonePoll(state: GoneState, present: boolean, now: number): PromptPresence {
  if (present) {
    state.seen = true;
    state.goneStreak = 0;
    state.absentSince = null;
    return "present";
  }
  if (state.absentSince === null) state.absentSince = now;
  if (state.seen) {
    state.goneStreak += 1;
    if (state.goneStreak >= GONE_CONFIRM_THRESHOLD) return "gone";
  }
  if (now - state.absentSince >= ORPHAN_CONFIRM_MS) return "orphaned";
  return "absent";
}

// Build the terminal error for a prompt that left ComfyUI. A user-removed prompt ("gone")
// becomes a cancellation upstream; a crash-dropped one ("orphaned") becomes a failure.
function promptDisappearedError(promptId: string, presence: "gone" | "orphaned"): KonteError {
  if (presence === "orphaned") {
    return new KonteError(
      "COMFYUI_JOB_ORPHANED",
      `Prompt ${promptId} is absent from ComfyUI's queue and history — ComfyUI likely crashed ` +
        `or restarted, losing the job. Marking it failed (orphaned).`,
    );
  }
  return new KonteError(
    "COMFYUI_JOB_GONE",
    `Prompt ${promptId} disappeared from ComfyUI (cancelled or removed externally)`,
  );
}

// The verdict for a ComfyUI that stopped answering entirely. Unlike an orphan (observed absent
// from a REACHABLE server) nothing here was observed at all — the claim is about the server, so
// the message says so, and says the one thing that fixes it.
function unreachableError(promptId: string, sinceMs: number, lastError: string): KonteError {
  return new KonteError(
    "COMFYUI_UNAVAILABLE",
    `ComfyUI has answered nothing for ${Math.round(sinceMs / 60_000)}m (last error: ${lastError}). ` +
      `Prompt ${promptId} lives in the server process, so it did not survive — failing it rather ` +
      `than polling a server that is gone. Start ComfyUI, then re-run the command. ` +
      `Set comfyui.unreachableTimeoutMinutes (0 = wait forever) to change this.`,
  );
}

type ComfyWsMessageHandlers = {
  // Every execution-start observer routes here (see WaitOptions.onExecutionStarted).
  onExecutionStarted?: () => void;
  onProgress?: ProgressCallback;
  // The prompt finished (an `executing` with a null node — ComfyUI's end-of-run marker).
  onDone: () => void;
  // A node raised an execution error; the argument is the terminal COMFYUI_ERROR to fail with.
  onError: (err: KonteError) => void;
};

// Interpret one raw WebSocket frame for `promptId` and route it to the right handler. Pure — no
// socket or promise state — so each branch (execution_start, progress, executing node-vs-terminal,
// execution_error) is unit-testable from a raw JSON string. Frames for another prompt, frames
// without the {data, prompt_id} shape, and unparseable text are ignored.
export function handleComfyWsMessage(
  raw: string,
  promptId: string,
  handlers: ComfyWsMessageHandlers,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  // A valid-JSON but wrong-shape frame (null, a bare string, {data:null}) is ignored like any
  // other non-matching frame — the `in` checks below would otherwise throw on a non-object.
  if (typeof parsed !== "object" || parsed === null) return;
  const msg = parsed as ComfyUIWsMessage;
  if (!("data" in msg) || typeof msg.data !== "object" || msg.data === null) return;
  if (!("prompt_id" in msg.data) || msg.data.prompt_id !== promptId) return;

  switch (msg.type) {
    case "execution_start":
      // The earliest execution-start signal — fires before any progress tick, so a job that
      // completes with few nodes still records its start.
      handlers.onExecutionStarted?.();
      break;
    case "progress":
      handlers.onExecutionStarted?.();
      handlers.onProgress?.({ value: msg.data.value, max: msg.data.max });
      break;
    case "executing":
      if (msg.data.node === null) {
        handlers.onDone();
      } else {
        handlers.onExecutionStarted?.();
        handlers.onProgress?.({ value: 0, max: 100, node: msg.data.node });
      }
      break;
    case "execution_error":
      handlers.onError(
        new KonteError(
          "COMFYUI_ERROR",
          `Execution error on node ${msg.data.node_id} (${msg.data.exception_type}): ${msg.data.exception_message}`,
        ),
      );
      break;
  }
}

export class ComfyUIWsClient {
  readonly baseUrl: string;
  readonly clientId: string;
  private readonly timing: ComfyUITiming;
  private readonly headerTemplates: Readonly<Record<string, string>>;
  private ws: WebSocket | null = null;

  constructor(
    baseUrl: string,
    clientId: string,
    timing: ComfyUITiming = DEFAULT_COMFYUI_TIMING,
    headers: Readonly<Record<string, string>> = {},
  ) {
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.timing = timing;
    this.headerTemplates = headers;
  }

  private httpClient(): ComfyUIHttpClient {
    return new ComfyUIHttpClient(this.baseUrl, {
      clientId: this.clientId,
      headers: this.headerTemplates,
    });
  }

  async connect(): Promise<void> {
    const wsUrl = this.buildWsUrl();
    this.ws = await this.createWebSocket(wsUrl);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async waitForPrompt(
    promptId: string,
    options?: {
      onProgress?: ProgressCallback;
      onExecutionStarted?: () => void;
      onLog?: (line: string) => void;
      timeoutMs?: number;
      signal?: AbortSignal;
      unconfirmedThresholdMs?: number;
      unreachableTimeoutMs?: number;
      onUnconfirmedChange?: (info: { unconfirmed: boolean; lastError: string | null }) => void;
    },
  ): Promise<PromptWaitResult> {
    const httpClient = this.httpClient();
    // A transient failure on this opening check just means we can't take the fast path;
    // fall through to the (resilient) waiters rather than failing the whole job.
    let history: Awaited<ReturnType<ComfyUIHttpClient["getHistory"]>> = null;
    try {
      history = await httpClient.getHistory(promptId);
    } catch {
      history = null;
    }
    if (history) {
      const outcome = historyOutcome(history);
      if (outcome === "error") {
        const detail = extractHistoryError(history);
        throw new KonteError("COMFYUI_ERROR", detail ?? "ComfyUI execution failed");
      }
      if (outcome === "success") return { kind: "done" };
      // A running-history on the opening fast-path check: execution has already begun, so record
      // it now — the WebSocket we're about to join may never re-emit a start we'd otherwise miss.
      options?.onExecutionStarted?.();
    }

    // The deadline bounds only how long THIS waiter blocks — not the job's fate.
    const opts: WaitForPromptOptions = {
      ...options,
      deadline: options?.timeoutMs ? Date.now() + options.timeoutMs : undefined,
    };

    try {
      // A timedOut from the websocket waiter is returned, not thrown — so it propagates as the
      // result here without triggering the polling fallback (which would re-wait the deadline).
      return await this.waitViaWebSocket(promptId, opts);
    } catch (err) {
      // A COMFYUI_WS_UNAVAILABLE means we lost our websocket event stream, NOT that the
      // job failed. The most common cause is another worker (a second watcher, or `konte job
      // wait`) connecting with this same comfyClientId — ComfyUI allows one websocket per
      // clientId, so it evicts our connection, firing an unexpected close. A transient network
      // blip looks the same. HTTP /history is authoritative and unaffected, so fall back to
      // polling rather than spuriously failing the job. Genuine terminal errors
      // (COMFYUI_ERROR execution failure, COMFYUI_JOB_GONE prompt removed) are re-thrown.
      if (err instanceof KonteError && err.code !== "COMFYUI_WS_UNAVAILABLE") {
        throw err;
      }
      return await this.waitViaPolling(promptId, opts);
    }
  }

  // Classifies a prompt's presence (cancelled/removed externally, or orphaned by a ComfyUI
  // crash/restart) by checking the live queue and feeding the result to the reconciler.
  // `onRunning` fires when the prompt is found in queue_running — the polling-side signal that
  // execution has begun (the WebSocket "executing" event's equivalent), so a job whose WebSocket
  // was evicted still records its execution start rather than looking forever un-started.
  private async classifyPromptPresence(
    httpClient: ComfyUIHttpClient,
    promptId: string,
    state: GoneState,
    onRunning?: () => void,
  ): Promise<PromptPresence> {
    const queue = await httpClient.getQueue();
    const running = queue.queue_running.some((item) => Array.isArray(item) && item[1] === promptId);
    const pending = queue.queue_pending.some((item) => Array.isArray(item) && item[1] === promptId);
    if (running) onRunning?.();
    return registerGonePoll(state, running || pending, Date.now());
  }

  private async waitViaWebSocket(
    promptId: string,
    options?: WaitForPromptOptions,
  ): Promise<PromptWaitResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connectWithRetry();
    }

    const ws = this.ws;
    if (!ws) {
      throw new KonteError("COMFYUI_WS_UNAVAILABLE", "WebSocket not connected");
    }

    const httpClient = this.httpClient();

    return new Promise<PromptWaitResult>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      // Safety net: periodically poll HTTP history to detect completion even when
      // WebSocket messages are lost (e.g. duplicate clientId evicts our connection,
      // or the prompt completes between the initial history check and listener setup).
      // Also reconciles prompts cancelled/removed externally in ComfyUI's UI, which
      // emit no WebSocket completion event and would otherwise hang forever.
      const goneState: GoneState = { seen: false, goneStreak: 0, absentSince: null };
      const pollId = setInterval(async () => {
        try {
          const history = await httpClient.getHistory(promptId);
          if (history) {
            const outcome = historyOutcome(history);
            if (outcome === "running") {
              options?.onExecutionStarted?.();
              goneState.seen = true;
              goneState.goneStreak = 0;
              goneState.absentSince = null;
              return;
            }
            options?.onLog?.("Completion detected via HTTP polling safety net");
            cleanup();
            if (outcome === "error") {
              const detail = extractHistoryError(history);
              reject(new KonteError("COMFYUI_ERROR", detail ?? "ComfyUI execution failed"));
            } else {
              resolve({ kind: "done" });
            }
            return;
          }
          const presence = await this.classifyPromptPresence(
            httpClient,
            promptId,
            goneState,
            options?.onExecutionStarted,
          );
          if (presence === "gone" || presence === "orphaned") {
            options?.onLog?.(
              presence === "orphaned"
                ? "Prompt absent from ComfyUI past the grace window (likely a crash/restart) — failing as orphaned"
                : "Prompt disappeared from ComfyUI (cancelled or removed externally)",
            );
            cleanup();
            reject(promptDisappearedError(promptId, presence));
          }
        } catch (err) {
          options?.onLog?.(`Polling safety net error: ${errorMessage(err)}`);
        }
      }, this.timing.safetyNetIntervalMs);

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearInterval(pollId);
        if (timeoutId) clearTimeout(timeoutId);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
        options?.signal?.removeEventListener("abort", onAbort);
      };

      const onMessage = (event: MessageEvent) => {
        // A throwing user callback (onProgress/onExecutionStarted) must not tear down the socket
        // wait — the safety-net poll and deadline still bound the job. Frame parse/shape errors
        // are already swallowed inside handleComfyWsMessage; this guards the handler calls too,
        // preserving the pre-extraction "the message listener never throws" contract.
        try {
          handleComfyWsMessage(String(event.data), promptId, {
            onExecutionStarted: options?.onExecutionStarted,
            onProgress: options?.onProgress,
            onDone: () => {
              cleanup();
              resolve({ kind: "done" });
            },
            onError: (err) => {
              cleanup();
              reject(err);
            },
          });
        } catch {
          // ignore — a callback error must not break the wait
        }
      };

      const onError = () => {
        cleanup();
        reject(new KonteError("COMFYUI_WS_UNAVAILABLE", "WebSocket error"));
      };

      const onClose = () => {
        cleanup();
        reject(new KonteError("COMFYUI_WS_UNAVAILABLE", "WebSocket closed unexpectedly"));
      };

      const onAbort = () => {
        cleanup();
        reject(new KonteError("COMFYUI_ERROR", "Operation aborted"));
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);

      if (options?.signal) {
        options.signal.addEventListener("abort", onAbort);
      }

      if (options?.deadline) {
        const remaining = Math.max(0, options.deadline - Date.now());
        timeoutId = setTimeout(() => {
          // The waiter's deadline elapsed — resolve timedOut (a stop, not a failure) rather
          // than rejecting, so the job is left re-observable and never marked failed.
          cleanup();
          resolve({ kind: "timedOut" });
        }, remaining);
      }
    });
  }

  private async waitViaPolling(
    promptId: string,
    options?: WaitForPromptOptions,
  ): Promise<PromptWaitResult> {
    const httpClient = this.httpClient();
    const goneState: GoneState = { seen: false, goneStreak: 0, absentSince: null };

    const poll = await pollUntilTerminal<void>(
      async () => {
        // Both /history and /queue go through the same HTTP layer, whose failures
        // (connection refused, 5xx, request timeout) are comms problems, never a job
        // verdict — so a throw here is "couldn't observe", surfaced as transient.
        let history: Awaited<ReturnType<ComfyUIHttpClient["getHistory"]>>;
        let presence: PromptPresence = "absent";
        try {
          history = await httpClient.getHistory(promptId);
          if (!history) {
            presence = await this.classifyPromptPresence(
              httpClient,
              promptId,
              goneState,
              options?.onExecutionStarted,
            );
          }
        } catch (err) {
          // A rejected credential is the server ANSWERING, so it is terminal — retrying it until
          // the unreachable ceiling (absent by default on a remote server) would poll forever
          // against a token that has been revoked or rotated.
          if (err instanceof KonteError && isAuthFailure(err)) throw err;
          throw new TransientPollError(errorMessage(err), {
            cause: err,
          });
        }

        if (history) {
          const outcome = historyOutcome(history);
          if (outcome === "error") {
            const detail = extractHistoryError(history);
            throw new KonteError("COMFYUI_ERROR", detail ?? "ComfyUI execution failed");
          }
          if (outcome === "success") return { state: "done", result: undefined };
          // Not terminal → a running-history entry: execution has begun.
          options?.onExecutionStarted?.();
          goneState.seen = true;
          goneState.goneStreak = 0;
          goneState.absentSince = null;
        } else if (presence === "gone" || presence === "orphaned") {
          throw promptDisappearedError(promptId, presence);
        }
        return { state: "pending" };
      },
      {
        deadline: options?.deadline,
        pollIntervalMs: this.timing.pollIntervalMs,
        maxBackoffMs: this.timing.maxBackoffMs,
        unconfirmedThresholdMs: options?.unconfirmedThresholdMs,
        onLog: options?.onLog,
        onUnconfirmedChange: options?.onUnconfirmedChange,
        ...(options?.unreachableTimeoutMs
          ? {
              unreachableTimeout: {
                afterMs: options.unreachableTimeoutMs,
                toError: ({ sinceMs, lastError }) => unreachableError(promptId, sinceMs, lastError),
              },
            }
          : {}),
        label: `prompt ${promptId}`,
      },
    );
    return poll.kind === "done" ? { kind: "done" } : { kind: "timedOut" };
  }

  private async connectWithRetry(): Promise<void> {
    const wsUrl = this.buildWsUrl();
    const delays = this.timing.reconnectDelaysMs;

    for (let attempt = 0; attempt < delays.length; attempt++) {
      try {
        this.ws = await this.createWebSocket(wsUrl);
        return;
      } catch {
        if (attempt < delays.length - 1) {
          await sleep(delays[attempt]!);
        }
      }
    }

    throw new KonteError(
      "COMFYUI_WS_UNAVAILABLE",
      `Failed to connect WebSocket after ${delays.length} attempts`,
    );
  }

  private buildWsUrl(): string {
    const url = new URL(this.baseUrl);
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/ws?clientId=${this.clientId}`;
  }

  private createWebSocket(url: string): Promise<WebSocket> {
    // Bun's WebSocket takes handshake headers; the web-standard signature does not, so under a
    // Node runtime (tests) they are dropped. A server that then rejects the handshake costs
    // nothing beyond the event stream: `waitForPrompt` falls through to authenticated HTTP polling.
    const headers = resolveHeaderTokens(this.headerTemplates);
    const init = Object.keys(headers).length > 0 ? { headers } : undefined;
    const WebSocketWithHeaders = WebSocket as unknown as new (
      url: string,
      options?: { headers: Record<string, string> },
    ) => WebSocket;

    return new Promise((resolve, reject) => {
      const ws = new WebSocketWithHeaders(url, init);

      const settle = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };

      const onOpen = () => {
        settle();
        resolve(ws);
      };

      const onError = (_event: Event) => {
        settle();
        reject(new KonteError("COMFYUI_WS_UNAVAILABLE", `WebSocket connection failed to ${url}`));
      };

      const timer = setTimeout(() => {
        settle();
        ws.close();
        reject(
          new KonteError(
            "COMFYUI_WS_UNAVAILABLE",
            `WebSocket handshake to ${url} went unanswered for ${this.timing.handshakeTimeoutMs}ms`,
          ),
        );
      }, this.timing.handshakeTimeoutMs);

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
  }
}
