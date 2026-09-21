import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { annotateFrameWithPin, pinReticleFilters, planPinReticle } from "../annotate-frame.js";
import { ffmpegBin } from "../ffmpeg-binary.js";

const execFileAsync = promisify(execFile);

describe("planPinReticle", () => {
  it("centers the reticle on the pin", () => {
    const { boxes } = planPinReticle(1920, 1080, 0.5, 0.5);
    const mark = boxes[1]!;
    expect(mark.x + mark.size / 2).toBe(960);
    expect(mark.y + mark.size / 2).toBe(540);
  });

  it("nests a bright ring between two dark ones, each one stroke thick", () => {
    const { boxes, stroke } = planPinReticle(1920, 1080, 0.5, 0.5);
    expect(boxes.map((b) => b.color)).toEqual(["0x000000@0.85", "0xFFE000@1.0", "0x000000@0.85"]);
    // Contiguous: each ring starts exactly where the previous one ended.
    expect(boxes[1]!.x - boxes[0]!.x).toBe(stroke);
    expect(boxes[2]!.x - boxes[1]!.x).toBe(stroke);
    expect(boxes[0]!.size - boxes[1]!.size).toBe(stroke * 2);
    expect(boxes[1]!.size - boxes[2]!.size).toBe(stroke * 2);
  });

  it("scales the reticle with the frame's short edge", () => {
    const large = planPinReticle(3840, 2160, 0.5, 0.5);
    const small = planPinReticle(960, 540, 0.5, 0.5);
    expect(large.stroke).toBeGreaterThan(small.stroke);
    expect(large.boxes[1]!.size).toBeGreaterThan(small.boxes[1]!.size);
  });

  it("keeps the mark visible on a tiny frame", () => {
    // A 48px floor: below it the ring collapses into a dot at contact-sheet scale.
    const { boxes, stroke } = planPinReticle(160, 90, 0.5, 0.5);
    expect(boxes[1]!.size).toBe(48);
    expect(stroke).toBe(2);
  });

  it("lets a pin at the frame edge run off it rather than moving the mark inward", () => {
    const { boxes } = planPinReticle(1920, 1080, 0, 0);
    expect(boxes[0]!.x).toBeLessThan(0);
    expect(boxes[0]!.y).toBeLessThan(0);
  });

  it("clamps a coordinate that arrived outside the frame", () => {
    const past = planPinReticle(1920, 1080, 1.4, -0.2);
    const edge = planPinReticle(1920, 1080, 1, 0);
    expect(past).toEqual(edge);
  });

  it("drops the innermost ring rather than emitting a negative box", () => {
    // The reticle is capped but the stroke is not, so past some size the two rings fill it.
    const { boxes } = planPinReticle(30000, 30000, 0.5, 0.5);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box.size).toBeGreaterThan(0);
  });
});

describe("pinReticleFilters", () => {
  it("emits one drawbox per ring, all at the plan's stroke", () => {
    const geometry = planPinReticle(1920, 1080, 0.25, 0.75);
    const filters = pinReticleFilters(geometry).split(",");
    expect(filters).toHaveLength(geometry.boxes.length);
    for (const [i, filter] of filters.entries()) {
      const box = geometry.boxes[i]!;
      expect(filter).toBe(
        `drawbox=x=${box.x}:y=${box.y}:w=${box.size}:h=${box.size}:color=${box.color}:t=${geometry.stroke}`,
      );
    }
  });
});

// A rejected color or an out-of-frame box fails silently and drops the mark, so these run the real
// ffmpeg and assert on pixels.
describe("annotateFrameWithPin", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-annotate-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** One pixel's RGB, so a test can assert the mark landed rather than that ffmpeg exited 0. */
  async function samplePixel(
    file: string,
    x: number,
    y: number,
  ): Promise<[number, number, number]> {
    const { stdout } = await execFileAsync(
      await ffmpegBin(),
      [
        "-i",
        file,
        "-vf",
        `format=rgb24,crop=1:1:${x}:${y}`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { encoding: "buffer" },
    );
    return [stdout[0]!, stdout[1]!, stdout[2]!];
  }

  async function writeSource(): Promise<string> {
    const file = path.join(dir, "frame.jpg");
    await execFileAsync(await ffmpegBin(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=640x360",
      "-frames:v",
      "1",
      file,
    ]);
    return file;
  }

  it("burns the mark onto the frame, leaving the source and the pinned spot untouched", async () => {
    const source = await writeSource();
    const before = await fs.readFile(source);
    const output = path.join(dir, "frame-pin.jpg");

    await expect(
      annotateFrameWithPin({ sourceFile: source, outputFile: output, x: 0.5, y: 0.5 }),
    ).resolves.toBe(true);

    const mark = planPinReticle(640, 360, 0.5, 0.5).boxes[1]!;
    const [r, g, b] = await samplePixel(output, mark.x + 1, mark.y + 1);
    // JPEG is lossy, so assert the hue rather than the exact 0xFFE000.
    expect(r).toBeGreaterThan(180);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeLessThan(120);

    // The reticle is hollow: what the pin points at is still the source's own picture.
    const [cr, cg, cb] = await samplePixel(output, 320, 180);
    expect(Math.max(Math.abs(cr - cg), Math.abs(cg - cb))).toBeLessThan(12);

    expect(await fs.readFile(source)).toEqual(before);
    expect((await fs.readdir(dir)).sort()).toEqual(["frame-pin.jpg", "frame.jpg"]);
  });

  it("draws a pin at the frame's corner rather than failing on the boxes that run off it", async () => {
    const source = await writeSource();
    const output = path.join(dir, "corner-pin.jpg");

    await expect(
      annotateFrameWithPin({ sourceFile: source, outputFile: output, x: 0, y: 0 }),
    ).resolves.toBe(true);

    // The quarter of the reticle that stays on frame is drawn; the rest clips away.
    const mark = planPinReticle(640, 360, 0, 0).boxes[1]!;
    const [r, , b] = await samplePixel(output, mark.x + mark.size - 1, 1);
    expect(r).toBeGreaterThan(180);
    expect(b).toBeLessThan(120);
  });

  it("reports failure and leaves nothing behind when the source cannot be read", async () => {
    const output = path.join(dir, "missing-pin.jpg");

    await expect(
      annotateFrameWithPin({
        sourceFile: path.join(dir, "missing.jpg"),
        outputFile: output,
        x: 0.5,
        y: 0.5,
      }),
    ).resolves.toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
