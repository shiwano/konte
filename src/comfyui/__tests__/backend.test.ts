import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationRequest } from "../../core/backend.js";
import { KonteError } from "../../core/errors.js";
import { TransientPollError } from "../../core/poll-until-terminal.js";
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
    comfyTarget: null,
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
    reportedAt: null,
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
let pendingPromptIds: string[] = [];
let deletedPromptIds: string[] = [];
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

      if (url.pathname === "/queue" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          deletedPromptIds.push(...(JSON.parse(body) as { delete: string[] }).delete);
          res.writeHead(200);
          res.end();
        });
        return;
      }

      if (url.pathname === "/queue") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            queue_running: [],
            queue_pending: pendingPromptIds.map((id, i) => [i, id, {}, {}, []]),
          }),
        );
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
  pendingPromptIds = [];
  deletedPromptIds = [];
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

    const submitted = await backend.submit(request, makeJobRecord(), 42);
    expect(submitted).toEqual({
      backendJobId: "test-prompt-id",
      metadata: { comfyClientId: backend.httpClient.clientId },
    });
  });

  it("does not queue a prompt for a job cancelled while it was prepared", async () => {
    await expect(
      backend.submit(
        {
          address: "video:shot.01.firstFrame",
          assetDefinition: { kind: "comfy", workflow: "animate.json", inputs: {} },
          variantId: "v001",
          outputDir: path.join(tmpDir, "output"),
          resolvedDependencies: {},
          shouldCancel: async () => true,
        },
        makeJobRecord(),
        42,
      ),
    ).rejects.toMatchObject({ code: "SUBMIT_CANCELLED" });
    expect(lastQueuedPrompt).toBeNull();
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

  it("leaves a finished prompt re-observable when its output cannot be fetched", async () => {
    const download = vi
      .spyOn(backend.httpClient, "downloadOutputToFile")
      .mockRejectedValue(new KonteError("COMFYUI_UNAVAILABLE", "ComfyUI API error (503)"));

    await expect(
      backend.waitForCompletion("test-prompt-id", path.join(tmpDir, "output")),
    ).rejects.toBeInstanceOf(TransientPollError);

    download.mockRejectedValue(new KonteError("COMFYUI_ERROR", "ComfyUI API error (404)"));
    await expect(
      backend.waitForCompletion("test-prompt-id", path.join(tmpDir, "output")),
    ).rejects.not.toBeInstanceOf(TransientPollError);
    download.mockRestore();
  });

  it("leaves a finished prompt re-observable when its credential is refused", async () => {
    const download = vi
      .spyOn(backend.httpClient, "downloadOutputToFile")
      .mockRejectedValue(new KonteError("COMFYUI_UNAUTHORIZED", "ComfyUI rejected (401)"));

    await expect(
      backend.waitForCompletion("test-prompt-id", path.join(tmpDir, "output")),
    ).rejects.toBeInstanceOf(TransientPollError);
    download.mockRestore();
  });

  it("fails a prompt that succeeded with no output", async () => {
    currentHistoryEntry = { ...mockHistoryEntry, outputs: {} };

    await expect(
      backend.waitForCompletion("test-prompt-id", path.join(tmpDir, "output-empty")),
    ).rejects.toMatchObject({ code: "COMFYUI_ERROR" });
  });

  it("keeps same-named outputs from different subfolders apart", async () => {
    currentHistoryEntry = {
      ...mockHistoryEntry,
      outputs: {
        "9": { images: [{ filename: "x_00001_.png", subfolder: "a", type: "output" }] },
        "10": { images: [{ filename: "x_00001_.png", subfolder: "b", type: "output" }] },
      },
    };

    const result = await backend.waitForCompletion(
      "test-prompt-id",
      path.join(tmpDir, "output-collide"),
    );

    if (result.kind !== "done") throw new Error("expected done");
    expect(new Set(result.result.files).size).toBe(2);
  });

  it("takes a saved output over a preview node's temp file", async () => {
    currentHistoryEntry = {
      ...mockHistoryEntry,
      outputs: {
        "5": { images: [{ filename: "preview_00001_.png", subfolder: "", type: "temp" }] },
        "9": { images: [{ filename: "output_00001_.png", subfolder: "", type: "output" }] },
      },
    };

    const result = await backend.waitForCompletion("test-prompt-id", path.join(tmpDir, "o-saved"));

    if (result.kind !== "done") throw new Error("expected done");
    expect(result.result.files.map((f) => path.basename(f))).toEqual(["output_00001_.png"]);
  });

  it("takes a preview node's temp file from a workflow that saves nothing", async () => {
    currentHistoryEntry = {
      ...mockHistoryEntry,
      outputs: {
        "5": { images: [{ filename: "preview_00001_.png", subfolder: "", type: "temp" }] },
      },
    };

    const result = await backend.waitForCompletion("test-prompt-id", path.join(tmpDir, "o-temp"));

    if (result.kind !== "done") throw new Error("expected done");
    expect(result.result.files.map((f) => path.basename(f))).toEqual(["preview_00001_.png"]);
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
          // Absent while running, then completes with no outputs, so the waiter finishes
          // without a download.
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
      await expect(
        b.waitForCompletion("run-me", path.join(tmpDir, "output-runme"), {
          onExecutionStarted: () => {
            executionStarts += 1;
          },
          onProgress: () => {
            progressTicks += 1;
          },
        }),
      ).rejects.toMatchObject({ code: "COMFYUI_ERROR" });
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
      await expect(
        b.waitForCompletion("run-me", path.join(tmpDir, "output-runhist"), {
          onExecutionStarted: () => {
            executionStarts += 1;
          },
          onProgress: () => {
            progressTicks += 1;
          },
        }),
      ).rejects.toMatchObject({ code: "COMFYUI_ERROR" });
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

  it("cancels a prompt ComfyUI queued with some outputs rejected", async () => {
    pendingPromptIds = ["test-prompt-id"];
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
      message: expect.stringContaining("konte cancelled it"),
      items: [expect.stringContaining("node 5 (KSampler): Invalid sampler name")],
    });
    expect(deletedPromptIds).toEqual(["test-prompt-id"]);
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
    expect(uploadedFiles[0]!.data.includes("fake-image-data")).toBe(true);

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

describe("ComfyUIBackend.waitForCompletion when ComfyUI refuses the credential", () => {
  let ws: Workspace;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    ws = await makeWorkspace({ videos: ["v1"] });
    server = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end("unauthorized");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ws.cleanup();
  });

  it("keeps polling the prompt past the unreachable ceiling", async () => {
    const backend = new ComfyUIBackend(
      {
        baseUrl,
        headers: {},
        autoInstallModels: false,
        autoInstallNodes: false,
        autoRebootAfterNodeInstall: false,
        unreachableTimeoutMs: 1,
        timing: FAST_TIMING,
      },
      ws.videos.v1!,
    );
    const result = await backend.waitForCompletion("p-1", path.join(ws.root, "out"), {
      timeoutMs: 300,
    });
    expect(result.kind).toBe("timedOut");
  });
});
