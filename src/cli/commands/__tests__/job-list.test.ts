import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTER_KEY_METADATA_KEY } from "../../../core/adapter-key.js";
import { JobManager } from "../../../core/job-manager.js";
import type { JobRecord } from "../../../core/types/index.js";
import { initWorkspace, run } from "../../__tests__/harness.js";
import { EMPTY_REFERENCE_TSX } from "../../__tests__/fixture-video.js";

const VIDEO_TSX = `import { Composition, Video, defineComfyAsset, defineVideo, asset, defineDirection, defineLens } from "konte";

const direction = defineDirection({
  brief: { logline: "test" },
  characters: {},
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  // A fixture direction is one shot with no arc to check: no built-in lens declares a function-less
  // beat, so it brings its own container lens rather than staging a whole mini-drama.
  lenses: [defineLens({ name: "one-beat", payoff: "beat", beats: [{ role: "beat" }] })],
  sequence: {
    lens: "one-beat",
    pleasure: "cute",
    shots: [{ id: "01", role: "beat", action: "test shot", duration: 5 }],
  },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { prompt: "test" });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});
`;

let tmpDir: string;
let originalCwd: string;
let projectDir: string;
let jobManager: JobManager;

let seq = 0;
function nextVariantId(): string {
  seq += 1;
  return `v-job${String(seq).padStart(4, "0")}`;
}

async function seedJob(
  status: JobRecord["status"],
  { adapterKey, durationMs }: { adapterKey?: string; durationMs?: number } = {},
): Promise<string> {
  const variantId = nextVariantId();
  await jobManager.createJob({
    address: "video:shot.01.motion",
    variantId,
    resolvedDeps: {},
    backendKind: "comfy",
    metadata: adapterKey ? { [ADAPTER_KEY_METADATA_KEY]: adapterKey } : undefined,
  });

  // `startedAt` is stamped by the manager on the transition into "running"; the run's real
  // work start (what `job stats` measures from) is `processingStartedAt`, which a patch may set.
  const processingStartedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  await jobManager.updateJob(variantId, {
    status,
    ...(status === "completed" && durationMs != null
      ? {
          processingStartedAt: processingStartedAt.toISOString(),
          completedAt: new Date(processingStartedAt.getTime() + durationMs).toISOString(),
        }
      : {}),
  });
  return variantId;
}

// `startedAt` is stamped by the manager on the transition into "running" and kept set-once, so a
// submit further in the past than this test can wait for is written onto the record whole.
// `createdAt` moves with it: `job list` orders rows by that field, and jobs seeded in one loop
// otherwise take whatever order the wall clock hands them.
async function backdateStart(variantId: string, msAgo: number): Promise<void> {
  const jm = new JobManager(projectDir);
  const job = await jm.getJob(variantId);
  const at = new Date(Date.now() - msAgo).toISOString();
  await jm.putJob({ ...job, createdAt: at, startedAt: at });
}

