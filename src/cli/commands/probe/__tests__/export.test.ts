import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The command's value is its acceptance contract: given a rendered deliverable, it reports the real
// resolution/duration/fps/audio ffprobed back from the produced MP4 — so an agent never hand-rolls
// ffprobe. Mock the probe layer (exercise the routing, not real decoding) and the data layer that
// resolves the last export; back it with a real temp file so existsSync/fs.stat run for real.
const probes = vi.hoisted(() => ({ probeMediaDetail: vi.fn(), probeContainerTags: vi.fn() }));
const data = vi.hoisted(() => ({ jobs: [] as unknown[] }));

vi.mock("../../../../core/ffmpeg-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../core/ffmpeg-binary.js")>()),
  ffprobeBin: async () => "ffprobe",
}));
vi.mock("../../../../core/video-probe.js", () => probes);
vi.mock("../../../../core/loader.js", () => ({
  loadVideoDefinition: async () => {
    throw new Error("no video.tsx in this test");
  },
}));
vi.mock("../../../../core/state/index.js", () => ({
  StateManager: {
    load: async () => ({ getState: () => ({ assets: { "video:shot.01.motion": {} } }) }),
  },
}));
vi.mock("../../../../core/job-manager.js", () => ({
  JobManager: class {
    listJobs = async () => data.jobs;
  },
}));

import { setRoots } from "../../../context.js";
import { registerProbeExportCommand } from "../export.js";

let videoRoot: string;
let outputRel: string;

function completedExportJob(outputFile: string) {
  return {
    id: "job-export-1",
    kind: "export",
    status: "completed",
    outputFile,
    noDelivery: false,
    exportSignature: null,
    completedAt: "2026-07-16T00:00:00.000Z",
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "mf-Ab12Cd34",
    konteVersion: "0.0.1",
    renderedAt: "2026-07-16T00:00:00.000Z",
    exportSignature: "sig-abc123",
    allowUnaccepted: false,
    fps: 30,
    size: { width: 1920, height: 1080 },
    deliveryUpscale: "video",
    variants: {
      "video:shot.01.motion#delivery": { variantId: "v-abc", accepted: true },
    },
    shots: [{ shotId: "01", duration: 4, warnings: [] }],
    warnings: [],
    ...overrides,
  };
}

async function runExport(args: string[]): Promise<string> {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    chunks.push(a.map(String).join(" "));
  });
  try {
    const program = new Command();
    program.exitOverride();
    registerProbeExportCommand(program);
    await program.parseAsync(["export", ...args], { from: "user" });
  } finally {
    logSpy.mockRestore();
  }
  return chunks.join("\n");
}

beforeEach(async () => {
  videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "konte-probe-export-"));
  const outDir = path.join(videoRoot, "dist", "video", "20260716T000000000");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "video.mp4"), "x".repeat(1024));
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest()) + "\n");
  outputRel = path.relative(videoRoot, path.join(outDir, "video.mp4"));

  setRoots({
    workspace: videoRoot,
    video: { kind: "selected", root: videoRoot, name: "project" },
  });
  data.jobs = [completedExportJob(outputRel)];
  probes.probeContainerTags.mockReset().mockResolvedValue({ konte_manifest: "mf-Ab12Cd34" });
  probes.probeMediaDetail.mockReset().mockResolvedValue({
    durationSec: 12.42,
    video: { width: 1920, height: 1080, fps: 30, frames: 120, durationSec: 4 },
    audio: { codec: "aac", sampleRate: 48000, channels: 2, channelLayout: "stereo" },
  });
});

afterEach(async () => {
  await fs.rm(videoRoot, { recursive: true, force: true });
});

