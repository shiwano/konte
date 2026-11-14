import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KonteError } from "./errors.js";
import { runFfmpeg } from "./ffmpeg-exec.js";

/** 8-bit RGB pixels, row-major from the top left. */
export type RgbImage = { width: number; height: number; data: Uint8Array };

const PPM_HEADER = /^P6\s+(\d+)\s+(\d+)\s+255\s/;

/** `file`'s first frame, upright as its EXIF orientation turns it. */
export async function readRgbImage(file: string): Promise<RgbImage> {
  const { stdout } = await runFfmpeg(
    ["-v", "error", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "ppm", "-"],
    `ffmpeg could not decode ${file}`,
    { encoding: "buffer" },
  );
  const header = PPM_HEADER.exec(stdout.subarray(0, 32).toString("latin1"));
  const width = Number(header?.[1]);
  const height = Number(header?.[2]);
  const start = header?.[0].length ?? 0;
  if (!header || stdout.byteLength - start !== width * height * 3) {
    throw new KonteError("FFMPEG_ERROR", `ffmpeg decoded no RGB image of ${file}`);
  }
  return {
    width,
    height,
    data: new Uint8Array(stdout.buffer, stdout.byteOffset + start, width * height * 3),
  };
}

export async function writePng(image: RgbImage, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const raw = `${file}.${process.pid}.rgb`;
  try {
    await fs.writeFile(raw, image.data);
    await runFfmpeg(
      [
        "-v",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        `${image.width}x${image.height}`,
        "-i",
        raw,
        "-frames:v",
        "1",
        file,
      ],
      `ffmpeg could not write ${file}`,
    );
  } finally {
    await fs.rm(raw, { force: true });
  }
}
