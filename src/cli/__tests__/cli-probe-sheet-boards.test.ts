import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { maxCellsForWidth } from "../../core/contact-sheet.js";
import { ensureFfmpeg } from "../../core/ffmpeg.js";
import { ffmpegBin } from "../../core/ffmpeg-binary.js";
import { StateManager } from "../../core/state/index.js";
import {
  acceptDirection,
  initWithCrossStageVideo,
  run,
  runCapture,
  useTempWorkspace,
} from "./cli-fixtures.js";

const STILL = "assets/files/kf.png";

// Every composition frame is the fixture still, so a reel board renders without Chromium.
vi.mock("../../core/thumbnail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/thumbnail.js")>();
  return {
    ...actual,
    captureCompositionFrames: async (options: { captureOptions: { timestamps: number[] } }) =>
      options.captureOptions.timestamps.map((timestamp) => ({ file: STILL, timestamp })),
  };
});

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

describe("probe contact-sheet with mixed arguments", () => {
  async function setup(): Promise<{ projectDir: string; keyframeId: string }> {
    const projectDir = await initWithCrossStageVideo();
    await acceptDirection(projectDir);
    await ensureFfmpeg();
    const png = path.join(projectDir, STILL);
    await fs.mkdir(path.dirname(png), { recursive: true });
    await promisify(execFile)(await ffmpegBin(), [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:size=1024x576",
      "-frames:v",
      "1",
      png,
    ]);

    const sm = await StateManager.load(projectDir);
    const keyframe = "animatic:shot.01.keyframe";
    const keyframeId = sm.reserveVariantId(keyframe);
    sm.getAssetState(keyframe).variants![keyframeId]!.file = STILL;
    sm.setAccepted(keyframe, keyframeId);
    await sm.save();
    return { projectDir, keyframeId };
  }

  it("tiles stills and each stage's reel on their own sheets, in argument order", async () => {
    const { projectDir, keyframeId } = await setup();

    const { stdout, stderr } = await runCapture(
      ["probe", "contact-sheet", "video:shot.01", keyframeId, "animatic"],
      projectDir,
    );
    const summaries = stderr
      .trim()
      .split("\n")
      .filter((line) => line.includes(" cells, "));
    expect(summaries).toEqual([
      expect.stringContaining("video: 2 cells"),
      expect.stringContaining("stills: 1 cells"),
      expect.stringContaining("animatic: 1 cells"),
    ]);
    const sheets = stdout.trim().split("\n");
    expect(sheets).toHaveLength(3);
    for (const sheet of sheets) expect(existsSync(sheet)).toBe(true);
  });

  it("prints every sheet path and names each board's summary", async () => {
    const { projectDir, keyframeId } = await setup();

    const { stdout, stderr } = await runCapture(
      ["probe", "contact-sheet", keyframeId, "animatic:shot.01"],
      projectDir,
    );
    expect(stdout.trim().split("\n")).toHaveLength(2);
    expect(stderr).toContain("stills: 1 cells");
    expect(stderr).toContain("animatic: 1 cells");
  });

  it("writes no sheet when a later board refuses --cell-width", async () => {
    const { projectDir, keyframeId } = await setup();
    // Wide enough for a lone still, too wide for the video board's in/out pair.
    const aspect = 16 / 9;
    const cellWidth = maxCellsForWidth(1, { aspect, groupSize: 2 }).widest + 1;
    expect(maxCellsForWidth(cellWidth, { aspect }).maxCells).not.toBeNull();

    await expect(
      run(
        ["probe", "contact-sheet", keyframeId, "video:shot.01", "--cell-width", String(cellWidth)],
        projectDir,
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("INVALID_OPTION") });
    const sheets = await fs
      .readdir(path.join(projectDir, ".konte", "cache", "contact-sheets"))
      .catch(() => []);
    expect(sheets.filter((f) => f.endsWith(".jpg"))).toEqual([]);
  });
});
