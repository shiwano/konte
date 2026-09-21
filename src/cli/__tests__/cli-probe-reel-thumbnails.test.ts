import { describe, expect, it, vi } from "vitest";
import { useTempWorkspace, run, runCapture, initWithChainedShotsVideo } from "./cli-fixtures.js";

// Keyed by shot id: the error that shot's capture rejects with.
const failures = new Map<string, Error>();

vi.mock("../../core/thumbnail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/thumbnail.js")>();
  return {
    ...actual,
    captureCompositionFrames: async (options: { shotId: string }) => {
      const failure = failures.get(options.shotId);
      if (failure) throw failure;
      return [{ file: `.konte/cache/thumbnails/${options.shotId}.jpg`, timestamp: 0 }];
    },
  };
});

useTempWorkspace();

describe("probe reel-thumbnails with a shot that fails to capture", () => {
  async function setup(): Promise<string> {
    failures.clear();
    return await initWithChainedShotsVideo();
  }

  it("captures the rest of the reel and names the failed shot", async () => {
    const projectDir = await setup();
    failures.set("02", new Error("Protocol error (Page.captureScreenshot): Target crashed"));

    const err = (await run(["probe", "reel-thumbnails", "video"], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
      stderr: string;
    };

    expect(err.code).toBe(1);
    expect(err.stdout).toContain("video:shot.01#composition: 1 frames captured");
    expect(err.stderr).toContain("video:shot.02#composition: capture failed — Protocol error");
    expect(err.stderr).toContain("1 of 2 shots captured; failed: video:shot.02#composition");
    expect(err.stderr).toContain("KONTE_DEBUG=1");
  });

  it("fails a named shot with its address and no raw stack", async () => {
    const projectDir = await setup();
    failures.set("02", new Error(""));

    const { stderr } = await runCapture(["probe", "reel-thumbnails", "video:shot.02"], projectDir);

    expect(stderr).toContain("Error [FRAME_CAPTURE_FAILED]: video:shot.02#composition: Error");
    expect(stderr).not.toContain("    at ");
  });

  it("leaves an all-green reel at exit code 0", async () => {
    const projectDir = await setup();

    const { stdout, stderr } = await run(["probe", "reel-thumbnails", "video"], projectDir);

    expect(stdout).toContain("video:shot.01#composition: 1 frames captured");
    expect(stdout).toContain("video:shot.02#composition: 1 frames captured");
    expect(stderr).not.toContain("failed");
  });
});
