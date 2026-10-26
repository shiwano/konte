import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
import {
  TEST_VIDEO_CHAINED_SHOTS_TSX,
  acceptDirection,
  ctx,
  initWorkspace,
  run,
  runCapture,
  useTempWorkspace,
} from "./cli-fixtures.js";

const captured: number[][] = [];

// A real frame per requested time, in a content-hash dir, so the strip tiles without Chromium.
vi.mock("../../core/thumbnail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/thumbnail.js")>();
  return {
    ...actual,
    captureCompositionFrames: async (options: {
      videoRoot: string;
      outputDir: string;
      captureOptions: { timestamps?: number[] };
    }) => {
      const timestamps = options.captureOptions.timestamps ?? [0];
      captured.push(timestamps);
      const dir = path.join(options.outputDir, "c0ffee");
      await fs.mkdir(dir, { recursive: true });
      const ffmpeg = await ffmpegBin();
      return Promise.all(
        timestamps.map(async (timestamp) => {
          const file = path.join(dir, `at-${Math.round(timestamp * 1000)}ms.jpg`);
          await promisify(execFile)(ffmpeg, [
            "-y",
            "-v",
            "error",
            ...SINGLE_FRAME_INPUT_ARGS,
            "-f",
            "lavfi",
            "-i",
            "color=c=gray:s=128x72",
            "-frames:v",
            "1",
            ...SINGLE_FRAME_OUTPUT_ARGS,
            file,
          ]);
          return { file: path.relative(options.videoRoot, file), timestamp };
        }),
      );
    },
  };
});

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

const ANIMATED_VIDEO_TSX = TEST_VIDEO_CHAINED_SHOTS_TSX.replace(
  "import { Composition,",
  "import { Animate, Composition,",
).replace(
  "return <Composition><Video src={motion} /></Composition>;",
  `return (
        <Composition>
          <Video src={motion} />
          <div id="title">hi</div>
          <Animate script={({ timeline }) => { timeline.to("#title", { x: 100, duration: 1 }, 0); }} />
        </Composition>
      );`,
);

async function setup(): Promise<string> {
  captured.length = 0;
  await ensureFfmpeg();
  const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "testproject"));
  await fs.writeFile(path.join(projectDir, "video.tsx"), ANIMATED_VIDEO_TSX);
  return projectDir;
}

describe("probe motion on a composition", () => {
  it("tiles the window on the shot's frame grid into the composition's frame cache", async () => {
    const projectDir = await setup();

    const { stdout } = await run(
      [
        "probe",
        "motion",
        "video:shot.01#composition",
        "--at",
        "1",
        "--window",
        "0.6",
        "--frames",
        "4",
      ],
      projectDir,
    );

    const strip = stdout.trim();
    expect(strip).toMatch(/strip-at1000ms-w600ms-f4\.jpg$/);
    expect(strip).toContain(path.join(".konte", "cache", "thumbnails"));
    expect(existsSync(strip)).toBe(true);
    expect(captured).toEqual([[0.7, 0.9, 1.1, 1.3]]);
  });

  it("heads each strip with its address when mixed with other targets", async () => {
    const projectDir = await setup();

    const { stdout } = await run(
      ["probe", "motion", "video:shot.01#composition", "video:shot.02#composition"],
      projectDir,
    );

    expect(stdout).toContain("# video:shot.01#composition");
    expect(stdout).toContain("# video:shot.02#composition");
    expect(stdout).toMatch(/strip-full-f16\.jpg/);
  });

  it("sweeps under --needs-review only a composition that places no video take", async () => {
    const projectDir = await setup();
    const clip = path.join(projectDir, "assets", "files", "clip.mp4");
    await fs.mkdir(path.dirname(clip), { recursive: true });
    await promisify(execFile)(await ffmpegBin(), [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:d=2:r=12",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_CHAINED_SHOTS_TSX.replace(
        "import { Composition,",
        "import { adapters, Composition,",
      ).replace(
        /timeline: [\s\S]*$/,
        `timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const clip = asset("clip", adapters.videoFile, { path: "assets/files/clip.mp4" });
      return <Composition><Video src={clip} /></Composition>;
    }).nextShot("02", () => <Composition><div /></Composition>),
  }),
});
`,
      ),
    );
    await acceptDirection(projectDir);

    const { stdout, stderr } = await run(
      ["probe", "motion", "--needs-review", "video", "--verbose"],
      projectDir,
    );

    expect(stdout).toContain("# video:shot.01.clip");
    expect(stdout).not.toContain("# video:shot.01#composition");
    expect(stdout).toContain("# video:shot.02#composition");
    expect(stderr).toMatch(/video:shot\.02#composition .*\n {2}action {4}\S/);
  });

  it("refuses a window with no --at, and --fps", async () => {
    const projectDir = await setup();

    const noAt = await runCapture(
      ["probe", "motion", "video:shot.01#composition", "--window", "1"],
      projectDir,
    );
    expect(noAt.stderr).toContain("INVALID_OPTION");
    expect(noAt.stderr).toContain("needs --at");

    const fps = await runCapture(
      ["probe", "motion", "video:shot.01#composition", "--fps", "native"],
      projectDir,
    );
    expect(fps.stderr).toContain("INVALID_OPTION");
    expect(captured).toEqual([]);
  });
});

describe("probe reel-thumbnails on an animated shot", () => {
  it("points each <Animate> shot at probe motion", async () => {
    const projectDir = await setup();

    const animated = await run(["probe", "reel-thumbnails", "video:shot.01"], projectDir);
    expect(animated.stdout).toContain("Next steps:");
    expect(animated.stdout).toContain("konte probe motion video:shot.01#composition --at <sec>");

    const still = await run(["probe", "reel-thumbnails", "video:shot.02"], projectDir);
    expect(still.stdout).not.toContain("Next steps:");
  });
});
