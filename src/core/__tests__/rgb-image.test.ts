import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileAsync } from "../exec-file.js";
import { ffmpegBin } from "../ffmpeg-binary.js";
import { readRgbImage } from "../rgb-image.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-rgb-image-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// An 80×40 JPEG whose EXIF orientation turns it a quarter, to stand 40×80.
async function turnedJpeg(): Promise<string> {
  const file = path.join(dir, "turned.jpg");
  await execFileAsync(await ffmpegBin(), [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=80x40",
    "-frames:v",
    "1",
    file,
  ]);
  const jpeg = await fs.readFile(file);
  const ifd = Buffer.alloc(18);
  ifd.writeUInt16LE(1, 0);
  ifd.writeUInt16LE(0x112, 2);
  ifd.writeUInt16LE(3, 4);
  ifd.writeUInt32LE(1, 6);
  ifd.writeUInt16LE(6, 10);
  const tiff = Buffer.concat([Buffer.from("II*\0\x08\0\0\0", "latin1"), ifd]);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  await fs.writeFile(file, Buffer.concat([jpeg.subarray(0, 2), app1, exif, jpeg.subarray(2)]));
  return file;
}

describe("readRgbImage", () => {
  it("reads a JPEG upright, as its EXIF orientation turns it", async () => {
    const image = await readRgbImage(await turnedJpeg());
    expect([image.width, image.height]).toEqual([40, 80]);
    expect(image.data.length).toBe(40 * 80 * 3);
  });
});
