import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GenerationRequest } from "../../core/backend.js";
import type { GenerationJob } from "../../core/types/index.js";
import { ComfyUIBackend } from "../backend.js";
import type { ComfyUIHistoryEntry } from "../types.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { VideoRoots } from "../../core/roots.js";

// A generation job record for submit(); ComfyUIBackend.submit only reads it via the interface,
// so the fields default to an empty just-created "queued" job unless overridden.
function makeJobRecord(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    kind: "generation",
    id: "v001",
    address: "video:shot.01.firstFrame",
    variantId: "v001",
    status: "queued",
    backendKind: "comfy",
    backendJobId: null,
    submissionStartedAt: null,
    progress: null,
    error: null,
    outputFiles: [],
    metadata: {},
    dependsOnAssets: [],
    dependsOnJobs: [],
    lease: null,
    provenance: {
      workflowHash: null,
      inputHash: null,
      resolvedDependencies: {},
      compositionCacheKeys: {},
    },
    createdAt: new Date().toISOString(),
    startedAt: null,
    processingStartedAt: null,
    updatedAt: new Date().toISOString(),
    completedAt: null,
    unconfirmedSince: null,
    sourceFingerprint: null,
    staleReleases: 0,
    ...overrides,
  };
}

// The waiters' cadence, shrunk to microseconds so a test isn't paying real reconnect/poll
// wall-clock. reconnectDelaysMs keeps its length at 3 to preserve the WS→polling fallback path.
const FAST_TIMING = {
  reconnectDelaysMs: [1, 1, 1],
  pollIntervalMs: 1,
  maxBackoffMs: 4,
  safetyNetIntervalMs: 5,
  handshakeTimeoutMs: 50,
};

let server: http.Server;
let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;
let backend: ComfyUIBackend;

let currentHistoryEntry: ComfyUIHistoryEntry;
let currentNodeErrors: Record<string, unknown> = {};
let lastQueuedPrompt: Record<string, unknown> | null = null;
// Number of upcoming /history requests the mock should answer with a transient 500
// before resuming normal responses — used to exercise polling resilience.
let historyFailuresRemaining = 0;
const uploadedFiles: { filename: string; data: Buffer }[] = [];

const runningHistoryEntry: ComfyUIHistoryEntry = {
  outputs: {},
  status: { status_str: "", completed: false, messages: [] },
};

const mockHistoryEntry: ComfyUIHistoryEntry = {
  outputs: {
    "9": {
      images: [{ filename: "output_00001_.png", subfolder: "", type: "output" }],
    },
  },
  status: {
    status_str: "success",
    completed: true,
    messages: [],
  },
};

