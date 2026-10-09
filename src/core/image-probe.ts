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

function gridFilters(step: number, labelled: boolean): string[] {
  const filters: string[] = [];
  for (let k = step; k < 100 - 1e-9; k += step) {
    const at = Number(k.toFixed(4));
    filters.push(
      `drawbox=x=iw*${at}/100:y=0:w=1:h=ih:color=magenta@0.8:t=fill`,
      `drawbox=x=0:y=ih*${at}/100:w=iw:h=1:color=magenta@0.8:t=fill`,
    );
    if (labelled) {
      const text = `drawtext=text='${at}%':expansion=none:fontsize=max(11\\,min(W\\,H)/60):fontcolor=white:box=1:boxcolor=magenta@0.8:boxborderw=2`;
      filters.push(`${text}:x=W*${at}/100+3:y=3`, `${text}:x=3:y=H*${at}/100+3`);
    }
  }
  return filters;
}

export async function probeImage(options: {
  videoRoot: string;
  address: string;
  variantId: string;
  file: string;
  outputHash?: string | null;
  /** Percent step of a grid drawn over the image. */
  grid?: number;
  force?: boolean;
}): Promise<{ path: string; labelled: boolean }> {
  const { videoRoot, address, variantId, file, outputHash, grid, force } = options;
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
  const dir = variantThumbnailDir(videoRoot, address, variantId, hash);
  const output = path.join(dir, grid ? `image-grid${grid}.jpg` : "image.jpg");
  if (!force) {
    const cached = await fs.stat(output).catch(() => null);
    if (cached && cached.size > 0) return { path: output, labelled: true };
  }
  if (!grid) return { path: await encode(source, variantId, output, []), labelled: true };
  try {
    return {
      path: await encode(source, variantId, output, gridFilters(grid, true)),
      labelled: true,
    };
  } catch (err) {
    if (!(err instanceof KonteError && err.code === "FFMPEG_ERROR")) throw err;
    // Kept apart from the labelled name so a later run with a usable font renders the labels.
    const plain = path.join(dir, `image-grid${grid}-unlabelled.jpg`);
    return {
      path: await encode(source, variantId, plain, gridFilters(grid, false)),
      labelled: false,
    };
  }
}

async function encode(
  source: string,
  variantId: string,
  output: string,
  overlays: string[],
): Promise<string> {
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
          `[0:v]scale=w='min(iw,${edge})':h='min(ih,${edge})':force_original_aspect_ratio=decrease,format=rgba,split[fg][bg];[bg]lut=r=238:g=238:b=238:a=255[base];[base][fg]overlay=shortest=1:format=auto,${[...overlays, "format=yuvj444p"].join(",")}[out]`,
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
