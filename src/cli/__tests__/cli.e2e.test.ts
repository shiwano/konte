import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

// End-to-end smoke tests that spawn the real `bun run src/cli/index.ts` binary. The bulk of the CLI
// surface is covered fast and in-process by cli.test.ts; that harness deliberately skips the
// type-check/template-sync preAction and loads project definitions through vitest's module runner.
// These few tests exist to keep the full stack honest: a cold Bun process, the real tsc type-check
// plus managed-template sync, and Bun-native definition loading (Bun.plugin, Bun.stringWidth).
// Keep this set small — each spawn is intentionally slow.

const CLI_PATH = path.resolve(__dirname, "../index.ts");
let tmpDir: string;

function run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("bun", ["run", CLI_PATH, ...args], { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-cli-e2e-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Scaffolds `<tmpDir>/app` with one video in it. Returns both roots.
async function initApp(): Promise<{ ws: string; video: string }> {
  await fs.mkdir(path.join(tmpDir, "app"));
  await run(["workspace", "new"], path.join(tmpDir, "app"));
  const ws = path.join(tmpDir, "app");
  await run(["video", "new", "main", "--template", "kitchen-sink"], ws);
  return { ws, video: path.join(ws, "videos", "main") };
}

describe("CLI end-to-end (real binary)", () => {
  it("reports an empty workspace even when an adapter has a type error", async () => {
    await fs.writeFile(path.join(tmpDir, "konte.config.json"), "{}");
    await fs.mkdir(path.join(tmpDir, "videos"));
    await fs.mkdir(path.join(tmpDir, "adapters"));
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ include: ["adapters/**/*.ts"] }),
    );
    await fs.writeFile(path.join(tmpDir, "adapters", "broken.ts"), 'const x: number = "bad";');

    expect((await run(["video", "current"], tmpDir)).stdout).toContain("no videos");
    expect((await run(["video", "list"], tmpDir)).stdout).toContain("No videos yet");
    await expect(
      run(["video", "new", "opening", "--template", "blank"], tmpDir),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("TS2322"),
    });
  });

  it("scaffolds a workspace and a kitchen-sink video in it", async () => {
    const { ws, video } = await initApp();

    await fs.access(path.join(ws, "konte.config.json"));
    await fs.access(path.join(ws, "adapters", "comfy"));
    expect(await fs.readFile(path.join(video, "video.tsx"), "utf-8")).toContain("defineVideo");
    await fs.access(path.join(video, "konte.state.json"));

    // The workspace root is not itself a video.
    await expect(fs.access(path.join(ws, "konte.state.json"))).rejects.toThrow();
  });

  it("runs status through the full preAction (type-check + sync) and loads the shipped definition", async () => {
    const { ws } = await initApp();

    // From the workspace root: no enclosing video, so this resolves through the current video
    // that `video new` set — and the type-check runs against the real workspace tsconfig.
    const { stdout } = await run(["status"], ws);
    expect(stdout).toContain("Progress:");
  });

  it("prefers the video the cwd is inside over the current one", async () => {
    const { ws, video } = await initApp();
    await run(["video", "new", "second", "--template", "blank"], ws);

    // `video new` made "second" current, but cwd sits inside "main".
    const { stdout: listed } = await run(["video", "list"], ws);
    expect(listed).toContain("* second");

    const { stdout } = await run(["status"], video);
    // The kitchen-sink video declares assets; the blank one declares none — so the counted
    // progress tells which video answered.
    expect(stdout).toMatch(/video: \d+\/[1-9]\d*/);
  });

  it("renders the status table and surfaces a typed error code on stderr", async () => {
    const { video } = await initApp();

    // Text output exercises the real Bun.stringWidth-backed table renderer.
    const { stdout } = await run(["status"], video);
    expect(stdout).toContain("Progress:");

    await expect(run(["accept", "vide:shot.01.motion"], video)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_ADDRESS"),
    });
  });

  it("refuses a video-scoped command with no video selected", async () => {
    await fs.mkdir(path.join(tmpDir, "app"));
    await run(["workspace", "new"], path.join(tmpDir, "app"));
    const ws = path.join(tmpDir, "app");

    await expect(run(["status"], ws)).rejects.toMatchObject({
      stderr: expect.stringContaining("VIDEO_NOT_SELECTED"),
    });
  });
});