function createMockComfyUI(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname === "/prompt" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            lastQueuedPrompt = JSON.parse(body) as Record<string, unknown>;
          } catch {
            lastQueuedPrompt = null;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              prompt_id: "test-prompt-id",
              number: 1,
              node_errors: currentNodeErrors,
            }),
          );
        });
        return;
      }

      if (url.pathname === "/upload/image" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          const contentType = req.headers["content-type"] ?? "";
          const boundaryMatch = contentType.match(/boundary=(.+)/);
          let filename = "uploaded.png";
          if (boundaryMatch) {
            const bodyStr = rawBody.toString("latin1");
            const filenameMatch = bodyStr.match(/filename="([^"]+)"/);
            if (filenameMatch) filename = filenameMatch[1]!;
          }
          uploadedFiles.push({ filename, data: rawBody });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ name: filename, subfolder: "", type: "input" }));
        });
        return;
      }

      if (url.pathname.startsWith("/history/")) {
        if (historyFailuresRemaining > 0) {
          historyFailuresRemaining -= 1;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end("transient boom");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        const promptId = url.pathname.split("/").pop() ?? "";
        res.end(JSON.stringify({ [promptId]: currentHistoryEntry }));
        return;
      }

      if (url.pathname === "/queue") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
        return;
      }

      if (url.pathname === "/view") {
        res.writeHead(200);
        res.end(Buffer.from("fake-output-data"));
        return;
      }

      if (url.pathname === "/interrupt" && req.method === "POST") {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    srv.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

beforeAll(async () => {
  server = await createMockComfyUI();
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  currentHistoryEntry = mockHistoryEntry;
  currentNodeErrors = {};
  lastQueuedPrompt = null;
  historyFailuresRemaining = 0;
  uploadedFiles.length = 0;

  // A real two-root fixture: the workflow is a workspace-wide adapter, while every file the
  // backend reads or writes belongs to one video under videos/. This is the only place the two
  // roots genuinely differ, so it is the regression test for the split.
  ws = await makeWorkspace({ videos: ["v1"] });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
  const workflowDir = path.join(roots.workspace, "adapters", "comfy");
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(
    path.join(workflowDir, "animate.json"),
    JSON.stringify({
      "3": {
        class_type: "KSampler",
        inputs: { seed: 0, steps: 20 },
      },
      "9": {
        class_type: "SaveImage",
        inputs: { filename_prefix: "output", images: ["8", 0] },
      },
    }),
    "utf-8",
  );

  const addr = server.address() as { port: number };
  backend = new ComfyUIBackend(
    {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      headers: {},
      autoInstallModels: false,
      autoInstallNodes: false,
      autoRebootAfterNodeInstall: false,
      unreachableTimeoutMs: 0,
      timing: FAST_TIMING,
    },
    roots,
  );
});

afterEach(async () => {
  await ws.cleanup();
});

describe("ComfyUIBackend", () => {
  it(
    "strips a traversal in the output filename, writing inside outputDir",
    { timeout: 15_000 },
    async () => {
      currentHistoryEntry = {
        outputs: {
          "9": {
            images: [{ filename: "../../../evil.png", subfolder: "", type: "output" }],
          },
        },
        status: { status_str: "success", completed: true, messages: [] },
      };

      const outputDir = path.join(tmpDir, "output");
      const result = await backend.waitForCompletion("test-prompt-id", outputDir);

      expect(result.kind).toBe("done");
      if (result.kind !== "done") throw new Error("expected done");
      expect(result.result.files).toEqual([path.join(outputDir, "evil.png")]);
      await expect(fs.access(path.join(tmpDir, "evil.png"))).rejects.toThrow();
    },
  );

  it("submits a job and returns prompt_id", async () => {
    const request: GenerationRequest = {
      address: "video:shot.01.firstFrame",
      assetDefinition: {
        kind: "comfy",
        workflow: "animate.json",
        inputs: {},
      },
      variantId: "v001",
      outputDir: path.join(tmpDir, "output"),
      resolvedDependencies: {},
    };

    const promptId = await backend.submit(request, makeJobRecord(), 42);
    expect(promptId).toBe("test-prompt-id");
  });

  it("waitForCompletion returns immediately for completed jobs", { timeout: 15_000 }, async () => {
    const outputDir = path.join(tmpDir, "output");

    const result = await backend.waitForCompletion("test-prompt-id", outputDir);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("expected done");
    expect(result.result.files).toHaveLength(1);
    expect(result.result.files[0]).toContain("output_00001_.png");
    expect(result.result.metadata.promptId).toBe("test-prompt-id");
  });

  it("waitForCompletion calls onLog callback", { timeout: 15_000 }, async () => {
    const outputDir = path.join(tmpDir, "output");
    const logs: string[] = [];

    await backend.waitForCompletion("test-prompt-id", outputDir, {
      onLog: (line) => logs.push(line),
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("Completed"))).toBe(true);
  });

  // The WebSocket-evicted path (no /ws on the mock → polling fallback): the prompt is seen in
  // queue_running with no history and no progress event, yet execution-start must still be
  // reported so processingStartedAt gets stamped. Regression guard for the not-executing
  // misdiagnosis where a running job looked forever un-started.
  it("reports execution start from queue_running even with no progress event", async () => {
    let historyCalls = 0;
    const srv = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (url.pathname === "/queue") {
          res.writeHead(200, { "Content-Type": "application/json" });
          // Our prompt is actively running in the queue.
          res.end(JSON.stringify({ queue_running: [[1, "run-me"]], queue_pending: [] }));
        } else if (url.pathname.startsWith("/history/")) {
          historyCalls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          // Absent while running, then completes (no outputs → nothing to download) so the
          // waiter finishes.
          const done = {
            "run-me": {
              outputs: {},
              status: { status_str: "success", completed: true, messages: [] },
            },
          };
          res.end(historyCalls >= 3 ? JSON.stringify(done) : "{}");
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      // Bun's http server leaves an unhandled upgrade hanging; refuse it so the wait falls to polling.
      s.on("upgrade", (_req, socket) => socket.destroy());
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const addr = srv.address() as { port: number };
      const b = new ComfyUIBackend(
        {
          baseUrl: `http://127.0.0.1:${addr.port}`,
          headers: {},
          autoInstallModels: false,
          autoInstallNodes: false,
          autoRebootAfterNodeInstall: false,
          unreachableTimeoutMs: 0,
          timing: FAST_TIMING,
        },
        roots,
      );

      let executionStarts = 0;
      let progressTicks = 0;
      const result = await b.waitForCompletion("run-me", path.join(tmpDir, "output-runme"), {
        onExecutionStarted: () => {
          executionStarts += 1;
        },
        onProgress: () => {
          progressTicks += 1;
        },
      });

      expect(result.kind).toBe("done");
      expect(executionStarts).toBeGreaterThan(0);
      expect(progressTicks).toBe(0);
    } finally {
      srv.close();
    }
  });

  // The opening fast-path check specifically: only the FIRST history read (that check) is
  // running; the polling loop's first read is already success, so it never observes running.
  // This isolates the fast-path fire — remove it and executionStarts drops to 0.
  it("reports execution start from the opening running-history check", async () => {
    let historyCalls = 0;
    const srv = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (url.pathname === "/queue") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
        } else if (url.pathname.startsWith("/history/")) {
          historyCalls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          // Call 1 = the fast-path check (running). Call 2+ = the polling loop (success), so
          // the polling path never sees running and can't be the source of the fire.
          const running = {
            "run-me": { outputs: {}, status: { status_str: "", completed: false, messages: [] } },
          };
          const done = {
            "run-me": {
              outputs: {},
              status: { status_str: "success", completed: true, messages: [] },
            },
          };
          res.end(JSON.stringify(historyCalls >= 2 ? done : running));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      // Bun's http server leaves an unhandled upgrade hanging; refuse it so the wait falls to polling.
      s.on("upgrade", (_req, socket) => socket.destroy());
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const addr = srv.address() as { port: number };
      const b = new ComfyUIBackend(
        {
          baseUrl: `http://127.0.0.1:${addr.port}`,
          headers: {},
          autoInstallModels: false,
          autoInstallNodes: false,
          autoRebootAfterNodeInstall: false,
          unreachableTimeoutMs: 0,
          timing: FAST_TIMING,
        },
        roots,
      );

      let executionStarts = 0;
      let progressTicks = 0;
      const result = await b.waitForCompletion("run-me", path.join(tmpDir, "output-runhist"), {
        onExecutionStarted: () => {
          executionStarts += 1;
        },
        onProgress: () => {
          progressTicks += 1;
        },
      });

      expect(result.kind).toBe("done");
      // Exactly one fire, from the fast-path check — the polling loop only ever saw success.
      expect(executionStarts).toBe(1);
      expect(progressTicks).toBe(0);
    } finally {
      srv.close();
    }
  });

  it(
    "waitForCompletion throws with error details on failed jobs",
    { timeout: 15_000 },
    async () => {
      currentHistoryEntry = {
        ...mockHistoryEntry,
        status: {
          status_str: "error",
          completed: false,
          messages: [
            [
              "execution_error",
              {
                node_id: "3",
                exception_type: "RuntimeError",
                exception_message: "CUDA out of memory",
              },
            ],
          ],
        },
      };

      const outputDir = path.join(tmpDir, "output");

      await expect(backend.waitForCompletion("test-prompt-id", outputDir)).rejects.toMatchObject({
        code: "COMFYUI_ERROR",
        message: expect.stringContaining("RuntimeError"),
      });
    },
  );

  it(
    "keeps polling through transient status failures and still completes",
    { timeout: 20_000 },
    async () => {
      // WS is forced to fail (upgrade → 400), so this exercises the polling fallback.
      // The first few /history calls 500; the job must not be failed by that.
      historyFailuresRemaining = 3;
      const outputDir = path.join(tmpDir, "output");

      const result = await backend.waitForCompletion("test-prompt-id", outputDir);

      expect(result.kind).toBe("done");
      if (result.kind !== "done") throw new Error("expected done");
      expect(result.result.files).toHaveLength(1);
      expect(historyFailuresRemaining).toBe(0);
    },
  );

  it(
    "stops with timedOut on the waiter deadline — never throwing, never marking failed",
    { timeout: 20_000 },
    async () => {
      // History stays "running" forever; the waiter's timeout must yield a non-terminal
      // timedOut (still running) as a returned value, not a COMFYUI_ERROR failure.
      currentHistoryEntry = runningHistoryEntry;
      const outputDir = path.join(tmpDir, "output");

      const result = await backend.waitForCompletion("test-prompt-id", outputDir, { timeoutMs: 1 });
      expect(result).toEqual({ kind: "timedOut" });
    },
  );

  it("cancels a job", async () => {
    await expect(backend.cancel("test-prompt-id")).resolves.toBeUndefined();
  });

  it(
    "cancel throws JOB_NOT_FOUND when job is not in queue or history",
    { timeout: 15_000 },
    async () => {
      currentHistoryEntry = null as unknown as ComfyUIHistoryEntry;

      const mockServerWithEmptyHistory = await new Promise<http.Server>((resolve) => {
        const srv = http.createServer((_req, res) => {
          const url = new URL(_req.url ?? "/", `http://${_req.headers.host}`);
          if (url.pathname === "/queue") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
          } else if (url.pathname.startsWith("/history/")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({}));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        srv.listen(0, "127.0.0.1", () => resolve(srv));
      });

      try {
        const addr = mockServerWithEmptyHistory.address() as { port: number };
        const testBackend = new ComfyUIBackend(
          {
            baseUrl: `http://127.0.0.1:${addr.port}`,
            headers: {},
            autoInstallModels: false,
            autoInstallNodes: false,
            autoRebootAfterNodeInstall: false,
            unreachableTimeoutMs: 0,
            timing: FAST_TIMING,
          },
          roots,
        );

        await expect(testBackend.cancel("nonexistent-job")).rejects.toMatchObject({
          code: "JOB_NOT_FOUND",
        });
      } finally {
        mockServerWithEmptyHistory.close();
      }
    },
  );

  it("interrupts a running prompt only while it is still ours", async () => {
    let interrupts = 0;
    const srv = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => {
        const url = new URL(_req.url ?? "/", `http://${_req.headers.host}`);
        if (url.pathname === "/queue") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ queue_running: [[1, "mine"]], queue_pending: [] }));
        } else if (url.pathname === "/interrupt") {
          interrupts += 1;
          res.writeHead(200);
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const addr = srv.address() as { port: number };
      const b = new ComfyUIBackend(
        {
          baseUrl: `http://127.0.0.1:${addr.port}`,
          headers: {},
          autoInstallModels: false,
          autoInstallNodes: false,
          autoRebootAfterNodeInstall: false,
          unreachableTimeoutMs: 0,
          timing: FAST_TIMING,
        },
        roots,
      );
      await b.cancel("mine");
      expect(interrupts).toBe(1);
    } finally {
      srv.close();
    }
  });

  it("does not interrupt when the running prompt changed before the interrupt", async () => {
    let interrupts = 0;
    let queueCalls = 0;
    const srv = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => {
        const url = new URL(_req.url ?? "/", `http://${_req.headers.host}`);
        if (url.pathname === "/queue") {
          // First read: our prompt runs. The pre-interrupt re-check sees an unrelated prompt
          // now holding the GPU, so cancel must NOT fire the global interrupt.
          const running = queueCalls === 0 ? [[1, "mine"]] : [[2, "someone-else"]];
          queueCalls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ queue_running: running, queue_pending: [] }));
        } else if (url.pathname === "/interrupt") {
          interrupts += 1;
          res.writeHead(200);
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const addr = srv.address() as { port: number };
      const b = new ComfyUIBackend(
        {
          baseUrl: `http://127.0.0.1:${addr.port}`,
          headers: {},
          autoInstallModels: false,
          autoInstallNodes: false,
          autoRebootAfterNodeInstall: false,
          unreachableTimeoutMs: 0,
          timing: FAST_TIMING,
        },
        roots,
      );
      await b.cancel("mine");
      expect(interrupts).toBe(0);
      expect(queueCalls).toBe(2);
    } finally {
      srv.close();
    }
  });

  it("queuePrompt throws on node_errors", async () => {
    currentNodeErrors = {
      "5": {
        errors: [
          {
            type: "value_not_in_list",
            message: "Invalid sampler name",
            details: "",
            extra_info: {},
          },
        ],
        dependent_outputs: [],
        class_type: "KSampler",
      },
    };

    const request: GenerationRequest = {
      address: "video:shot.01.firstFrame",
      assetDefinition: {
        kind: "comfy",
        workflow: "animate.json",
        inputs: {},
      },
      variantId: "v001",
      outputDir: path.join(tmpDir, "output"),
      resolvedDependencies: {},
    };

    await expect(backend.submit(request, makeJobRecord(), 42)).rejects.toMatchObject({
      code: "COMFYUI_ERROR",
      message: expect.stringContaining("Workflow validation failed"),
    });
  });

  it("uploads resolved dependency files and injects uploaded names into workflow", async () => {
    // The workflow is a workspace adapter; the dependency file it consumes is the video's.
    const workflowDir = path.join(roots.workspace, "adapters", "comfy");
    await fs.writeFile(
      path.join(workflowDir, "i2v.json"),
      JSON.stringify({
        "3": {
          class_type: "KSampler",
          inputs: { seed: 0, steps: 20 },
        },
        "10": {
          class_type: "LoadImage",
          inputs: { image: "__konte:video:shot.01.keyframe__" },
        },
        "9": {
          class_type: "SaveImage",
          inputs: { filename_prefix: "output", images: ["8", 0] },
        },
      }),
      "utf-8",
    );

    const depDir = path.join(tmpDir, "assets");
    await fs.mkdir(depDir, { recursive: true });
    await fs.writeFile(path.join(depDir, "keyframe.png"), "fake-image-data", "utf-8");

    const request: GenerationRequest = {
      address: "video:shot.01.motion",
      assetDefinition: {
        kind: "comfy",
        workflow: "i2v.json",
        inputs: { "10.image": "__konte:video:shot.01.keyframe__" },
      },
      variantId: "v001",
      outputDir: path.join(tmpDir, "output"),
      resolvedDependencies: {
        "video:shot.01.keyframe": path.join(depDir, "keyframe.png"),
      },
    };

    await backend.submit(request, makeJobRecord({ address: "video:shot.01.motion" }), 42);

    expect(uploadedFiles).toHaveLength(1);
    expect(uploadedFiles[0]!.filename).toMatch(/^konte-keyframe-[0-9a-f]{8}\.png$/);

    const prompt = lastQueuedPrompt as Record<string, unknown>;
    const workflow = prompt.prompt as Record<string, { inputs: Record<string, unknown> }>;
    expect(workflow["10"]!.inputs.image).toMatch(/^konte-keyframe-[0-9a-f]{8}\.png$/);
  });

  it("throws INVALID_ASSET_TYPE for non-comfy assets", async () => {
    const request: GenerationRequest = {
      address: "video:shot.01.bg",
      assetDefinition: {
        kind: "file",
        path: "assets/files/ocean.mp4",
      },
      variantId: "v001",
      outputDir: path.join(tmpDir, "output"),
      resolvedDependencies: {},
    };

    await expect(backend.submit(request, makeJobRecord(), 42)).rejects.toMatchObject({
      code: "INVALID_ASSET_TYPE",
    });
  });
});

