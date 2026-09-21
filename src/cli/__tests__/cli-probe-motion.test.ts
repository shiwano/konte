import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ensureFfmpeg } from "../../core/ffmpeg.js";
import { ffmpegBin } from "../../core/ffmpeg-binary.js";
import {
  ctx,
  useTempWorkspace,
  run,
  initWorkspace,
  acceptDirection,
  acceptFileAssets,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("probe motion command", () => {
  // Both clips are real files: the displacement the low_motion warning keys on exists only in a decode.
  // The push-in moves 6% over its length — slow enough that consecutive frames read it as noise.
  const MOTION_VIDEO_TSX = `import { defineVideo, Composition, Video, asset, adapters } from "konte";
import direction from "./direction";

export default defineVideo(direction, {
  timeline: ({ shot }) => {
    const clipOf = (name: string) => () => {
      const motion = asset("motion", adapters.videoFile, { path: \`assets/files/\${name}.mp4\` });
      return (
        <Composition>
          <Video src={motion} />
        </Composition>
      );
    };

    return {
      shots: shot("01", clipOf("push"))
        .nextShot("02", clipOf("frozen"))
        .nextShot("03", clipOf("frozen")),
    };
  },
});
`;

  async function writeClips(projectDir: string): Promise<void> {
    await ensureFfmpeg();
    const ffmpeg = await ffmpegBin();
    const files = path.join(projectDir, "assets", "files");
    await fs.mkdir(files, { recursive: true });
    const source = path.join(files, "source.png");
    await promisify(execFile)(ffmpeg, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "mandelbrot=size=1024x576:rate=1",
      "-frames:v",
      "1",
      source,
    ]);
    const render = async (name: string, filters: string): Promise<void> => {
      await promisify(execFile)(ffmpeg, [
        "-y",
        "-v",
        "error",
        "-loop",
        "1",
        "-i",
        source,
        "-t",
        "4",
        "-vf",
        filters,
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        path.join(files, `${name}.mp4`),
      ]);
    };
    await render("frozen", "fps=12");
    await render(
      "push",
      "zoompan=z='1+0.06*on/(4*12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1024x576:fps=12",
    );
  }

  async function initMotionProject(): Promise<string> {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "motion"));
    await writeClips(projectDir);
    await fs.writeFile(path.join(projectDir, "video.tsx"), MOTION_VIDEO_TSX);
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);
    await run(["generate", "video"], projectDir);
    await run(["job", "wait"], projectDir).catch(() => undefined);
    return projectDir;
  }

  // The temp workspace is per-test, so each test here scaffolds and encodes its own project — hence
  // the longer timeout than the rest of this file.
  it("reads a slow push-in as motion, and a frozen clip as none", async () => {
    const projectDir = await initMotionProject();

    const magnitudeOf = (advisory: string): number =>
      Number(advisory.match(/magnitude ([\d.]+)/)?.[1]);

    const { stderr: pushed } = await run(
      ["probe", "motion", "video:shot.01.motion", "--verbose"],
      projectDir,
    );
    expect(pushed).toContain("busiest tile over 1s");
    expect(magnitudeOf(pushed)).toBeGreaterThan(0.01);
    expect(pushed).not.toContain("nothing in frame moves that far");

    // A clip that moved says nothing beyond its strip path.
    const plain = await run(["probe", "motion", "video:shot.01.motion"], projectDir);
    expect(plain.stdout.trim()).toMatch(/strip-full-f16\.jpg$/);
    expect(plain.stderr).toBe("");

    const { stderr: frozen } = await run(
      ["probe", "motion", "video:shot.02.motion", "--verbose"],
      projectDir,
    );
    expect(magnitudeOf(frozen)).toBeLessThanOrEqual(0.01); // the floor the warning fires on
    expect(frozen).toContain("nothing in frame moves that far");
  }, 30000);

  it("prints the shot's intent under the warning, so the number can be judged", async () => {
    const projectDir = await initMotionProject();

    const { stderr } = await run(["probe", "motion", "video:shot.02.motion"], projectDir);

    expect(stderr).toContain("nothing in frame moves that far");
    // The direction's shot and the board's movement for that same shot.
    expect(stderr).toContain("Review and accept");
    expect(stderr).toContain("The creator carries shot 02 through to its end.");
    expect(stderr).toContain("camera: fixed");
  }, 30000);
});

// One sheet is one stage. Only the first argument's stage was ever read, so a mixed run tiled the
// first stage's shots under the other's ids — an answer to a question nobody asked.