// A live run lease, so the job reads as one a worker is actually watching.
async function claim(variantId: string): Promise<void> {
  const jm = new JobManager(projectDir);
  const job = await jm.getJob(variantId);
  await jm.putJob({
    ...job,
    lease: { owner: "w-test", expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
}

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-joblist-test-"));
  process.chdir(tmpDir);

  projectDir = (await initWorkspace(path.join(tmpDir, "testproject"))).video;
  await fs.writeFile(path.join(projectDir, "video.tsx"), VIDEO_TSX);
  await fs.writeFile(path.join(projectDir, "reference.tsx"), EMPTY_REFERENCE_TSX);
  jobManager = new JobManager(projectDir);
  seq = 0;
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The table is the listing: split it back into rows so a test reads one job's cells by column.
async function listRows(args: string[] = []): Promise<Record<string, string>[]> {
  const { stdout } = await run(["job", "list", ...args], projectDir);
  const lines = stdout.split("\n");
  const headerAt = lines.findIndex((line) => line.startsWith("ID"));
  if (headerAt === -1) return [];
  const header = lines[headerAt]!;
  const columns = header.trim().split(/\s+/);
  const starts = columns.map((column) => header.indexOf(column));
  const body = lines.slice(headerAt + 1);
  const endAt = body.findIndex((line) => line.trim() === "");
  return body.slice(0, endAt === -1 ? body.length : endAt).map((line) => {
    const row: Record<string, string> = {};
    columns.forEach((column, i) => {
      const end = i + 1 < starts.length ? starts[i + 1]! : line.length;
      row[column] = line.slice(starts[i]!, end).trim();
    });
    return row;
  });
}

describe("job list", () => {
  it("hides completed and cancelled jobs by default, counting what it hid", async () => {
    const running = await seedJob("running");
    const failed = await seedJob("failed");
    await seedJob("completed");
    await seedJob("cancelled");

    const rows = await listRows();

    expect(rows.map((row) => row.ID).sort()).toEqual([failed, running].sort());

    const { stdout: text } = await run(["job", "list"], projectDir);
    expect(text).toContain("2 completed/cancelled hidden");
  });

  it("includes every status with --verbose", async () => {
    await seedJob("running");
    await seedJob("completed");
    await seedJob("cancelled");

    const { stdout } = await run(["job", "list", "--verbose"], projectDir);

    expect(await listRows(["--verbose"])).toHaveLength(3);
    expect(stdout).not.toContain("hidden");
  });

  it("shows exactly one status with --status, terminal ones included", async () => {
    const completed = await seedJob("completed");
    await seedJob("running");

    const { stdout } = await run(["job", "list", "--status", "completed"], projectDir);

    expect((await listRows(["--status", "completed"])).map((row) => row.ID)).toEqual([completed]);
    expect(stdout).not.toContain("hidden");
  });

  it("reports nothing to show when every job is hidden", async () => {
    await seedJob("completed");

    const { stdout } = await run(["job", "list"], projectDir);
    expect(stdout).toContain("No active jobs (1 completed/cancelled hidden");
  });

  it("caps rows at --limit, newest first, and lifts the cap with --all", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedJob("running"));

    // Newest first: the last job seeded leads.
    expect((await listRows(["--limit", "2"])).map((row) => row.ID)).toEqual([ids[2], ids[1]]);

    const { stdout: text } = await run(["job", "list", "--limit", "2"], projectDir);
    expect(text).toContain("... and 1 more (use --all)");

    expect(await listRows(["--all"])).toHaveLength(3);
  });

  it("marks a running job no worker is watching, on both output paths", async () => {
    const running = await seedJob("running");
    // Submitted (a backend id is committed) but unleased — an unwatched job, not a stranded submit.
    await jobManager.updateJob(running, { backendJobId: "prompt-1" });

    const { stdout: text } = await run(["job", "list"], projectDir);
    expect(text).toContain("running ⚠ unwatched");
  });

  it("reports a waiting comfy prompt's queue position instead of an empty progress", async () => {
    const executing = await seedJob("running");
    const first = await seedJob("running");
    const second = await seedJob("running");
    for (const id of [executing, first, second]) {
      await jobManager.updateJob(id, { backendJobId: `prompt-${id}` });
    }
    await backdateStart(executing, 20 * 60_000);
    await backdateStart(first, 10 * 60_000);
    await backdateStart(second, 5 * 60_000);
    await jobManager.updateJob(executing, { processingStartedAt: new Date().toISOString() });
    // A live lease on each: waiting on the queue is the only thing left to say about them.
    for (const id of [executing, first, second]) await claim(id);

    const rows = await listRows();
    const progressOf = (id: string) => rows.find((row) => row.ID === id)?.PROGRESS;

    // The one ComfyUI is executing is not waiting on anything, so it has no position.
    expect(progressOf(executing)).toBe("-");
    expect(progressOf(first)).toBe("1 ahead");
    expect(progressOf(second)).toBe("2 ahead");

    const { stdout: text } = await run(["job", "list"], projectDir);
    // A serial queue is the whole explanation for the wait — nothing here is broken.
    expect(text).not.toContain("⚠");
  });

  it("counts the whole queue ahead of a prompt, not just the rows the limit shows", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await seedJob("running");
      await jobManager.updateJob(id, { backendJobId: `prompt-${id}` });
      await backdateStart(id, (30 - i * 10) * 60_000);
      ids.push(id);
    }

    const rows = await listRows(["--limit", "1"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.ID).toBe(ids[2]);
    expect(rows[0]!.PROGRESS).toBe("2 ahead");
  });

  it("fails loudly on a non-numeric --limit instead of falling back to the default", async () => {
    await expect(run(["job", "list", "--limit", "abc"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_OPTION"),
    });
  });
});

describe("job stats", () => {
  it("aggregates completed jobs per adapter and profile", async () => {
    for (const ms of [1000, 2000, 3000]) {
      await seedJob("completed", { adapterKey: "animate", durationMs: ms });
    }
    // A running job has no duration and must not enter the aggregate.
    await seedJob("running", { adapterKey: "animate" });

    const { stdout } = await run(["job", "stats"], projectDir);

    const [, row] = stdout.trim().split("\n");
    // The running job carries no duration, so it is outside the count.
    expect(row!.split(/\s{2,}/).slice(0, 6)).toEqual([
      "comfy:animate",
      "—",
      "3",
      "0:02",
      "0:03",
      "0:02",
    ]);
  });

  it("says so plainly when no job has timing data yet", async () => {
    await seedJob("running", { adapterKey: "animate" });

    const { stdout } = await run(["job", "stats"], projectDir);
    expect(stdout).toContain("No completed jobs with timing data yet.");
  });

  it("scopes the aggregate to an address-scope", async () => {
    await seedJob("completed", { adapterKey: "animate", durationMs: 1000 });

    const { stdout } = await run(["job", "stats", "video"], projectDir);
    expect(stdout).toContain("comfy:animate");

    const { stdout: other } = await run(["job", "stats", "animatic"], projectDir);
    expect(other).toContain("No completed jobs with timing data yet.");
  });

  it("rejects an invalid address-scope", async () => {
    await expect(run(["job", "stats", "video@"], projectDir)).rejects.toThrow();
  });
});
