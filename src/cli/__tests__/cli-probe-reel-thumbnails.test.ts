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

describe("probe reel-thumbnails", () => {
  async function setup(): Promise<string> {
    failures.clear();
    return await initWithChainedShotsVideo();
  }

  it("refuses a whole stage and points at the contact sheet", async () => {
    const projectDir = await setup();

    const { stderr } = await runCapture(["probe", "reel-thumbnails", "video"], projectDir);

    expect(stderr).toContain("INVALID_ADDRESS");
    expect(stderr).toContain("konte probe contact-sheet video");
  });

  it("fails a named shot with its address and no raw stack", async () => {
    const projectDir = await setup();
    failures.set("02", new Error(""));

    const { stderr } = await runCapture(["probe", "reel-thumbnails", "video:shot.02"], projectDir);

    expect(stderr).toContain("Error [FRAME_CAPTURE_FAILED]: video:shot.02#composition: Error");
    expect(stderr).not.toContain("    at ");
  });

  it("lists a captured shot's frames at exit code 0", async () => {
    const projectDir = await setup();

    const { stdout } = await run(["probe", "reel-thumbnails", "video:shot.01"], projectDir);

    expect(stdout).toContain("video:shot.01#composition: 1 frames captured");
    expect(stdout).toContain("thumbnails/01.jpg (0.00s)");
  });
});
