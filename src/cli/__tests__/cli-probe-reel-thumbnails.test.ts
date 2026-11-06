import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ensureFfmpeg } from "../../core/ffmpeg.js";
import {
  ffmpegBin,
  SINGLE_FRAME_INPUT_ARGS,
  SINGLE_FRAME_OUTPUT_ARGS,
} from "../../core/ffmpeg-binary.js";
import { StateManager } from "../../core/state/index.js";
import {
  useTempWorkspace,
  run,
  runCapture,
  initWithChainedShotsVideo,
  TEST_VIDEO_CHAINED_SHOTS_TSX,
} from "./cli-fixtures.js";

vi.mock("../../core/composition-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/composition-capture.js")>();
  return {
    ...actual,
    captureCompositionFrames: async (options: { shotId: string }) => [
      { file: `.konte/cache/thumbnails/${options.shotId}.jpg`, timestamp: 0 },
    ],
  };
});

useTempWorkspace();

describe("probe reel-thumbnails", () => {
  async function setup(): Promise<string> {
    return await initWithChainedShotsVideo();
  }

  it("refuses a whole stage and points at the contact sheet", async () => {
    const projectDir = await setup();

    const { stderr } = await runCapture(["probe", "reel-thumbnails", "video"], projectDir);

    expect(stderr).toContain("INVALID_ADDRESS");
    expect(stderr).toContain("konte probe contact-sheet video");
  });

  it("refuses a shot drawing a layer no take resolves and names the generate", async () => {
    const projectDir = await setup();

    const { stdout, stderr } = await runCapture(
      ["probe", "reel-thumbnails", "video:shot.01"],
      projectDir,
    );

    expect(stderr).toContain("DEPENDENCY_NOT_RESOLVED");
    expect(stderr).toContain("video:shot.01.motion");
    expect(stderr).toContain("`konte generate video`");
    expect(stdout).not.toContain("frames captured");
  });

  it("syncs a file asset no generate has registered and captures it", async () => {
    const projectDir = await setup();
    await ensureFfmpeg();
    const png = path.join(projectDir, "assets/files/still.png");
    await fs.mkdir(path.dirname(png), { recursive: true });
    await promisify(execFile)(await ffmpegBin(), [
      "-y",
      "-v",
      "error",
      ...SINGLE_FRAME_INPUT_ARGS,
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:size=64x36",
      "-frames:v",
      "1",
      ...SINGLE_FRAME_OUTPUT_ARGS,
      png,
    ]);
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_CHAINED_SHOTS_TSX.replace(
        "import { Composition,",
        "import { adapters, Composition,",
      ).replace(
        "<Video src={motion} />",
        `<img src={asset("still", adapters.imageFile, { path: "assets/files/still.png" })} />`,
      ),
    );

    const { stdout } = await run(["probe", "reel-thumbnails", "video:shot.01"], projectDir);

    expect(stdout).toContain("video:shot.01#composition: 1 frames captured");
    const state = (await StateManager.load(projectDir)).getAssetState("video:shot.01.still");
    expect(Object.values(state.variants ?? {}).map((v) => v.file)).toEqual([
      "assets/files/still.png",
    ]);
  });

  it("lists a captured shot's frames at exit code 0", async () => {
    const projectDir = await setup();
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_CHAINED_SHOTS_TSX.replace("<Video src={motion} />", "<div>title</div>"),
    );

    const { stdout } = await run(["probe", "reel-thumbnails", "video:shot.01"], projectDir);

    expect(stdout).toContain("video:shot.01#composition: 1 frames captured");
    expect(stdout).toContain("thumbnails/01.jpg (0s)");
  });
});