describe("probe export", () => {
  it("with no arg: resolves the last export and reports the ffprobed specs", async () => {
    const stdout = await runExport([]);

    expect(stdout).toContain("1920×1080");
    expect(stdout).toContain("12.4"); // fmtSeconds of 12.42
    expect(stdout).toContain("30");
    expect(stdout).toContain("aac");
    expect(stdout).toContain("manifest.json");
    // One probe of the deliverable, not one per field.
    expect(probes.probeMediaDetail.mock.calls).toEqual([[path.join(videoRoot, outputRel)]]);
  });

  it.each([false, true])(
    "probes a working-size export with an older delivery present: %s",
    async (olderDelivery) => {
      data.jobs = [
        ...(olderDelivery
          ? [
              {
                ...completedExportJob("dist/older/video.mp4"),
                completedAt: "2026-07-15T00:00:00.000Z",
              },
            ]
          : []),
        { ...completedExportJob(outputRel), noDelivery: true },
      ];
      const stdout = await runExport([]);
      expect(stdout).toContain("working size (--no-delivery)");
      expect(probes.probeMediaDetail.mock.calls).toEqual([[path.join(videoRoot, outputRel)]]);
    },
  );

  it("reports what the manifest records about the render", async () => {
    const stdout = await runExport([]);

    expect(stdout).toContain("2026-07-16T00:00:00.000Z");
    expect(stdout).toContain("konte 0.0.1");
    expect(stdout).toContain("video"); // deliveryUpscale
    expect(stdout).not.toContain("rough cut");
  });

  it("flags a rough cut rendered with --allow-unaccepted", async () => {
    const outDir = path.join(videoRoot, "dist", "video", "20260716T000000000");
    await fs.writeFile(
      path.join(outDir, "manifest.json"),
      JSON.stringify(manifest({ allowUnaccepted: true })) + "\n",
    );

    expect(await runExport([])).toContain("rough cut");
  });

  it("separates a manifest that does not parse from one that is not there", async () => {
    const outDir = path.join(videoRoot, "dist", "video", "20260716T000000000");
    await fs.writeFile(path.join(outDir, "manifest.json"), "{}\n");

    const unparsed = await runExport([]);
    expect(unparsed).toContain("manifest.json");
    expect(unparsed).not.toContain("konte 0.0.1");
    expect(unparsed).toContain("does not parse");

    await fs.rm(path.join(outDir, "manifest.json"));
    expect(await runExport([])).toContain("no manifest beside it");
  });

  it("flags a manifest that does not describe the file beside it", async () => {
    probes.probeContainerTags.mockResolvedValue({ konte_manifest: "mf-Zz99Yy88" });

    const stdout = await runExport([]);
    expect(stdout).toContain("does not describe this file");
    expect(stdout).toContain("mf-Zz99Yy88");
  });

  it("falls back to the id burned into a file with no manifest beside it", async () => {
    const outDir = path.join(videoRoot, "dist", "video", "20260716T000000000");
    await fs.rm(path.join(outDir, "manifest.json"));

    const stdout = await runExport([]);
    expect(stdout).toContain("mf-Ab12Cd34");
    expect(stdout).toContain("no manifest beside it");
  });

  it("says the pairing cannot be verified when the file carries no konte tag", async () => {
    probes.probeContainerTags.mockResolvedValue({});

    const stdout = await runExport([]);
    expect(stdout).toContain("cannot verify the pairing");
    expect(stdout).not.toContain("does not describe this file");
  });

  it("reports the picture's frames and length, flagging a count off the direction's clock", async () => {
    expect(await runExport([])).toMatch(/picture +120 frames, 4\.000s$/m);

    probes.probeMediaDetail.mockResolvedValue({
      durationSec: 4.02,
      video: { width: 1920, height: 1080, fps: 30.075, frames: 121, durationSec: 4.023 },
      audio: null,
    });
    expect(await runExport([])).toContain("121 frames, 4.023s   [direction runs 120 frames]");
  });

  it("accepts an explicit output path", async () => {
    const stdout = await runExport([outputRel]);
    expect(stdout).toContain("1920×1080");
  });

  it("fails with NO_EXPORT_FOUND when there is no completed export", async () => {
    data.jobs = [];
    await expect(runExport([])).rejects.toMatchObject({ code: "NO_EXPORT_FOUND" });
  });

  it("fails with NO_EXPORT_FOUND when the resolved file is gone", async () => {
    data.jobs = [completedExportJob(path.join("dist", "video", "gone", "video.mp4"))];
    await expect(runExport([])).rejects.toMatchObject({ code: "NO_EXPORT_FOUND" });
  });
});
