import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JobManager } from "../../core/job-manager.js";
import {
  ctx,
  doctorCheck,
  doctorChecks,
  useTempWorkspace,
  writeWorkspaceConfig,
  initWithTestVideo,
  initWithNoBackendVideo,
  run,
  runCapture,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("doctor command (ComfyUI-Manager)", () => {
  // Mock ComfyUI server: /system_stats lets the connection check pass, /queue
  // backs the queue check, and /api/v2/manager/version toggles Manager presence.
  function startMockComfyUI(managerInstalled: boolean): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (url.pathname === "/api/v2/manager/version") {
          res.writeHead(managerInstalled ? 200 : 404, { "Content-Type": "text/plain" });
          res.end(managerInstalled ? "V4.2.1" : "");
          return;
        }
        if (url.pathname === "/queue") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
          return;
        }
        if (url.pathname === "/system_stats") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              devices: [
                {
                  name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync",
                  type: "cuda",
                  vram_total: 24 * 1024 ** 3,
                  vram_free: 12 * 1024 ** 3,
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
  }

  async function setup(managerInstalled: boolean, autoInstallModels: boolean) {
    const projectDir = await initWithTestVideo();
    const mock = await startMockComfyUI(managerInstalled);
    await writeWorkspaceConfig(projectDir, { comfyui: { url: mock.baseUrl, autoInstallModels } });
    return { projectDir, mock };
  }

  const managerCheck = (projectDir: string) => doctorCheck(projectDir, "ComfyUI-Manager");

  it("surfaces the GPU and VRAM on the connection check", async () => {
    const { projectDir, mock } = await setup(true, true);
    try {
      const connection = await doctorCheck(projectDir, "ComfyUI connection");
      expect(connection?.status).toBe("PASS");
      expect(connection?.message).toContain("NVIDIA GeForce RTX 4090");
      expect(connection?.message).toContain("VRAM 12.0/24.0 GB free");
    } finally {
      await mock.close();
    }
  });

  it("passes when ComfyUI-Manager is installed", async () => {
    const { projectDir, mock } = await setup(true, true);
    try {
      expect((await managerCheck(projectDir))?.status).toBe("PASS");
    } finally {
      await mock.close();
    }
  });

  it("fails when Manager is missing and autoInstallModels is true", async () => {
    const { projectDir, mock } = await setup(false, true);
    try {
      const check = await managerCheck(projectDir);
      expect(check?.status).toBe("FAIL");
      expect(check?.message).toContain("autoInstallModels");
    } finally {
      await mock.close();
    }
  });

  it("warns when Manager is missing and autoInstallModels is false", async () => {
    const { projectDir, mock } = await setup(false, false);
    try {
      expect((await managerCheck(projectDir))?.status).toBe("WARN");
    } finally {
      await mock.close();
    }
  });

  it("passes the backend check on a fresh workspace — its ComfyUI URL configures comfy", async () => {
    // A scaffolded konte.config.json carries comfyui.url, and the fixture video declares comfy assets only,
    // so nothing about backends stands between `konte workspace new` and the first generate.
    const { projectDir, mock } = await setup(true, true);
    try {
      const check = await doctorCheck(projectDir, "configured backends");
      expect(check?.status).toBe("PASS");
      expect(check?.message).toContain("[comfy] configured");
    } finally {
      await mock.close();
    }
  });

  it("names stuck jobs by preview, with one command that needs no ids", async () => {
    // The mock's /queue is empty and its catch-all answers /history with {}, so every submitted
    // prompt reads as absent from both — the state a ComfyUI crash leaves behind.
    const { projectDir, mock } = await setup(true, true);
    try {
      const jobManager = new JobManager(projectDir);
      const ids: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const variantId = `v-stuck000${i}`;
        ids.push(variantId);
        await jobManager.createJob({
          address: "video:shot.01.motion",
          variantId,
          resolvedDeps: {},
          backendKind: "comfy",
        });
        await jobManager.updateJob(variantId, {
          status: "running",
          backendJobId: `prompt-${i}`,
          // Pin the clock the preview orders by: `listJobs` sorts oldest-first, and four jobs
          // created back to back are minutes apart only in intent — a wall clock that steps back
          // mid-loop changes which id is the one dropped.
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        });
      }

      const check = await doctorCheck(projectDir, "ComfyUI stuck jobs");

      expect(check?.status).toBe("WARN");
      expect(check?.message).toContain("4 running job(s) absent");
      expect(check?.message).toContain("(+1 more)");
      // The fourth id is the one the preview drops, and no command carries an id list.
      expect(check?.message).not.toContain(ids[3]);
      expect(check?.message).toContain("konte job wait");
      expect(check?.message).not.toContain(`konte job wait ${ids[0]}`);
    } finally {
      await mock.close();
    }
  });

  it("hides a passing backend check in text output unless --backends is given", async () => {
    // The ComfyUI connection is a *used* backend check here (TEST_VIDEO_TSX has comfy assets) and
    // passes against the mock. Its PASS line — carrying the live GPU/VRAM diagnostics — is hidden
    // by default like any other PASS, but --backends explicitly surfaces it.
    const { projectDir, mock } = await setup(true, true);
    try {
      const plain = await runCapture(["doctor"], projectDir);
      expect(plain.stdout).not.toContain("ComfyUI connection");

      const surveyed = await runCapture(["doctor", "--backends"], projectDir);
      expect(surveyed.stdout).toContain("✓ PASS ComfyUI connection");
      expect(surveyed.stdout).toContain("VRAM 12.0/24.0 GB free");
    } finally {
      await mock.close();
    }
  });
});

