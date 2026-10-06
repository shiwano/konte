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
const requested: number[][] = [];
vi.mock("../../core/thumbnail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/thumbnail.js")>();
  return {
    ...actual,
    captureCompositionFrames: async (options: { captureOptions: { timestamps: number[] } }) => {
      requested.push(options.captureOptions.timestamps);
      return options.captureOptions.timestamps.map((timestamp) => ({ file: STILL, timestamp }));
    },
  };
});

// A mocking test's transform loads Tailwind's stylesheet as an empty string, so every utility class
// reads as unknown.
vi.mock("../../core/tailwind-classes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/tailwind-classes.js")>()),
  assertTailwindClasses: async () => {},
}));

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

async function writeStill(projectDir: string): Promise<void> {
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
}

describe("probe contact-sheet with mixed arguments", () => {
  async function setup(): Promise<{ projectDir: string; keyframeId: string }> {
    const projectDir = await initWithCrossStageVideo();
    await acceptDirection(projectDir);
    await writeStill(projectDir);

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

describe("probe contact-sheet video with subtitles", () => {
  async function setup(overlay: boolean): Promise<string> {
    const projectDir = await initWithCrossStageVideo();
    const videoPath = path.join(projectDir, "video.tsx");
    const subtitle = '<Subtitle entries={[{ start: 1, end: 3, text: "hello" }]} />';
    let tsx = (await fs.readFile(videoPath, "utf-8")).replace(
      "import { Composition, Video,",
      "import { Composition, Subtitle, Video,",
    );
    tsx = overlay
      ? tsx.replace(
          "    }),\n  }),\n});",
          `    }),\n    overlay: () => <Composition>${subtitle}</Composition>,\n  }),\n});`,
        )
      : tsx.replace("<Video src={motion} />", `<Video src={motion} />${subtitle}`);
    await fs.writeFile(videoPath, tsx);
    await acceptDirection(projectDir);
    await writeStill(projectDir);
    requested.length = 0;
    return projectDir;
  }

  it.each([
    ["the shot's own", false],
    ["the overlay's", true],
  ])("adds a cell for each of %s subtitle lines between in and out", async (_, overlay) => {
    const projectDir = await setup(overlay);

    const { stderr } = await runCapture(["probe", "contact-sheet", "video:shot.01"], projectDir);

    expect(stderr).toContain("3 cells");
    expect(requested.at(-1)).toEqual([0, 2, expect.closeTo(4.9, 6)]);
  });

  it("keeps an explicit --frames-per-shot to the even sampler", async () => {
    const projectDir = await setup(false);

    const { stderr } = await runCapture(
      ["probe", "contact-sheet", "video:shot.01", "--frames-per-shot", "2"],
      projectDir,
    );

    expect(stderr).toContain("2 cells");
  });
});