describe("ComfyUIBackend model auto-install", () => {
  interface ManagerMock {
    server: http.Server;
    baseUrl: string;
    installRequests: Array<Record<string, unknown>>;
    objectInfoModels: string[];
    // When set, /object_info returns these model lists by call index (clamped to the last),
    // overriding objectInfoModels — used to model a download that finishes mid-run (empty at the
    // pre-install check, present at the post-install verification).
    objectInfoModelsSequence?: string[][];
    managerAvailable: boolean;
    // When true, a queued install makes its model appear in /object_info (a
    // successful download). When false, the queue empties but the model stays
    // missing — a failed download (404, expired token, …).
    installAddsModel: boolean;
    statusSequence: Array<{
      total_count: number;
      done_count: number;
      in_progress_count: number;
      is_processing: boolean;
    }>;
    // The newest batch record the Manager's queue history serves. Unset, both history routes
    // answer 404, as a pre-history Manager does.
    historyBatch?: unknown;
    // What /api/experiment/models reports. Unset, the route 404s as a ComfyUI without it does.
    modelFolders?: Array<{ name: string; folders: string[]; extensions: string[] }>;
    // Makes `/api/models/<root>` read somewhere other than the directory `/api/experiment/models`
    // advertised — a server whose reported path is not the one it actually reads.
    listingDirOverride?: Record<string, string>;
    // Serve this many model listings, then fail every one after.
    failListingsAfter?: number;
    // Node-pack ids /customnode/installed reports on disk.
    installedNodes: string[];
  }

  function startManagerMock(): Promise<ManagerMock> {
    return new Promise((resolve) => {
      const state: ManagerMock = {
        server: undefined as unknown as http.Server,
        baseUrl: "",
        installRequests: [],
        objectInfoModels: [],
        managerAvailable: true,
        installAddsModel: true,
        installedNodes: [],
        statusSequence: [
          { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false },
        ],
      };
      let statusCallCount = 0;
      let objectInfoCallCount = 0;
      let listingCallCount = 0;

      const srv = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          const send = (status: number, payload?: unknown): void => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(payload === undefined ? "" : JSON.stringify(payload));
          };

          if (url.pathname === "/api/v2/manager/version") {
            send(state.managerAvailable ? 200 : 404, { version: "V4.2.1" });
            return;
          }
          if (url.pathname === "/api/v2/manager/queue/install_model") {
            const body = raw ? JSON.parse(raw) : {};
            state.installRequests.push(body);
            if (state.installAddsModel && typeof body.filename === "string") {
              state.objectInfoModels.push(body.filename);
            }
            send(200, {});
            return;
          }
          if (url.pathname === "/api/v2/manager/queue/start") {
            send(200, {});
            return;
          }
          if (url.pathname === "/api/v2/manager/queue/status") {
            const next =
              state.statusSequence[Math.min(statusCallCount, state.statusSequence.length - 1)];
            statusCallCount += 1;
            send(200, next);
            return;
          }
          if (url.pathname === "/api/v2/manager/queue/task") {
            send(200, {});
            return;
          }
          if (url.pathname === "/api/v2/customnode/installed") {
            send(200, Object.fromEntries(state.installedNodes.map((id) => [id, {}])));
            return;
          }
          if (url.pathname === "/api/v2/manager/queue/history_list") {
            if (state.historyBatch === undefined) {
              send(404, {});
              return;
            }
            send(200, { ids: ["batch_1"] });
            return;
          }
          if (url.pathname === "/api/v2/manager/queue/history") {
            if (state.historyBatch === undefined) {
              send(404, {});
              return;
            }
            send(200, state.historyBatch);
            return;
          }
          // Reads the real directory the folder listing points at, as ComfyUI does.
          if (url.pathname.startsWith("/api/models/")) {
            listingCallCount += 1;
            if (
              state.failListingsAfter !== undefined &&
              listingCallCount > state.failListingsAfter
            ) {
              send(500);
              return;
            }
            const root = decodeURIComponent(url.pathname.slice("/api/models/".length));
            const dir =
              state.listingDirOverride?.[root] ??
              state.modelFolders?.find((f) => f.name === root)?.folders[0];
            if (dir === undefined) {
              send(404);
              return;
            }
            fs.readdir(dir)
              .catch(() => [] as string[])
              .then((names) => send(200, names));
            return;
          }
          if (url.pathname === "/api/experiment/models") {
            if (state.modelFolders === undefined) {
              send(404);
              return;
            }
            send(200, state.modelFolders);
            return;
          }
          // Stands in for the model host konte downloads from.
          if (url.pathname.startsWith("/dl/")) {
            const body = Buffer.from("weights");
            res.writeHead(200, { "Content-Length": String(body.length) });
            res.end(body);
            return;
          }
          if (url.pathname === "/object_info") {
            const models = state.objectInfoModelsSequence
              ? state.objectInfoModelsSequence[
                  Math.min(objectInfoCallCount, state.objectInfoModelsSequence.length - 1)
                ]
              : state.objectInfoModels;
            objectInfoCallCount += 1;
            send(200, {
              CheckpointLoaderSimple: {
                input: { required: { ckpt_name: [models] } },
                output: [],
                output_name: [],
              },
            });
            return;
          }
          if (url.pathname === "/prompt" && req.method === "POST") {
            send(200, { prompt_id: "manager-prompt-id", number: 1, node_errors: {} });
            return;
          }
          if (url.pathname.startsWith("/history/")) {
            send(200, {
              "manager-prompt-id": {
                prompt: [1, "manager-prompt-id", {}, {}, []],
                outputs: {
                  "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] },
                },
                status: { status_str: "success", completed: true, messages: [] },
              },
            });
            return;
          }
          if (url.pathname === "/view") {
            res.writeHead(200);
            res.end(Buffer.from("img"));
            return;
          }
          send(404);
        });
      });

      srv.on("upgrade", (_req, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });

      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as { port: number };
        state.server = srv;
        state.baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve(state);
      });
    });
  }

  let mock: ManagerMock;
  let mgrWs: Workspace;
  let mgrRoots: VideoRoots;

  beforeEach(async () => {
    mock = await startManagerMock();
    mgrWs = await makeWorkspace({ videos: ["v1"] });
    mgrRoots = mgrWs.videos.v1!;
    await fs.mkdir(path.join(mgrWs.root, "adapters", "comfy"), { recursive: true });
    await fs.writeFile(
      path.join(mgrWs.root, "adapters", "comfy", "m.json"),
      JSON.stringify({
        "9": {
          class_type: "SaveImage",
          inputs: { filename_prefix: "out", images: ["8", 0] },
        },
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    await mgrWs.cleanup();
  });

  const MODEL_DECL = {
    filename: "x.safetensors",
    type: "checkpoint" as const,
    url: "https://h.example/x.safetensors",
  };

  function makeBackend(): ComfyUIBackend {
    return new ComfyUIBackend(
      {
        baseUrl: mock.baseUrl,
        headers: {},
        autoInstallModels: true,
        autoInstallNodes: true,
        autoRebootAfterNodeInstall: true,
        unreachableTimeoutMs: 0,
        timing: FAST_TIMING,
      },
      mgrRoots,
    );
  }

  it("queues install via Manager when a model is missing", async () => {
    mock.objectInfoModels = []; // none installed
    mock.statusSequence = [
      { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false }, // pre-queue check: nothing pending
      { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
      { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    ];

    const outcome = await makeBackend().installModel(MODEL_DECL, MODEL_DECL.url);

    expect(outcome).toEqual({ kind: "installed" });
    expect(mock.installRequests).toHaveLength(1);
    expect(mock.installRequests[0]).toMatchObject({
      filename: "x.safetensors",
      url: "https://h.example/x.safetensors",
      type: "checkpoint",
    });
  });

  it("skips install when the model is already available", async () => {
    mock.objectInfoModels = ["x.safetensors"];

    const outcome = await makeBackend().installModel(MODEL_DECL, MODEL_DECL.url);

    expect(outcome).toEqual({ kind: "alreadyPresent" });
    expect(mock.installRequests).toHaveLength(0);
  });

  it("names the custom_nodes directory when a pack the registry cannot resolve never arrives", async () => {
    // A fork's only route is a manual clone, so the failure has to name the directory konte
    // looks in.
    await expect(makeBackend().installNode({ id: "my-fork" })).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
      message: expect.stringContaining("custom_nodes/my-fork"),
    });
  });

  it("skips a pack already on disk under its id", async () => {
    mock.installedNodes = ["my-fork"];

    expect(await makeBackend().installNode({ id: "my-fork" })).toEqual({ kind: "alreadyPresent" });
  });

  it("observes an already-queued install (a reclaim) instead of re-queueing", async () => {
    // Absent at the pre-install check, present once the already-in-flight download finishes.
    // A reclaimer sharing the job's client_id must observe that task, not queue a second one.
    mock.objectInfoModelsSequence = [[], ["x.safetensors"]];
    mock.statusSequence = [
      { total_count: 2, done_count: 0, in_progress_count: 1, is_processing: true }, // pre-queue check: work already pending
      { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    ];

    const outcome = await makeBackend().installModel(MODEL_DECL, MODEL_DECL.url);

    expect(outcome).toEqual({ kind: "installed" });
    expect(mock.installRequests).toHaveLength(0); // observed, never re-queued
  });

  it("throws when the queue empties but the model is still missing (failed download)", async () => {
    mock.objectInfoModels = [];
    mock.installAddsModel = false; // download "completes" but never produces the file
    mock.statusSequence = [
      { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false }, // pre-queue check
      { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
      { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    ];

    await expect(makeBackend().installModel(MODEL_DECL, MODEL_DECL.url)).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
    });
  });

  it("redacts the resolved token out of the Manager's failure text", async () => {
    // The Manager returns `Model installation error: {model_url}` — the URL it was handed, with
    // any ${VAR} already expanded. That text must not reach the job file with the secret in it.
    process.env.KONTE_TEST_HF_TOKEN = "hf_supersecret";
    try {
      const decl = {
        ...MODEL_DECL,
        url: "https://h.example/x.safetensors?t=${KONTE_TEST_HF_TOKEN}",
      };
      mock.objectInfoModels = [];
      mock.installAddsModel = false;
      mock.statusSequence = [
        { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false },
        { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
      ];
      mock.historyBatch = {
        operations: [
          {
            operation_id: "konte-x.safetensors",
            result: "Model installation error: https://h.example/x.safetensors?t=hf_supersecret",
          },
        ],
        state_before: null,
      };

      const error = await makeBackend()
        .installModel(decl, "https://h.example/x.safetensors?t=hf_supersecret")
        .then(
          () => null,
          (e: Error) => e,
        );
      expect(error?.message).not.toContain("hf_supersecret");
      // Still names the URL it failed on, minus the query the secret rode in.
      expect(error?.message).toContain("https://h.example/x.safetensors");
    } finally {
      delete process.env.KONTE_TEST_HF_TOKEN;
    }
  });

  it("downloads the model itself when ComfyUI's model directory is writable", async () => {
    const dir = path.join(mgrWs.root, "comfy-models", "checkpoints");
    await fs.mkdir(path.dirname(dir), { recursive: true });
    mock.modelFolders = [{ name: "checkpoints", folders: [dir], extensions: [".safetensors"] }];
    mock.objectInfoModels = [];
    // Nothing appears in /object_info, so a Manager-driven install would fail its strict probe;
    // succeeding here proves the local path was taken.
    mock.installAddsModel = false;

    const backend = makeBackend();
    const outcome = await backend.installModel(
      { ...MODEL_DECL, url: `${mock.baseUrl}/dl/x.safetensors` },
      `${mock.baseUrl}/dl/x.safetensors`,
      { onLog: () => {} },
    );

    expect(outcome).toEqual({ kind: "installed" });
    expect(await fs.readFile(path.join(dir, "x.safetensors"), "utf-8")).toBe("weights");
    // The Manager was never asked to do it.
    expect(mock.installRequests).toHaveLength(0);
  });

  // "The directory was writable" is not evidence that it is ComfyUI's directory — a remote server
  // can report a path that happens to exist here.
  it("fails when ComfyUI does not list what konte just wrote", async () => {
    const reported = path.join(mgrWs.root, "reported-but-not-read");
    const actuallyRead = path.join(mgrWs.root, "what-comfy-really-reads");
    await fs.mkdir(actuallyRead, { recursive: true });
    mock.modelFolders = [{ name: "checkpoints", folders: [reported], extensions: [] }];
    mock.listingDirOverride = { checkpoints: actuallyRead };
    mock.installAddsModel = false;
    const decl = { ...MODEL_DECL, url: `${mock.baseUrl}/dl/x.safetensors` };

    let message = "";
    try {
      await makeBackend().installModel(decl, decl.url, { onLog: () => {} });
    } catch (err) {
      message = (err as Error).message;
    }
    // The bytes did land — konte just refuses to call that an install ComfyUI can use.
    expect(await fs.readFile(path.join(reported, "x.safetensors"), "utf-8")).toBe("weights");
    expect(message).toContain("does not list it");
    expect(message).toContain("comfyui.url");
  });

  // A listing that came back without the model is evidence of a wrong destination; a later
  // attempt failing to reach the server must not erase it.
  it("keeps a confirmed absence even when a later listing attempt cannot be made", async () => {
    const reported = path.join(mgrWs.root, "reported-but-not-read");
    const actuallyRead = path.join(mgrWs.root, "what-comfy-really-reads");
    await fs.mkdir(actuallyRead, { recursive: true });
    mock.modelFolders = [{ name: "checkpoints", folders: [reported], extensions: [] }];
    mock.listingDirOverride = { checkpoints: actuallyRead };
    mock.installAddsModel = false;
    // The first listing answers (and lacks the file); every one after it fails.
    mock.failListingsAfter = 1;

    let message = "";
    try {
      await makeBackend().installModel(
        { ...MODEL_DECL, url: `${mock.baseUrl}/dl/x.safetensors` },
        `${mock.baseUrl}/dl/x.safetensors`,
        { onLog: () => {} },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("does not list it");
  });

  it("keeps the reported path from executing when pasted into a shell", async () => {
    mock.modelFolders = [
      { name: "checkpoints", folders: ["/models/$(rm -rf ~)/checkpoints"], extensions: [] },
    ];
    mock.objectInfoModels = [];
    mock.installAddsModel = false;

    let message = "";
    try {
      await makeBackend().installModel(MODEL_DECL, MODEL_DECL.url, { onLog: () => {} });
    } catch (err) {
      message = (err as Error).message;
    }
    // Single-quoted, so the substitution is inert text rather than a command the user runs.
    expect(message).toContain(`-o '/models/$(rm -rf ~)/checkpoints/x.safetensors'`);
  });

  it("reports byte progress while downloading locally", async () => {
    const dir = path.join(mgrWs.root, "comfy-models", "checkpoints");
    await fs.mkdir(path.dirname(dir), { recursive: true });
    mock.modelFolders = [{ name: "checkpoints", folders: [dir], extensions: [".safetensors"] }];
    mock.installAddsModel = false;

    const seen: Array<{ received: number; total: number | null }> = [];
    await makeBackend().installModel(
      { ...MODEL_DECL, url: `${mock.baseUrl}/dl/x.safetensors` },
      `${mock.baseUrl}/dl/x.safetensors`,
      { onLog: () => {}, onBytes: (p) => seen.push(p) },
    );

    expect(seen.at(-1)).toEqual({ received: 7, total: 7 });
  });

  it("falls back to the Manager when the reported directory is out of reach", async () => {
    // A ComfyUI on a host konte shares no filesystem with: real over there, unreachable here.
    mock.modelFolders = [
      { name: "checkpoints", folders: ["\\\\remote-host\\models\\checkpoints"], extensions: [] },
    ];
    mock.objectInfoModels = [];

    const outcome = await makeBackend().installModel(
      MODEL_DECL,
      "https://h.example/x.safetensors",
      {
        onLog: () => {},
      },
    );

    expect(outcome).toEqual({ kind: "installed" });
    expect(mock.installRequests).toHaveLength(1);
  });

  it("names the exact destination and command when the Manager could not install it", async () => {
    mock.modelFolders = [
      { name: "checkpoints", folders: ["C:\\ComfyUI\\models\\checkpoints"], extensions: [] },
    ];
    mock.objectInfoModels = [];
    mock.installAddsModel = false;

    const decl = {
      ...MODEL_DECL,
      url: "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/x.safetensors",
    };
    // toLocalPath maps this to a /mnt/c/... that does not exist here, so the Manager takes it
    // and fails — which is where the guidance must appear.
    let message = "";
    try {
      await makeBackend().installModel(decl, decl.url, { onLog: () => {} });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("C:\\ComfyUI\\models\\checkpoints\\x.safetensors");
    expect(message).toContain("Authorization: Bearer $HF_TOKEN");
    expect(message).toContain(decl.url);
  });

  it("keeps a model that is present, whatever a same-named history entry says", async () => {
    // ui_id names a target rather than an attempt, so the newest batch can hold an older failure
    // for one that has since arrived.
    mock.objectInfoModels = [];
    mock.statusSequence = [
      { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false },
      { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    ];
    mock.historyBatch = {
      operations: [{ operation_id: "konte-x.safetensors", result: "failed" }],
      state_before: null,
    };

    await expect(makeBackend().installModel(MODEL_DECL, MODEL_DECL.url)).resolves.toMatchObject({
      kind: "installed",
    });
  });

  it("fails with the Manager's reason when its queue history says the task was denied", async () => {
    // The Manager's install routes answer 200 and its queue empties normally even when the task
    // worker refused the work, so the history is the only place the denial exists.
    mock.objectInfoModels = [];
    mock.installAddsModel = false;
    mock.statusSequence = [
      { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false },
      { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
      { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    ];
    mock.historyBatch = {
      operations: [{ operation_id: "konte-x.safetensors", result: "failed", error_message: null }],
      state_before: {
        security_level: "normal",
        network_mode: "public",
        cli_args: { listen: "0.0.0.0" },
      },
    };

    await expect(makeBackend().installModel(MODEL_DECL, MODEL_DECL.url)).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
      message: expect.stringContaining("personal_cloud"),
    });
  });

  it("accepts an install ComfyUI exposes no listing for, rather than failing it", async () => {
    // A savePath root ComfyUI does not serve leaves konte with nothing that could witness the
    // file, so "not found" is not evidence the download failed.
    mock.objectInfoModels = [];
    mock.installAddsModel = false;
    mock.statusSequence = [
      { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false }, // pre-queue check
      { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
      { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    ];

    const decl = { ...MODEL_DECL, filename: "config.json", savePath: "zonos2/dac_44khz" };
    await expect(makeBackend().installModel(decl, decl.url)).resolves.toMatchObject({
      kind: "installed",
    });
  });

  it("throws COMFYUI_MANAGER_UNAVAILABLE when Manager is missing", async () => {
    mock.objectInfoModels = [];
    mock.managerAvailable = false;

    await expect(makeBackend().installModel(MODEL_DECL, MODEL_DECL.url)).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
      message: expect.stringContaining("https://docs.comfy.org/ja/manager/install"),
    });
  });
});

// activateNodes is the one path that REBOOTS the server, so its two refusals are the point: it
// must not reboot a ComfyUI it cannot inspect, and must not "wait for a reboot" it never made.
describe("ComfyUIBackend.activateNodes", () => {
  let srv: http.Server;
  let base: string;
  let nodeWs: Workspace;
  let rebootRequests: number;
  // What the mock answers with; each test sets the shape it needs.
  let importedPacks: string[] | "error";
  let systemStatsOk: boolean;

  beforeEach(async () => {
    rebootRequests = 0;
    importedPacks = [];
    systemStatsOk = true;
    nodeWs = await makeWorkspace({ videos: ["v1"] });
    srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/system_stats") {
        send(systemStatsOk ? 200 : 500, {});
        return;
      }
      if (url.pathname === "/api/v2/customnode/installed") {
        if (importedPacks === "error") {
          send(500, { error: "manager not up" });
          return;
        }
        const obj: Record<string, unknown> = {};
        for (const id of importedPacks) obj[id] = { cnr_id: id, enabled: true };
        send(200, obj);
        return;
      }
      if (url.pathname === "/api/v2/manager/reboot") {
        rebootRequests += 1;
        send(200, {});
        return;
      }
      send(404, {});
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    await nodeWs.cleanup();
  });

  function makeBackend(): ComfyUIBackend {
    return new ComfyUIBackend(
      {
        baseUrl: base,
        headers: {},
        autoInstallModels: true,
        autoInstallNodes: true,
        autoRebootAfterNodeInstall: true,
        unreachableTimeoutMs: 0,
        timing: FAST_TIMING,
      },
      nodeWs.videos.v1!,
    );
  }

  it("does not reboot when the packs are already loaded", async () => {
    importedPacks = ["pack-a"];

    await expect(makeBackend().activateNodes(["pack-a"])).resolves.toEqual({ rebooted: false });
    expect(rebootRequests).toBe(0);
  });

  it("refuses to reboot a ComfyUI whose Manager it cannot read", async () => {
    importedPacks = "error";

    await expect(makeBackend().activateNodes(["pack-a"])).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
      message: expect.stringContaining("Not rebooting a server konte cannot inspect"),
    });
    // The whole point: an unreadable Manager once meant "nothing is loaded", and this rebooted.
    expect(rebootRequests).toBe(0);
  });

  it("names a ComfyUI that is not answering instead of waiting out a reboot it never made", async () => {
    importedPacks = [];
    systemStatsOk = false;

    await expect(makeBackend().activateNodes(["pack-a"])).rejects.toMatchObject({
      code: "COMFYUI_UNAVAILABLE",
      message: expect.stringContaining("nothing to reboot"),
    });
    expect(rebootRequests).toBe(0);
  });
});

describe("ComfyUIBackend.waitForCompletion when ComfyUI is unreachable", () => {
  let deadWs: Workspace;
  let deadUrl: string;

  beforeEach(async () => {
    deadWs = await makeWorkspace({ videos: ["v1"] });
    // Bind then close, so the port is one nothing answers on.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    deadUrl = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  afterEach(async () => {
    await deadWs.cleanup();
  });

  function makeBackend(unreachableTimeoutMs: number): ComfyUIBackend {
    return new ComfyUIBackend(
      {
        baseUrl: deadUrl,
        headers: {},
        autoInstallModels: false,
        autoInstallNodes: false,
        autoRebootAfterNodeInstall: false,
        unreachableTimeoutMs,
        timing: FAST_TIMING,
      },
      deadWs.videos.v1!,
    );
  }

  // The seven-hour wait: a prompt lives in the ComfyUI process, so a server that answers nothing
  // has taken it with it. Orphan detection can't help — it only counts absence a REACHABLE server
  // confirms — so without this ceiling the waiter polls a corpse forever.
  it("fails the prompt rather than polling forever", async () => {
    await expect(
      makeBackend(1).waitForCompletion("p-1", path.join(deadWs.root, "out")),
    ).rejects.toMatchObject({
      code: "COMFYUI_UNAVAILABLE",
      message: expect.stringContaining("comfyui.unreachableTimeoutMinutes"),
    });
  });

  it("keeps polling when the ceiling is disabled (0)", async () => {
    const wait = makeBackend(0).waitForCompletion("p-2", path.join(deadWs.root, "out"));
    const raced = await Promise.race([
      wait.then(() => "settled").catch(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("still polling"), 300)),
    ]);
    expect(raced).toBe("still polling");
  });
});