describe("doctor command (--backends survey)", () => {
  it("skips backends the project does not use by default", async () => {
    const projectDir = await initWithNoBackendVideo();
    expect(await doctorCheck(projectDir, "FAL connection")).toBeUndefined();
  });

  it("surveys unavailable backends as advisory WARN, adding no FAIL", async () => {
    // No FAL_KEY in the test env: FAL is unavailable, yet because it is not actually used,
    // --backends downgrades it to WARN (a survey, not a project error). And the survey must add
    // no FAIL, so the whole batch never gates the exit code.
    const projectDir = await initWithNoBackendVideo();
    const failNames = (checks: Awaited<ReturnType<typeof doctorChecks>>) =>
      checks
        .filter((check) => check.status === "FAIL")
        .map((check) => check.name)
        .sort();

    const plain = await doctorChecks(projectDir);
    const surveyed = await doctorChecks(projectDir, ["--backends"]);

    expect(surveyed.find((check) => check.name === "FAL connection")?.status).toBe("WARN");
    expect(failNames(surveyed)).toEqual(failNames(plain));
  });
});

describe("doctor command (no video selected)", () => {
  it("runs the workspace-level survey and never fails when no video is selected", async () => {
    // `konte doctor --backends` before any video exists: the WORK.md use case of checking backend
    // connectivity while choosing one. It surveys the backends and drops to workspace scope with a
    // WARN, never a VIDEO_NOT_SELECTED error, and never a non-zero exit.
    const workspace = path.join(ctx.dir, "empty-ws");
    await fs.mkdir(workspace, { recursive: true });
    await run(["workspace", "new"], workspace);

    const checks = await doctorChecks(workspace, ["--backends"]);
    const byName = (name: string) => checks.find((check) => check.name === name);

    const scope = byName("video scope");
    expect(scope?.status).toBe("WARN");
    expect(scope?.message).toContain("no video selected");
    // The survey ran: FAL is unreachable in the test env but downgraded to advisory WARN.
    expect(byName("FAL connection")?.status).toBe("WARN");
    // No video-scoped checks leaked in.
    expect(byName("konte.state.json")).toBeUndefined();
    expect(byName("direction")).toBeUndefined();
    // Backend configuration is workspace-level, so it is still reported: what a fresh workspace can
    // spend on must not wait for a video (or for the first generate).
    const backends = byName("configured backends");
    expect(backends?.status).toBe("PASS");
    expect(backends?.message).toContain("[comfy] configured");
    // Never gates the exit code.
    expect(checks.filter((check) => check.status === "FAIL")).toEqual([]);
  });

  it("type-checks adapters/ when no video is selected", async () => {
    const workspace = path.join(ctx.dir, "adapter-ws");
    await fs.mkdir(workspace, { recursive: true });
    await run(["workspace", "new"], workspace);
    await fs.writeFile(
      path.join(workspace, "adapters", "comfy", "broken.ts"),
      'const x: number = "bad";\nexport { x };\n',
    );

    const typeCheck = (await doctorChecks(workspace)).find((check) => check.name === "type check");
    expect(typeCheck?.status).toBe("FAIL");
    expect(typeCheck?.details.join("\n")).toContain("TS2322");
  });
});
