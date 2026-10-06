import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { hashFile } from "./content-hash.js";
import { KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin, SINGLE_FRAME_INPUT_ARGS, SINGLE_FRAME_OUTPUT_ARGS } from "./ffmpeg-binary.js";
import { variantThumbnailDir } from "./thumbnail.js";

const MAX_EDGE = 1280;
const MAX_BYTES = 512 * 1024;
const QUALITIES = [3, 6];

export async function probeImage(options: {
  videoRoot: string;
  address: string;
  variantId: string;
  file: string;
  outputHash?: string | null;
  force?: boolean;
}): Promise<string> {
  const { videoRoot, address, variantId, file, outputHash, force } = options;
  const source = path.resolve(videoRoot, file);
  let hash: string;
  try {
    if (outputHash) {
      await fs.access(source);
      hash = outputHash;
    } else {
      hash = await hashFile(source);
    }
  } catch (err) {
    throw new KonteError("VARIANT_NOT_FOUND", `Cannot read ${variantId}: ${errorMessage(err)}`);
  }
  const output = path.join(variantThumbnailDir(videoRoot, address, variantId, hash), "image.jpg");
  if (!force) {
    const cached = await fs.stat(output).catch(() => null);
    if (cached && cached.size > 0) return output;
  }

  const ffmpeg = await ffmpegBin();
  const attempts: [edge: number, quality: number][] = [];
  for (let edge = MAX_EDGE; edge >= 40; edge = Math.floor(edge / 2)) {
    for (const quality of QUALITIES) attempts.push([edge, quality]);
  }
  for (const [edge, quality] of attempts) {
    let stdout: Buffer;
    try {
      ({ stdout } = await execFileAsync(
        ffmpeg,
        [
          "-v",
          "error",
          ...SINGLE_FRAME_INPUT_ARGS,
          "-i",
          source,
          "-filter_complex",
          `[0:v]scale=w='min(iw,${edge})':h='min(ih,${edge})':force_original_aspect_ratio=decrease,format=rgba,split[fg][bg];[bg]lut=r=238:g=238:b=238:a=255[base];[base][fg]overlay=shortest=1:format=auto,format=yuvj444p[out]`,
          "-map",
          "[out]",
          "-frames:v",
          "1",
          ...SINGLE_FRAME_OUTPUT_ARGS,
          "-c:v",
          "mjpeg",
          "-q:v",
          String(quality),
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        { encoding: "buffer" },
      ));
    } catch (err) {
      throw new KonteError(
        "FFMPEG_ERROR",
        `Image probe failed for ${variantId}: ${errorMessage(err)}`,
      );
    }
    if (stdout.length > 0 && stdout.length <= MAX_BYTES) {
      await writeFileAtomic(output, stdout);
      return output;
    }
  }
  throw new KonteError("FFMPEG_ERROR", `Cannot fit ${variantId}'s image probe within 512 KiB`);
}
