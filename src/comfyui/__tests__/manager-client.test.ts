import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TransientPollError } from "../../core/poll-until-terminal.js";
import type { ComfyModelDeclaration } from "../../core/types/index.js";
import { ComfyUIHttpClient } from "../http-client.js";
import {
  collectNodePackIds,
  ComfyUIManagerClient,
  invertNodeMappings,
  parseManagerMajorVersion,
} from "../manager-client.js";

interface RecordedRequest {
  method: string;
  pathname: string;
  body: unknown;
}

interface MockHandlers {
  installResponse?: { status: number; body?: unknown };
  statusSequence?: Array<{
    total_count: number;
    done_count: number;
    in_progress_count: number;
    is_processing: boolean;
  }>;
  versionResponse?: { status: number };
  objectInfoModels?: string[];
  // folder_paths root → the files it lists; an absent root answers 404, as ComfyUI does.
  modelFiles?: Record<string, string[]>;
  // Number of upcoming /queue/status requests to answer with a transient 500 before
  // resuming the statusSequence — exercises polling resilience.
  statusFailures?: number;
  // Node-pack ids reported installed on disk (mode=default) and loaded at startup (mode=imported).
  installedDefault?: string[];
  installedImported?: string[];
  // Number of upcoming /customnode/installed requests to answer with a 500 — a Manager that has
  // not finished booting, or one that is simply not answering.
  installedFailures?: number;
  // class_type → [nodeClassNames[], metadata] mapping for /customnode/getmappings.
  mappings?: Record<string, [string[], unknown]>;
  nodeInstallResponse?: { status: number; body?: unknown };
  // Newest-first batch ids and their records; absent, both routes answer 404 as a pre-history
  // Manager does.
  historyBatches?: Array<{ id: string; batch: unknown }>;
  // ui_id → the live session's record of that task, as /queue/history?ui_id= serves it.
  sessionTasks?: Record<string, unknown>;
}

interface MockServer {
  server: http.Server;
  baseUrl: string;
  requests: RecordedRequest[];
}

async function startMockServer(handlers: MockHandlers): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  let statusCallCount = 0;
  let statusFailuresRemaining = handlers.statusFailures ?? 0;
  let installedFailuresRemaining = handlers.installedFailures ?? 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({
        method: req.method ?? "GET",
        pathname: url.pathname,
        body,
      });

      const respond = (status: number, payload?: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };

      if (url.pathname === "/api/v2/manager/version") {
        respond(handlers.versionResponse?.status ?? 200, { version: "V4.2.1" });
        return;
      }
      if (url.pathname === "/api/v2/manager/queue/install_model") {
        const r = handlers.installResponse ?? { status: 200 };
        respond(r.status, r.body ?? {});
        return;
      }
      if (url.pathname === "/api/v2/manager/queue/start") {
        respond(200, {});
        return;
      }
      if (url.pathname === "/api/v2/manager/queue/status") {
        if (statusFailuresRemaining > 0) {
          statusFailuresRemaining -= 1;
          respond(500, { error: "transient" });
          return;
        }
        const seq = handlers.statusSequence ?? [
          { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false },
        ];
        const next = seq[Math.min(statusCallCount, seq.length - 1)];
        statusCallCount += 1;
        respond(200, next);
        return;
      }
      if (url.pathname === "/api/v2/manager/queue/task") {
        const r = handlers.nodeInstallResponse ?? { status: 200 };
        respond(r.status, r.body ?? {});
        return;
      }
      if (url.pathname === "/api/v2/customnode/installed") {
        if (installedFailuresRemaining > 0) {
          installedFailuresRemaining -= 1;
          respond(500, { error: "manager still starting" });
          return;
        }
        const mode = url.searchParams.get("mode");
        const ids = mode === "imported" ? handlers.installedImported : handlers.installedDefault;
        // Shape: object keyed by pack id (the common Manager response form).
        const obj: Record<string, unknown> = {};
        for (const id of ids ?? []) obj[id] = { cnr_id: id, enabled: true };
        respond(200, obj);
        return;
      }
      if (url.pathname === "/api/v2/customnode/getmappings") {
        respond(200, handlers.mappings ?? {});
        return;
      }
      if (url.pathname === "/api/v2/manager/reboot") {
        respond(200, {});
        return;
      }
      if (url.pathname === "/api/v2/manager/queue/history_list") {
        if (!handlers.historyBatches) {
          respond(404);
          return;
        }
        respond(200, { ids: handlers.historyBatches.map((b) => b.id) });
        return;
      }
      if (url.pathname === "/api/v2/manager/queue/history") {
        const uiId = url.searchParams.get("ui_id");
        if (uiId !== null) {
          if (!handlers.sessionTasks) {
            respond(404);
            return;
          }
          respond(200, { history: handlers.sessionTasks[uiId] ?? {} });
          return;
        }
        const batch = handlers.historyBatches?.find((b) => b.id === url.searchParams.get("id"));
        if (!batch) {
          respond(404);
          return;
        }
        respond(200, batch.batch);
        return;
      }
      if (url.pathname.startsWith("/api/models/")) {
        const folder = decodeURIComponent(url.pathname.slice("/api/models/".length));
        const files = handlers.modelFiles?.[folder];
        if (files === undefined) {
          respond(404);
          return;
        }
        respond(200, files);
        return;
      }
      if (url.pathname === "/object_info") {
        const models = handlers.objectInfoModels ?? [];
        respond(200, {
          CheckpointLoaderSimple: {
            input: { required: { ckpt_name: [models] } },
            output: [],
            output_name: [],
          },
        });
        return;
      }
      respond(404);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        requests,
      });
    });
  });
}

