import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashFile } from "../content-hash.js";
import { execFileAsync } from "../exec-file.js";
import { ffmpegBin, SINGLE_FRAME_INPUT_ARGS, SINGLE_FRAME_OUTPUT_ARGS } from "../ffmpeg-binary.js";
import { probeImage } from "../image-probe.js";
import { probeVideo } from "../thumbnail.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-image-probe-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function source(filter: string): Promise<string> {
  const file = path.join(dir, "source.png");
  await execFileAsync(await ffmpegBin(), [
    "-v",
    "error",
    "-y",
    ...SINGLE_FRAME_INPUT_ARGS,
    "-f",
    "lavfi",
    "-i",
    filter,
    "-frames:v",
    "1",
    ...SINGLE_FRAME_OUTPUT_ARGS,
    file,
  ]);
  return file;
}

async function probe(file: string, grid?: number) {
  const result = await probeImage({
    videoRoot: dir,
    address: "reference:portrait",
    variantId: "v-test",
    file,
    grid,
  });
  return result.path;
}

async function pixel(file: string, x: number, y: number): Promise<number[]> {
  const { stdout } = await execFileAsync(
    await ffmpegBin(),
    [
      "-v",
      "error",
      ...SINGLE_FRAME_INPUT_ARGS,
      "-i",
      file,
      "-frames:v",
      "1",
      ...SINGLE_FRAME_OUTPUT_ARGS,
      "-vf",
      `crop=1:1:${x}:${y}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  return [...stdout.subarray(0, 3)];
}

describe("probeImage", () => {
  it("bounds a noisy image, keeps its aspect ratio, and preserves the source", async () => {
    const file = await source("nullsrc=s=2048x1024,geq=random(1)*255:128:128");
    const original = await hashFile(file);
    const result = await probe(file);
    const media = await probeVideo(result);
    expect(media.width).toBeLessThanOrEqual(1280);
    expect(media.width / media.height).toBeCloseTo(2, 1);
    expect((await fs.stat(result)).size).toBeLessThanOrEqual(512 * 1024);
    expect(await hashFile(file)).toBe(original);
    expect(result.endsWith(".jpg")).toBe(true);
  }, 30_000);

  it("flattens alpha onto light gray without enlarging small images", async () => {
    const file = await source("color=red@0:s=65x33,format=rgba");
    const result = await probe(file);
    expect(await probeVideo(result)).toMatchObject({ width: 65, height: 33 });
    const { stdout } = await execFileAsync(
      await ffmpegBin(),
      [
        "-v",
        "error",
        ...SINGLE_FRAME_INPUT_ARGS,
        "-i",
        result,
        "-frames:v",
        "1",
        ...SINGLE_FRAME_OUTPUT_ARGS,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    for (const value of stdout.subarray(0, 3)) expect(Math.abs(value - 238)).toBeLessThanOrEqual(2);
  }, 30_000);

  it("reuses cached bytes and invalidates the cache when the source changes", async () => {
    const file = await source("color=red:s=64x32");
    const first = await probe(file);
    await fs.utimes(first, 1000, 1000);
    expect(await probe(file)).toBe(first);
    expect((await fs.stat(first)).mtimeMs).toBe(1_000_000);
    await source("color=blue:s=64x32");
    expect(await probe(file)).not.toBe(first);
  }, 30_000);

  it("keys the cache by a recorded output hash", async () => {
    const file = await source("color=red:s=64x32");
    const result = await probeImage({
      videoRoot: dir,
      address: "reference:portrait",
      variantId: "v-test",
      file,
      outputHash: "recorded",
    });
    expect(result.path.split(path.sep)).toContain("recorded");
  }, 30_000);

  it("draws a grid line at each percent step of the scaled image, cached apart", async () => {
    const file = await source("color=white:s=2000x1000");
    const plain = await probe(file);
    const gridded = await probe(file, 25);
    expect(gridded).not.toBe(plain);
    expect(await probeVideo(gridded)).toMatchObject({ width: 1280, height: 640 });
    const [r, g, b] = await pixel(gridded, 640, 400);
    expect(r! - g!).toBeGreaterThan(80);
    expect(b! - g!).toBeGreaterThan(80);
    expect(Math.min(...(await pixel(gridded, 700, 400)))).toBeGreaterThan(230);
  }, 30_000);

  it("refuses invalid images without publishing a cache entry", async () => {
    const file = path.join(dir, "broken.png");
    await fs.writeFile(file, "not an image");
    await expect(probe(file)).rejects.toMatchObject({ code: "FFMPEG_ERROR" });
    await expect(fs.stat(path.join(dir, ".konte"))).rejects.toThrow();
  });
});
