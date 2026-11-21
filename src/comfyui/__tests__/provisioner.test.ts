import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComfyProvisioner } from "../provisioner.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";

const FAST_TIMING = {
  reconnectDelaysMs: [1, 1, 1],
  pollIntervalMs: 1,
  maxBackoffMs: 4,
  safetyNetIntervalMs: 5,
  handshakeTimeoutMs: 50,
};

describe("ComfyProvisioner model auto-install", () => {
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
          send(404);
        });
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

  beforeEach(async () => {
    mock = await startManagerMock();
    mgrWs = await makeWorkspace({ videos: ["v1"] });
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

  function makeProvisioner(): ComfyProvisioner {
    return new ComfyProvisioner({
      baseUrl: mock.baseUrl,
      headers: {},
      autoInstallModels: true,
      autoInstallNodes: true,
      autoRebootAfterNodeInstall: true,
      unreachableTimeoutMs: 0,
      timing: FAST_TIMING,
    });
  }

  it("queues install via Manager when a model is missing", async () => {
    mock.objectInfoModels = []; // none installed
    mock.statusSequence = [
      { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false }, // pre-queue check: nothing pending
      { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
      { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    ];

    const outcome = await makeProvisioner().installModel(MODEL_DECL, MODEL_DECL.url);

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

    const outcome = await makeProvisioner().installModel(MODEL_DECL, MODEL_DECL.url);

    expect(outcome).toEqual({ kind: "alreadyPresent" });
    expect(mock.installRequests).toHaveLength(0);
  });

  it("names the custom_nodes directory when a pack the registry cannot resolve never arrives", async () => {
    // A fork's only route is a manual clone, so the failure has to name the directory konte
    // looks in.
    await expect(makeProvisioner().installNode({ id: "my-fork" })).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
      message: expect.stringContaining("custom_nodes/my-fork"),
    });
  });

  it("skips a pack already on disk under its id", async () => {
    mock.installedNodes = ["my-fork"];

    expect(await makeProvisioner().installNode({ id: "my-fork" })).toEqual({
      kind: "alreadyPresent",
    });
  });

  it("observes an already-queued install (a reclaim) instead of re-queueing", async () => {
    // Absent at the pre-install check, present once the already-in-flight download finishes.
    // A reclaimer sharing the job's client_id must observe that task, not queue a second one.
    mock.objectInfoModelsSequence = [[], ["x.safetensors"]];
    mock.statusSequence = [
      { total_count: 2, done_count: 0, in_progress_count: 1, is_processing: true }, // pre-queue check: work already pending
      { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    ];

    const outcome = await makeProvisioner().installModel(MODEL_DECL, MODEL_DECL.url);

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

    await expect(makeProvisioner().installModel(MODEL_DECL, MODEL_DECL.url)).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
    });
  });

  it("redacts the resolved token out of the Manager's failure text", async () => {
    // The Manager returns `Model installation error: {model_url}` — the URL it was handed, with
    // any ${VAR} already expanded. That text must not reach the job file with the secret in it.
    process.env.KTEST_HF_TOKEN = "hf_supersecret";
    try {
      const decl = {
        ...MODEL_DECL,
        url: "https://h.example/x.safetensors?t=${KTEST_HF_TOKEN}",
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

      const error = await makeProvisioner()
        .installModel(decl, "https://h.example/x.safetensors?t=hf_supersecret")
        .then(
          () => null,
          (e: Error) => e,
        );
      expect(error?.message).not.toContain("hf_supersecret");
      // Still names the URL it failed on, minus the query the secret rode in.
      expect(error?.message).toContain("https://h.example/x.safetensors");
    } finally {
      delete process.env.KTEST_HF_TOKEN;
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

    const provisioner = makeProvisioner();
    const outcome = await provisioner.installModel(
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
      await makeProvisioner().installModel(decl, decl.url, { onLog: () => {} });
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
      await makeProvisioner().installModel(
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
      await makeProvisioner().installModel(MODEL_DECL, MODEL_DECL.url, { onLog: () => {} });
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
    await makeProvisioner().installModel(
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

    const outcome = await makeProvisioner().installModel(
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
      await makeProvisioner().installModel(decl, decl.url, { onLog: () => {} });
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

    await expect(makeProvisioner().installModel(MODEL_DECL, MODEL_DECL.url)).resolves.toMatchObject(
      {
        kind: "installed",
      },
    );
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

    await expect(makeProvisioner().installModel(MODEL_DECL, MODEL_DECL.url)).rejects.toMatchObject({
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
    await expect(makeProvisioner().installModel(decl, decl.url)).resolves.toMatchObject({
      kind: "installed",
    });
  });

  it("throws COMFYUI_MANAGER_UNAVAILABLE when Manager is missing", async () => {
    mock.objectInfoModels = [];
    mock.managerAvailable = false;

    await expect(makeProvisioner().installModel(MODEL_DECL, MODEL_DECL.url)).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
      message: expect.stringContaining("https://docs.comfy.org/ja/manager/install"),
    });
  });
});

// activateNodes is the one path that REBOOTS the server, so its two refusals are the point: it
// must not reboot a ComfyUI it cannot inspect, and must not "wait for a reboot" it never made.
describe("ComfyProvisioner.activateNodes", () => {
  let srv: http.Server;
  let base: string;
  let rebootRequests: number;
  // What the mock answers with; each test sets the shape it needs.
  let importedPacks: string[] | "error";
  let systemStatsOk: boolean;

  beforeEach(async () => {
    rebootRequests = 0;
    importedPacks = [];
    systemStatsOk = true;
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
  });

  function makeProvisioner(): ComfyProvisioner {
    return new ComfyProvisioner({
      baseUrl: base,
      headers: {},
      autoInstallModels: true,
      autoInstallNodes: true,
      autoRebootAfterNodeInstall: true,
      unreachableTimeoutMs: 0,
      timing: FAST_TIMING,
    });
  }

  it("does not reboot when the packs are already loaded", async () => {
    importedPacks = ["pack-a"];

    await expect(makeProvisioner().activateNodes(["pack-a"])).resolves.toEqual({ rebooted: false });
    expect(rebootRequests).toBe(0);
  });

  it("refuses to reboot a ComfyUI whose Manager it cannot read", async () => {
    importedPacks = "error";

    await expect(makeProvisioner().activateNodes(["pack-a"])).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
      message: expect.stringContaining("Not rebooting a server konte cannot inspect"),
    });
    // The whole point: an unreadable Manager once meant "nothing is loaded", and this rebooted.
    expect(rebootRequests).toBe(0);
  });

  it("names a ComfyUI that is not answering instead of waiting out a reboot it never made", async () => {
    importedPacks = [];
    systemStatsOk = false;

    await expect(makeProvisioner().activateNodes(["pack-a"])).rejects.toMatchObject({
      code: "COMFYUI_UNAVAILABLE",
      message: expect.stringContaining("nothing to reboot"),
    });
    expect(rebootRequests).toBe(0);
  });
});