async function stopMockServer(mock: MockServer): Promise<void> {
  await new Promise<void>((resolve) => mock.server.close(() => resolve()));
}

function newClient(baseUrl: string): ComfyUIManagerClient {
  const httpClient = new ComfyUIHttpClient(baseUrl);
  return new ComfyUIManagerClient(baseUrl, httpClient);
}

describe("ComfyUIManagerClient", () => {
  let mock: MockServer;

  afterEach(async () => {
    if (mock) await stopMockServer(mock);
  });

  describe("isAvailable", () => {
    it("returns true when /api/v2/manager/version responds 200", async () => {
      mock = await startMockServer({});
      const client = newClient(mock.baseUrl);
      expect(await client.isAvailable()).toBe(true);
    });

    it("returns false when manager is not installed (404)", async () => {
      mock = await startMockServer({ versionResponse: { status: 404 } });
      const client = newClient(mock.baseUrl);
      expect(await client.isAvailable()).toBe(false);
    });

    it("throws transient (not false) when the server is unreachable", async () => {
      mock = await startMockServer({});
      const url = mock.baseUrl;
      await stopMockServer(mock);
      const client = newClient(url);
      // A brief outage must not read as a definitive "not detected" — it surfaces transient so an
      // install job is left re-observable rather than failed.
      await expect(client.isAvailable()).rejects.toBeInstanceOf(TransientPollError);
      mock = undefined as unknown as MockServer;
    });
  });

  describe("getTaskOutcome", () => {
    const batch = (
      operations: Array<{ operation_id: string; result: string; error_message?: string }>,
      state: unknown,
    ) => [{ id: "batch_2", batch: { operations, state_before: state } }];

    it("returns the Manager's verdict for the queued ui_id", async () => {
      mock = await startMockServer({
        historyBatches: batch([{ operation_id: "konte-x.safetensors", result: "success" }], {
          security_level: "normal",
          network_mode: "personal_cloud",
          cli_args: { listen: "0.0.0.0" },
        }),
      });
      const client = newClient(mock.baseUrl);
      expect(await client.getTaskOutcome("konte-x.safetensors")).toEqual({ result: "success" });
    });

    it("names the closed gate term when a non-loopback listener is what denies installs", async () => {
      // A permissive security_level still denies a --listen 0.0.0.0 server whose network_mode is
      // not personal_cloud.
      mock = await startMockServer({
        historyBatches: batch([{ operation_id: "konte-pack", result: "failed" }], {
          security_level: "normal",
          network_mode: "public",
          cli_args: { listen: "0.0.0.0" },
        }),
      });
      const client = newClient(mock.baseUrl);
      const outcome = await client.getTaskOutcome("konte-pack");
      expect(outcome?.result).toBe("failed");
      expect(outcome?.denialHint).toContain("0.0.0.0");
      expect(outcome?.denialHint).toContain("personal_cloud");
    });

    it("names security_level when the listener is fine but the level is not", async () => {
      mock = await startMockServer({
        historyBatches: batch([{ operation_id: "konte-pack", result: "failed" }], {
          security_level: "strong",
          network_mode: "public",
          cli_args: { listen: "127.0.0.1" },
        }),
      });
      const client = newClient(mock.baseUrl);
      expect((await client.getTaskOutcome("konte-pack"))?.denialHint).toContain("strong");
    });

    it("names both gate terms when both are closed", async () => {
      mock = await startMockServer({
        historyBatches: batch([{ operation_id: "konte-pack", result: "failed" }], {
          security_level: "strong",
          network_mode: "public",
          cli_args: { listen: "0.0.0.0" },
        }),
      });
      const hint = (await newClient(mock.baseUrl).getTaskOutcome("konte-pack"))?.denialHint;
      expect(hint).toContain("personal_cloud");
      expect(hint).toContain("strong");
    });

    it("does not blame a listener anywhere in 127.0.0.0/8", async () => {
      // The Manager's own test is Python's is_loopback, which takes the whole /8.
      mock = await startMockServer({
        historyBatches: batch([{ operation_id: "konte-pack", result: "failed" }], {
          security_level: "normal",
          network_mode: "public",
          cli_args: { listen: "127.0.0.2" },
        }),
      });
      expect(
        (await newClient(mock.baseUrl).getTaskOutcome("konte-pack"))?.denialHint,
      ).toBeUndefined();
    });

    it("prefers the session record, which carries the failure text the batch drops", async () => {
      mock = await startMockServer({
        sessionTasks: {
          "konte-pack": {
            result: "Node 'pack@nightly' not found in [default, cache]",
            status: { status_str: "error", completed: true, messages: [] },
          },
        },
        historyBatches: batch([{ operation_id: "konte-pack", result: "failed" }], {
          security_level: "strong",
          network_mode: "public",
          cli_args: { listen: "127.0.0.1" },
        }),
      });
      const outcome = await newClient(mock.baseUrl).getTaskOutcome("konte-pack");
      expect(outcome?.result).toBe("error");
      expect(outcome?.errorMessage).toContain("not found in [default, cache]");
      // The batch is still what knows the server state.
      expect(outcome?.denialHint).toContain("strong");
    });

    it("returns null for an unknown ui_id, and for a Manager with no history routes", async () => {
      // Best-effort: callers keep their observation-based verdict rather than inventing one.
      mock = await startMockServer({
        historyBatches: batch([{ operation_id: "konte-other", result: "failed" }], undefined),
      });
      expect(await newClient(mock.baseUrl).getTaskOutcome("konte-pack")).toBeNull();
      await stopMockServer(mock);

      mock = await startMockServer({});
      expect(await newClient(mock.baseUrl).getTaskOutcome("konte-pack")).toBeNull();
    });
  });

  describe("isModelAvailable / probeModel", () => {
    const model = (filename: string, savePath?: string): ComfyModelDeclaration => ({
      filename,
      type: "checkpoint",
      url: `https://h.example/${filename}`,
      ...(savePath !== undefined ? { savePath } : {}),
    });

    it("returns true when filename is present in any COMBO field", async () => {
      mock = await startMockServer({ objectInfoModels: ["a.safetensors", "b.safetensors"] });
      const client = newClient(mock.baseUrl);
      expect(await client.isModelAvailable(model("b.safetensors"))).toBe(true);
      expect(await client.probeModel(model("b.safetensors"))).toBe("present");
    });

    it("reports absent when a savePath-less filename is not in any combo", async () => {
      // With no savePath the combo scan IS the observation, so a miss witnesses absence.
      mock = await startMockServer({ objectInfoModels: ["a.safetensors"] });
      const client = newClient(mock.baseUrl);
      expect(await client.isModelAvailable(model("z.safetensors"))).toBe(false);
      expect(await client.probeModel(model("z.safetensors"))).toBe("absent");
    });

    it("falls back to the savePath listing for a model no combo exposes", async () => {
      // A directory-shaped model (loaded by path, never offered as a combo choice) is only
      // observable through /api/models/<root>.
      mock = await startMockServer({
        objectInfoModels: [],
        modelFiles: { TTS: ["Qwen3-TTS/CustomVoice/config.json"] },
      });
      const client = newClient(mock.baseUrl);
      const present = model("config.json", "TTS/Qwen3-TTS/CustomVoice");
      expect(await client.isModelAvailable(present)).toBe(true);
      expect(await client.probeModel(present)).toBe("present");

      // Same filename under a sibling savePath is a different install target, and the listing
      // names another .json, so it could have witnessed this one.
      const absent = model("config.json", "TTS/Qwen3-TTS/CustomVoice/speech_tokenizer");
      expect(await client.isModelAvailable(absent)).toBe(false);
      expect(await client.probeModel(absent)).toBe("absent");
    });

    it("does not let a same-named combo entry stand in for a savePath target", async () => {
      // `model.safetensors` sits in half the loader combos; a hit there says nothing about
      // whether this install target is filled, so the known root's listing decides alone.
      mock = await startMockServer({
        objectInfoModels: ["model.safetensors"],
        modelFiles: { TTS: ["qwen/other.safetensors"] },
      });
      const client = newClient(mock.baseUrl);
      expect(await client.probeModel(model("model.safetensors", "TTS/qwen"))).toBe("absent");
    });

    it("reports unobservable for a file the served folder's extensions exclude", async () => {
      // A node pack registers its folder with a weights-only extension set (ZONOS2 does), so the
      // listing can never name its config/tokenizer sidecars — a miss there is not an absence.
      mock = await startMockServer({
        objectInfoModels: [],
        modelFiles: { zonos2: ["zonos2-bf16.safetensors", "dac_44khz/model.safetensors"] },
      });
      const client = newClient(mock.baseUrl);
      expect(await client.probeModel(model("config.json", "zonos2/dac_44khz"))).toBe(
        "unobservable",
      );
      // A weight the same listing does cover is still witnessed as absent.
      expect(await client.probeModel(model("missing.safetensors", "zonos2"))).toBe("absent");
    });

    it("reports unobservable for an empty served folder", async () => {
      // An empty listing exposes no registered extension, so it cannot witness anything — konte
      // downloads (pre-check) and declines to call the install failed (post-check).
      mock = await startMockServer({ objectInfoModels: [], modelFiles: { zonos2: [] } });
      const client = newClient(mock.baseUrl);
      expect(await client.probeModel(model("zonos2-bf16.safetensors", "zonos2"))).toBe(
        "unobservable",
      );
      expect(await client.isModelAvailable(model("zonos2-bf16.safetensors", "zonos2"))).toBe(false);
    });

    it("falls back to the combo scan for a root ComfyUI does not serve", async () => {
      // An unknown root means konte cannot observe that path at all — not that it is empty.
      mock = await startMockServer({ objectInfoModels: ["m.safetensors"], modelFiles: {} });
      const client = newClient(mock.baseUrl);
      expect(await client.probeModel(model("m.safetensors", "CUSTOM/sub"))).toBe("present");
      expect(await client.probeModel(model("other.safetensors", "CUSTOM/sub"))).toBe(
        "unobservable",
      );
    });

    it("isModelAvailable swallows an unreachable server to false; probeModel throws transient", async () => {
      mock = await startMockServer({ objectInfoModels: ["a.safetensors"] });
      const url = mock.baseUrl;
      await stopMockServer(mock);
      const client = newClient(url);
      // The tolerant pre-check assumes "absent → queue a download"; the strict post-check must not
      // conflate "couldn't observe" with "absent" — it surfaces transient so the install re-observes.
      expect(await client.isModelAvailable(model("a.safetensors"))).toBe(false);
      await expect(client.probeModel(model("a.safetensors"))).rejects.toBeInstanceOf(
        TransientPollError,
      );
      mock = undefined as unknown as MockServer;
    });
  });

  describe("queueInstall", () => {
    it("posts the canonical Manager body", async () => {
      mock = await startMockServer({});
      const client = newClient(mock.baseUrl);
      await client.queueInstall({
        model: {
          filename: "model.safetensors",
          type: "checkpoint",
          url: "ignored-by-client",
          savePath: "checkpoints/SDXL",
          base: "SDXL",
          displayName: "SDXL Base 1.0",
        },
        resolvedUrl: "https://h.example/model.safetensors",
        uiId: "konte-job-1",
      });

      const installReq = mock.requests.find(
        (r) => r.pathname === "/api/v2/manager/queue/install_model",
      );
      expect(installReq?.method).toBe("POST");
      expect(installReq?.body).toMatchObject({
        url: "https://h.example/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoint",
        save_path: "checkpoints/SDXL",
        base: "SDXL",
        name: "SDXL Base 1.0",
        ui_id: "konte-job-1",
      });
      // V4 requires client_id; the client supplies its own ComfyUI client id.
      expect(typeof (installReq?.body as { client_id?: unknown })?.client_id).toBe("string");
    });

    it("defaults name to filename and ui_id to konte-<filename> when not provided", async () => {
      mock = await startMockServer({});
      const client = newClient(mock.baseUrl);
      await client.queueInstall({
        model: { filename: "a.safetensors", type: "lora", url: "u" },
        resolvedUrl: "https://h.example/a.safetensors",
      });
      const installReq = mock.requests.find(
        (r) => r.pathname === "/api/v2/manager/queue/install_model",
      );
      expect(installReq?.body).toMatchObject({
        save_path: "default",
        name: "a.safetensors",
        ui_id: "konte-a.safetensors",
      });
    });

    it("throws COMFYUI_MANAGER_UNAVAILABLE on non-2xx", async () => {
      mock = await startMockServer({ installResponse: { status: 403, body: { error: "denied" } } });
      const client = newClient(mock.baseUrl);
      await expect(
        client.queueInstall({
          model: { filename: "a.safetensors", type: "lora", url: "u" },
          resolvedUrl: "u",
        }),
      ).rejects.toMatchObject({ code: "COMFYUI_MANAGER_UNAVAILABLE" });
    });
  });

  describe("waitForQueueCompletion", () => {
    it("returns once total_count (remaining) reaches 0, counting against expectedTotal", async () => {
      // V4 reports total_count as remaining work, so it shrinks toward 0.
      mock = await startMockServer({
        statusSequence: [
          { total_count: 2, done_count: 0, in_progress_count: 2, is_processing: true },
          { total_count: 1, done_count: 1, in_progress_count: 1, is_processing: true },
          { total_count: 0, done_count: 2, in_progress_count: 0, is_processing: false },
        ],
      });
      const client = newClient(mock.baseUrl);
      const logs: string[] = [];
      await client.waitForQueueCompletion({
        expectedTotal: 2,
        pollIntervalMs: 10,
        timeoutMs: 30_000,
        onLog: (m) => logs.push(m),
      });
      // progress should have been reported at least twice (once at start, once at done)
      expect(logs.some((l) => l.includes("1/2"))).toBe(true);
      expect(logs.some((l) => l.includes("2/2"))).toBe(true);
    });

    it("keeps polling through transient status failures and still completes", async () => {
      mock = await startMockServer({
        statusFailures: 3,
        statusSequence: [
          { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
        ],
      });
      const client = newClient(mock.baseUrl);

      const result = await client.waitForQueueCompletion({
        expectedTotal: 1,
        pollIntervalMs: 10,
        timeoutMs: 30_000,
      });

      expect(result.kind).toBe("done");
    });

    it("stops with cancelled when shouldCancel fires", async () => {
      mock = await startMockServer({
        statusSequence: [
          { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
        ],
      });
      const client = newClient(mock.baseUrl);

      const result = await client.waitForQueueCompletion({
        expectedTotal: 1,
        pollIntervalMs: 10,
        timeoutMs: 30_000,
        shouldCancel: () => true,
      });

      expect(result.kind).toBe("cancelled");
    });

    it("returns timedOut (never throws) when polling exceeds the deadline", async () => {
      mock = await startMockServer({
        statusSequence: [
          { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
        ],
      });
      const client = newClient(mock.baseUrl);
      const result = await client.waitForQueueCompletion({
        expectedTotal: 1,
        pollIntervalMs: 10,
        timeoutMs: 50,
      });
      expect(result.kind).toBe("timedOut");
    });
  });

  describe("filterMissingNodes", () => {
    it("returns only the cnr_ids not installed on disk", async () => {
      mock = await startMockServer({ installedDefault: ["pack-a", "pack-b"] });
      const client = newClient(mock.baseUrl);
      expect(await client.filterMissingNodes(["pack-a", "pack-c"])).toEqual({
        missing: ["pack-c"],
        confirmed: true,
      });
    });

    it("reports every id missing when the manager is unreachable", async () => {
      mock = await startMockServer({});
      const url = mock.baseUrl;
      await stopMockServer(mock);
      const client = newClient(url);
      expect(await client.filterMissingNodes(["pack-a", "pack-b"])).toEqual({
        missing: ["pack-a", "pack-b"],
        // Reported missing so an offline run still queues installs — but flagged as unobserved,
        // which is what stops a completed install record being retired on it.
        confirmed: false,
      });
      // avoid afterEach double-close
      mock = undefined as unknown as MockServer;
    });
  });

  describe("filterUnloadedNodes", () => {
    it("returns installed packs not present in the startup (imported) snapshot", async () => {
      mock = await startMockServer({
        installedDefault: ["pack-a", "pack-b"],
        installedImported: ["pack-a"],
      });
      const client = newClient(mock.baseUrl);
      // pack-b is on disk but was not loaded at startup → needs a reboot.
      expect(await client.filterUnloadedNodes(["pack-a", "pack-b"])).toEqual({
        kind: "known",
        unloaded: ["pack-b"],
      });
    });

    // The caller reboots on "unloaded", so a Manager that says nothing must not be read as one
    // saying "nothing is loaded" — that conflation is what rebooted servers konte could not see.
    it("reports an unanswerable Manager as unobservable, not as everything unloaded", async () => {
      mock = await startMockServer({ installedFailures: 1 });
      const client = newClient(mock.baseUrl);

      const result = await client.filterUnloadedNodes(["pack-a"]);

      expect(result.kind).toBe("unobservable");
    });

    // The core server answers /system_stats before the Manager answers its own routes, so the
    // post-reboot check must outlast that gap or it reads a booting server as a failed import.
    it("re-polls a still-booting Manager within its settle window", async () => {
      mock = await startMockServer({
        installedDefault: ["pack-a"],
        installedImported: ["pack-a"],
        installedFailures: 1,
      });
      const client = newClient(mock.baseUrl);

      const result = await client.filterUnloadedNodes(["pack-a"], { settleMs: 30_000 });

      expect(result).toEqual({ kind: "known", unloaded: [] });
    });
  });

  describe("queueInstallNode", () => {
    it("posts a registry install body (id + latest version)", async () => {
      mock = await startMockServer({});
      const client = newClient(mock.baseUrl);
      await client.queueInstallNode({ node: { id: "pack-a" }, uiId: "konte-pack-a" });
      const req = mock.requests.find((r) => r.pathname === "/api/v2/manager/queue/task");
      expect(req?.method).toBe("POST");
      expect(req?.body).toMatchObject({
        kind: "install",
        ui_id: "konte-pack-a",
        params: { id: "pack-a", version: "latest", selected_version: "latest" },
      });
      expect(typeof (req?.body as { client_id?: unknown })?.client_id).toBe("string");
    });

    it("throws COMFYUI_MANAGER_UNAVAILABLE on non-2xx", async () => {
      mock = await startMockServer({ nodeInstallResponse: { status: 403 } });
      const client = newClient(mock.baseUrl);
      await expect(client.queueInstallNode({ node: { id: "pack-a" } })).rejects.toMatchObject({
        code: "COMFYUI_MANAGER_UNAVAILABLE",
      });
    });
  });

  describe("resolveClassToPack", () => {
    it("maps a workflow's class_types to their pack ids, skipping core classes", async () => {
      mock = await startMockServer({
        mappings: {
          "comfy-foo": [["FooLoader", "FooSampler"], {}],
          "comfy-bar": [["BarNode"], {}],
        },
      });
      const client = newClient(mock.baseUrl);
      const result = await client.resolveClassToPack(["FooLoader", "BarNode", "KSampler"]);
      expect(result.get("FooLoader")).toBe("comfy-foo");
      expect(result.get("BarNode")).toBe("comfy-bar");
      // KSampler has no mapping (a core class) → omitted.
      expect(result.has("KSampler")).toBe(false);
    });
  });
});

describe("collectNodePackIds", () => {
  it("collects object keys and nested cnr_id/aux_id/id fields", () => {
    const ids = collectNodePackIds({
      "ComfyUI-Foo": { cnr_id: "comfy-foo", enabled: true },
      "some-dir": { aux_id: "owner/repo" },
    });
    expect(ids).toEqual(new Set(["ComfyUI-Foo", "comfy-foo", "some-dir", "owner/repo"]));
  });

  it("returns an empty set for non-objects", () => {
    expect(collectNodePackIds(null).size).toBe(0);
    expect(collectNodePackIds("nope").size).toBe(0);
  });
});

describe("invertNodeMappings", () => {
  it("inverts pack → [classNames] into className → pack", () => {
    const map = invertNodeMappings({
      "comfy-foo": [["FooLoader", "FooSampler"], { title_aux: "Foo" }],
      "comfy-bar": [["BarNode"], {}],
    });
    expect(map.get("FooLoader")).toBe("comfy-foo");
    expect(map.get("FooSampler")).toBe("comfy-foo");
    expect(map.get("BarNode")).toBe("comfy-bar");
  });

  it("keeps the first pack when a class appears in several", () => {
    const map = invertNodeMappings({
      "pack-1": [["Shared"], {}],
      "pack-2": [["Shared"], {}],
    });
    expect(map.get("Shared")).toBe("pack-1");
  });
});

describe("parseManagerMajorVersion", () => {
  it("extracts the major with or without a leading V", () => {
    expect(parseManagerMajorVersion("V4.2.1")).toBe(4);
    expect(parseManagerMajorVersion("4.0.0")).toBe(4);
    expect(parseManagerMajorVersion("v3.31")).toBe(3);
    expect(parseManagerMajorVersion("V10.0.0")).toBe(10);
    expect(parseManagerMajorVersion("  V4.2.1  ")).toBe(4);
  });

  it("returns null when no leading numeric major is present", () => {
    expect(parseManagerMajorVersion("nightly")).toBeNull();
    expect(parseManagerMajorVersion("")).toBeNull();
  });
});
