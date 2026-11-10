import { parseApiResponse, saveDownloadResponse } from "../backends/http-util.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { MEDIA_TRANSFER_TIMEOUT_MS, fetchWithRetry } from "../core/http-retry.js";
import { redactExternalBody } from "../core/redact.js";
import { resolveHeaderTokens } from "./token-resolver.js";
import {
  type ComfyUIHistoryEntry,
  type ComfyUIModelFolder,
  type ComfyUINodeDefinition,
  type ComfyUIOutputFile,
  type ComfyUIPromptErrorBody,
  type ComfyUIPromptResponse,
  type ComfyUIQueueInfo,
  type ComfyUISystemStats,
  type ComfyUIUploadResult,
  type ComfyUIWorkflow,
  ComfyUIHistoryResponseSchema,
  ComfyUIModelFilesSchema,
  ComfyUIModelFoldersSchema,
  ComfyUIObjectInfoSchema,
  ComfyUIPromptErrorBodySchema,
  ComfyUIPromptResponseSchema,
  ComfyUIQueueInfoSchema,
  ComfyUISystemStatsSchema,
  ComfyUIUploadResultSchema,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

type ComfyUIClientOptions = {
  clientId?: string;
  // Unresolved header templates from `comfy.comfyui.headers` (`Bearer ${COMFYUI_TOKEN}`).
  headers?: Readonly<Record<string, string>>;
};

export class ComfyUIHttpClient {
  readonly baseUrl: string;
  readonly clientId: string;
  // Unresolved, and public: the Manager client fetches the same server and must authenticate
  // identically. A resolved credential is never handed around.
  readonly headerTemplates: Readonly<Record<string, string>>;

  constructor(baseUrl: string, options: ComfyUIClientOptions = {}) {
    this.baseUrl = baseUrl;
    this.clientId = options.clientId ?? crypto.randomUUID();
    this.headerTemplates = options.headers ?? {};
  }

  // Resolved per call, never held.
  private authHeaders(): Record<string, string> {
    return resolveHeaderTokens(this.headerTemplates);
  }

  /**
   * An external error body, made safe to persist: URLs stripped to origin+path, and any resolved
   * `${VAR}` reversed back to its placeholder. A server behind an auth front commonly echoes the
   * request it rejected, credential included.
   */
  redactBody(body: string, extraTemplates: readonly string[] = []): string {
    return redactExternalBody(body, [...Object.values(this.headerTemplates), ...extraTemplates]);
  }

  async queuePrompt(workflow: ComfyUIWorkflow): Promise<ComfyUIPromptResponse> {
    const body = JSON.stringify({
      prompt: workflow,
      client_id: this.clientId,
    });

    // ComfyUI returns validation failures as HTTP 400 with a structured body
    // ({ error, node_errors }), so we must read the body even on a non-ok status
    // to surface the actual cause instead of a raw, truncated JSON dump.
    const res = await this.fetch("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      allowErrorStatus: true,
      submission: true,
    });

    if (!res.ok) {
      if (res.status === 502 || res.status === 504) {
        throw this.unconfirmedSubmission(`a gateway answered ${res.status}`);
      }
      const text = await res.text().catch(() => "");
      const errors = ComfyUIPromptErrorBodySchema.safeParse(parseJsonOrUndefined(text));
      const details = errors.success ? this.describePromptErrors(errors.data) : null;
      if (details) {
        throw new KonteError(
          "COMFYUI_ERROR",
          "Workflow validation failed — fix the nodes ComfyUI names",
          details,
        );
      }
      throw new KonteError(
        "COMFYUI_ERROR",
        `ComfyUI API error (${res.status}): ${this.redactBody(text) || res.statusText}`,
      );
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw this.unconfirmedSubmission(`its answer was cut off: ${errorMessage(err)}`);
    }
    const parsed = ComfyUIPromptResponseSchema.safeParse(parseJsonOrUndefined(text));
    if (!parsed.success) {
      throw this.unconfirmedSubmission(`its ${res.status} answer carries no prompt_id`);
    }
    return parsed.data;
  }

  /**
   * The `/prompt` node errors as job error lines, redacted: a validation failure echoes the input
   * values of the submitted workflow, credentialed input URLs included.
   */
  describePromptErrors(errors: ComfyUIPromptErrorBody): string[] | null {
    const details = formatPromptErrors(errors);
    return details ? this.redactBody(details).split("\n") : null;
  }

  private unconfirmedSubmission(reason: string): KonteError {
    return new KonteError(
      "SUBMISSION_UNCONFIRMED",
      `ComfyUI at ${this.baseUrl} may have queued the prompt (${reason}). Automatic ` +
        `resubmission stopped. Check ComfyUI's queue and history before rerolling.`,
    );
  }

  async getHistory(promptId: string): Promise<ComfyUIHistoryEntry | null> {
    const res = await this.fetch(`/history/${promptId}`);
    const data = await parseApiResponse(
      res,
      ComfyUIHistoryResponseSchema,
      "COMFYUI_ERROR",
      "ComfyUI /history",
    );
    return data[promptId] ?? null;
  }

  async getQueue(timeoutMs?: number): Promise<ComfyUIQueueInfo> {
    const res = await this.fetch(
      "/queue",
      timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
    );
    return parseApiResponse(res, ComfyUIQueueInfoSchema, "COMFYUI_ERROR", "ComfyUI /queue");
  }

  async interrupt(): Promise<void> {
    await this.fetch("/interrupt", { method: "POST" });
  }

  async deleteQueueItems(promptIds: string[]): Promise<void> {
    await this.fetch("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: promptIds }),
    });
  }

  async uploadImage(
    filename: string,
    data: Buffer | Uint8Array,
    subfolder?: string,
  ): Promise<ComfyUIUploadResult> {
    const formData = new FormData();
    const blob = new Blob([data as unknown as Uint8Array<ArrayBuffer>]);
    formData.append("image", blob, filename);
    // Without overwrite, ComfyUI keeps an existing file whose bytes match and answers with its
    // name. Overwriting rewrites it in place while a prompt queued earlier may be reading it.
    formData.append("overwrite", "false");
    if (subfolder) {
      formData.append("subfolder", subfolder);
    }

    const res = await this.fetch("/upload/image", {
      method: "POST",
      body: formData,
      timeout: MEDIA_TRANSFER_TIMEOUT_MS,
    });

    return parseApiResponse(
      res,
      ComfyUIUploadResultSchema,
      "COMFYUI_ERROR",
      "ComfyUI /upload/image",
    );
  }

  // Stream a completed output straight to disk (atomic temp + rename) rather than buffering it in
  // memory — a rendered video can be hundreds of MB.
  async downloadOutputToFile(file: ComfyUIOutputFile, outputPath: string): Promise<void> {
    const params = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder,
      type: file.type,
    });

    const res = await this.fetch(`/view?${params.toString()}`, {
      timeout: MEDIA_TRANSFER_TIMEOUT_MS,
    });
    await saveDownloadResponse(res, outputPath);
  }

  async getObjectInfo(): Promise<Record<string, ComfyUINodeDefinition>> {
    // Routed through fetchWithRetry (classify-only) so a transient comms failure surfaces as a
    // TransientHttpError rather than an opaque COMFYUI_*: callers verifying a finished install can
    // then tell "couldn't observe" (re-observe) from "genuinely absent" (fail).
    const res = await fetchWithRetry(
      `${this.baseUrl}/object_info`,
      { headers: this.authHeaders() },
      { maxRetries: 0 },
    );
    if (!res.ok) {
      throw new KonteError("COMFYUI_ERROR", `ComfyUI /object_info failed (${res.status})`);
    }
    return parseApiResponse(res, ComfyUIObjectInfoSchema, "COMFYUI_ERROR", "ComfyUI /object_info");
  }

  // The files under one `folder_paths` root (e.g. "TTS"), as forward-slash relative paths. A model
  // that no node exposes as a combo value — a multi-file directory the node loads by path — is
  // invisible in /object_info but listed here, so a `savePath`-declared model is still observable.
  // null when ComfyUI does not know the root at all, which is a different answer from "the root
  // is empty": callers fall back to the combo scan rather than reading absence into it.
  async getModelFiles(folder: string): Promise<string[] | null> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/models/${encodeURIComponent(folder)}`,
      { headers: this.authHeaders() },
      { maxRetries: 0 },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new KonteError("COMFYUI_ERROR", `ComfyUI /api/models/${folder} failed (${res.status})`);
    }
    const files = await parseApiResponse(
      res,
      ComfyUIModelFilesSchema,
      "COMFYUI_ERROR",
      `ComfyUI /api/models/${folder}`,
    );
    // A ComfyUI on Windows reports backslash-separated paths.
    return files.map((f) => f.replaceAll("\\", "/"));
  }

  // Every `folder_paths` root with its absolute on-disk directories, so konte can write a model
  // straight into the place ComfyUI reads it from. The route is experimental and absent before
  // ComfyUI 0.3.x; null means "this server won't tell us", which callers read as "not local" and
  // fall back to ComfyUI-Manager rather than guessing a path.
  async getModelFolders(): Promise<ComfyUIModelFolder[] | null> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/experiment/models`,
      { headers: this.authHeaders() },
      { maxRetries: 0 },
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const parsed = ComfyUIModelFoldersSchema.safeParse(await res.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  }

  async ping(timeoutMs?: number): Promise<boolean> {
    try {
      await this.fetch(
        "/system_stats",
        timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
      );
      return true;
    } catch {
      return false;
    }
  }

  async systemStats(timeoutMs?: number): Promise<ComfyUISystemStats> {
    const res = await this.fetch(
      "/system_stats",
      timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
    );
    return parseApiResponse(
      res,
      ComfyUISystemStatsSchema,
      "COMFYUI_ERROR",
      "ComfyUI /system_stats",
    );
  }

  private async fetch(
    path: string,
    options?: RequestInit & { timeout?: number; allowErrorStatus?: boolean; submission?: boolean },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    const signal = options?.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);

    // The caller's own headers win: `/upload/image` builds a multipart body whose boundary only
    // fetch knows, and a Content-Type from anywhere else would invalidate it.
    const headers = { ...this.authHeaders(), ...(options?.headers as Record<string, string>) };

    let res: Response;
    try {
      res = await fetch(url, { ...options, headers, signal });
    } catch (err) {
      const timedOut =
        err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
      if (options?.submission && !neverConnected(err)) {
        throw this.unconfirmedSubmission(
          timedOut ? `no answer within ${timeoutMs / 1000}s` : errorMessage(err),
        );
      }
      if (timedOut) {
        throw new KonteError("COMFYUI_UNAVAILABLE", `Request to ${url} timed out`);
      }
      throw new KonteError(
        "COMFYUI_UNAVAILABLE",
        `Failed to connect to ComfyUI at ${this.baseUrl}: ${errorMessage(err)}. Start ComfyUI ` +
          `(or correct comfy.comfyui.url in \`konte settings\`, Config tab), then re-run the command.`,
      );
    }

    // Unconditional, `allowErrorStatus` included: that flag lets `/prompt` read a workflow
    // validation body, and reading a 401 page as one reports it as an unparseable workflow.
    if (res.status === 401 || res.status === 403) {
      throw new KonteError("COMFYUI_UNAUTHORIZED", this.unauthorizedMessage(res.status));
    }

    if (!res.ok && !options?.allowErrorStatus) {
      const body = this.redactBody(await res.text().catch(() => ""));
      throw new KonteError(
        res.status >= 500 ? "COMFYUI_UNAVAILABLE" : "COMFYUI_ERROR",
        `ComfyUI API error (${res.status}): ${body || res.statusText}`,
      );
    }

    return res;
  }

  private unauthorizedMessage(status: number): string {
    const names = Object.keys(this.headerTemplates);
    return names.length === 0
      ? `ComfyUI at ${this.baseUrl} rejected the request (${status}) and konte sent no credentials. ` +
          `Set "comfy.comfyui.headers" in konte.config.json (or \`konte settings\`, Config tab).`
      : `ComfyUI at ${this.baseUrl} rejected the credentials in ${names.join(", ")} (${status}).`;
  }
}

// Bun names the code on the error itself, Node on its cause.
const NEVER_CONNECTED_CODES = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function neverConnected(err: unknown): boolean {
  const code = (e: unknown) =>
    typeof e === "object" && e !== null && "code" in e ? String(e.code) : undefined;
  const cause = err instanceof Error ? err.cause : undefined;
  return NEVER_CONNECTED_CODES.has(code(err) ?? code(cause) ?? "");
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

// ComfyUI's /prompt validation failures arrive as { error, node_errors }. Distill
// them into a readable multi-line message (including each node error's `details`,
// which carries the concrete cause such as "Invalid image file: ...") so the job's
// stored error and `job list` glimpse name the real problem.
function formatPromptErrors(data: ComfyUIPromptErrorBody): string | null {
  const lines: string[] = [];

  for (const [nodeId, nodeErr] of Object.entries(data.node_errors ?? {})) {
    const detail = nodeErr.errors
      .map((e) => (e.details ? `${e.message}: ${e.details}` : e.message))
      .join("; ");
    lines.push(`node ${nodeId} (${nodeErr.class_type}): ${detail}`);
  }

  if (lines.length === 0 && data.error) {
    const { message, details } = data.error;
    lines.push(details ? `${message}: ${details}` : message);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
