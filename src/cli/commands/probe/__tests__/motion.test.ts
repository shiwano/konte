import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The command's value is its stdout/stderr contract: the filmstrip path is the *only* thing on
// stdout (so it pipes and an agent Reads one line), and the waveform/numbers are advisory on stderr.
// Mock the ffmpeg-backed motion-inspect layer so the test exercises that routing, not real decoding.
const { loadMotionWaveform, renderMotionStrip, resolveIntent } = vi.hoisted(() => ({
  loadMotionWaveform: vi.fn(),
  renderMotionStrip: vi.fn(),
  resolveIntent: vi.fn(),
}));

vi.mock("../../../../core/ffmpeg.js", () => ({ ensureFfmpeg: async () => {} }));
vi.mock("../../../../core/ffmpeg-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../core/ffmpeg-binary.js")>()),
  ffprobeBin: async () => "ffprobe",
}));
vi.mock("../../../../core/state/index.js", () => ({
  StateManager: { load: async () => ({ getState: () => ({ schemaVersion: 1, assets: {} }) }) },
}));
vi.mock("../../../../core/motion-inspect.js", () => ({ loadMotionWaveform, renderMotionStrip }));
// The definition load is what costs; the formatter it feeds is the real one.
vi.mock("../motion-intent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../motion-intent.js")>()),
  createMotionIntentLoader: () => resolveIntent,
}));

import { setRoots } from "../../../context.js";
import { registerProbeMotionCommand } from "../motion.js";

const VIDEO_ROOT = "/home/user/project";

const STRIP_PATH = "/home/user/project/.konte/cache/motion/v-test1234/hash/strip-full-f16.jpg";

function fakeWaveform(overrides: Record<string, unknown> = {}) {
  return {
    isVideo: true,
    variantId: "v-test1234",
    address: "video:shot.01.motion",
    file: "assets/v-test1234.mp4",
    status: "none",
    durationSec: 2,
    fps: 30,
    samples: 60,
    mean: 0.12,
    peak: { value: 0.4, time: 1.9 },
    magnitude: { value: 0.62, time: 1.9 },
    displacementWindowSec: 1,
    raw: [0.1, 0.2, 0.4, 0.2],
    coherent: [0.1, 0.2, 0.4, 0.2],
    local: [0.2, 0.35, 0.62, 0.3],
    flickerScore: [0, 0, 0, 0],
    segments: [],
    warnings: [],
    ...overrides,
  };
}

async function runMotion(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    outChunks.push(a.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    errChunks.push(a.map(String).join(" "));
  });
  try {
    const program = new Command();
    program.exitOverride();
    registerProbeMotionCommand(program);
    await program.parseAsync(["motion", ...args], { from: "user" });
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: outChunks.join("\n"), stderr: errChunks.join("\n") };
}

beforeEach(() => {
  // The command reads its roots from the CLI context, which the real preAction fills in. This
  // test drives a bare Command, so seed them here.
  setRoots({
    workspace: VIDEO_ROOT,
    video: { kind: "selected", root: VIDEO_ROOT, name: "project" },
  });
  loadMotionWaveform.mockReset().mockResolvedValue(fakeWaveform());
  resolveIntent.mockReset().mockResolvedValue({
    shotId: "01",
    action: "She taps the card",
    moves: [{ blocking: "her hand comes down", camera: "fixed" }],
  });
  renderMotionStrip.mockReset().mockResolvedValue({
    path: STRIP_PATH,
    timestamps: [0, 0.5, 1, 1.5],
    window: { start: 0, end: 1.97 },
  });
});

describe("probe motion stdout/stderr contract", () => {
  it("with no flags: full-clip strip path is the only thing on stdout, nothing else on stderr", async () => {
    const { stdout, stderr } = await runMotion(["v-test1234"]);

    expect(stdout).toBe(STRIP_PATH);
    expect(renderMotionStrip).toHaveBeenCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ full: true }) }),
    );
    // No advisory numbers by default — only the path on stdout, and a clean clip has no warnings.
    expect(stderr).toBe("");
  });

  it("with no flags: a warning still prints on stderr (the absolute, cross-clip signal)", async () => {
    loadMotionWaveform.mockResolvedValue(
      fakeWaveform({
        warnings: [{ type: "low_motion", message: "No motion rises above the noise floor." }],
      }),
    );

    const { stdout, stderr } = await runMotion(["v-test1234"]);

    expect(stdout).toBe(STRIP_PATH);
    expect(stderr).toContain("No motion rises above the noise floor.");
    // A low_motion reading is a failure only where movement was asked for.
    expect(stderr).toContain("action    She taps the card");
    expect(stderr).toContain("movement  blocking: her hand comes down  —  camera: fixed");
    // Still no full advisory.
    expect(stderr).not.toContain("mean 0.120");
  });

  it("a clean clip pays for no definition load", async () => {
    const { stderr } = await runMotion(["v-test1234"]);

    expect(stderr).toBe("");
    expect(resolveIntent).not.toHaveBeenCalled();
  });

  it("--verbose adds the stats, reading note and the motion-energy sparkline to stderr", async () => {
    const { stdout, stderr } = await runMotion(["v-test1234", "--verbose"]);

    expect(stdout).toBe(STRIP_PATH);
    expect(stderr).toContain("advisory");
    expect(stderr).toContain("magnitude 0.6200 @ 1.9s  (busiest tile over 1s)");
    expect(stderr).toContain("mean 0.120");
    expect(stderr).toContain("action    She taps the card");
    expect(stderr).toContain("mean/peak rank within one clip only");
  });

  it("--at/--window switches to a windowed strip but keeps stdout to the path alone", async () => {
    const { stdout } = await runMotion(["v-test1234", "--window", "0.8"]);

    expect(stdout).toBe(STRIP_PATH);
    expect(renderMotionStrip).toHaveBeenCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ full: false, window: 0.8 }) }),
    );
  });

  it("a non-video variant reports 'not a video' and never renders a strip", async () => {
    loadMotionWaveform.mockResolvedValue(fakeWaveform({ isVideo: false }));

    const { stdout } = await runMotion(["v-image"]);

    expect(renderMotionStrip).not.toHaveBeenCalled();
    expect(stdout).toContain("not a video");
  });
});
