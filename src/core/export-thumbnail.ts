import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  formatThumbnailAddress,
  isThumbnailAddress,
  parseAddress,
  THUMBNAIL_FRAME_ADDRESS,
  thumbnailCoverAddress,
} from "./address.js";
import { resolveCompositionRef } from "./composition-refs.js";
import { runFfmpeg } from "./ffmpeg-exec.js";
import { extractFrameWithin } from "./frame-extract.js";
import { extractRefs } from "./graph.js";
import type { StateManager } from "./state/index.js";
import { captureThumbnail } from "./thumbnail.js";
import type { LocalAssetDefinition, VideoDefinition } from "./types/index.js";

// The file an export writes beside its `video.mp4`.
export const THUMBNAIL_EXPORT_FILE = "thumbnail.jpg";

const THUMBNAIL_EXPORT_QUALITY = 90;

/**
 * Runs one local op over the given dependency files into `outputDir` and returns its output. The
 * export job hands the local backend in.
 */
export type RederiveLocal = (
  address: string,
  definition: LocalAssetDefinition,
  resolvedDependencies: Record<string, string>,
  outputDir: string,
) => Promise<string>;

/**
 * Write the video's thumbnail beside its deliverable. With no delivery size, or a patched cover, it
 * is the cover's take, scaled and cropped to `layout`. Otherwise the frame at `thumbnail.at` is cut
 * from `deliverable`, or the still its compose lays out at `layout` like the shots, drawing that
 * frame. A layer the export upscaled (`delivered`, source address → upscaled file) is drawn from
 * the upscale, and a `videoFrame` of the thumbnail built on one, however deep, is taken again from
 * it. Any other op keeps its working-size take: its geometry is in the working take's pixels. Null
 * when the video declares no thumbnail; a ref with no take refuses the capture.
 */
export async function exportThumbnail(opts: {
  video: VideoDefinition;
  manager: StateManager;
  outputDir: string;
  deliverable: string;
  layout: { size: { width: number; height: number }; crop?: { width: number; height: number } };
  delivered: ReadonlyMap<string, string>;
  rederive?: RederiveLocal;
}): Promise<string | null> {
  const { video, manager, outputDir } = opts;
  const thumbnail = video.thumbnail;
  if (!thumbnail) return null;

  const outputFile = path.join(outputDir, THUMBNAIL_EXPORT_FILE);
  const coverAddress = thumbnailCoverAddress(thumbnail);
  const cover = resolveCompositionRef(manager, coverAddress);
  const patched =
    cover && manager.getState().assets[coverAddress]?.variants?.[cover.variantId]?.derivedFrom;
  if (!opts.layout.crop || patched) {
    if (!cover) throw new Error(`the thumbnail's cover ${coverAddress} has no ready take`);
    await writeCoverJpeg(cover.file, opts.layout, outputFile);
    return outputFile;
  }
  const compose = thumbnail.compose;
  if (!compose) {
    await extractFrameWithin(opts.deliverable, thumbnail.frame!.at, outputFile);
    return outputFile;
  }
  const workDir = path.join(outputDir, ".thumbnail");
  const files = new Map<string, string>();
  const delivered = new DeliveredFiles(opts, workDir);
  try {
    if (thumbnail.frame) {
      const frameFile = path.join(workDir, "frame.png");
      await extractFrameWithin(opts.deliverable, thumbnail.frame.at, frameFile);
      files.set(THUMBNAIL_FRAME_ADDRESS, frameFile);
    }
    for (const ref of compose.compositionRefs) {
      if (files.has(ref)) continue;
      const file = (await delivered.of(ref)) ?? resolveCompositionRef(manager, ref)?.file ?? null;
      if (!file) throw new Error(`the thumbnail draws ${ref}, which has no ready take`);
      files.set(ref, file);
    }
    await captureThumbnail({
      video,
      compose,
      outputFile,
      videoRoot: manager.videoRoot,
      layout: opts.layout,
      format: "jpeg",
      quality: THUMBNAIL_EXPORT_QUALITY,
      fileOf: (address) => files.get(address) ?? null,
    });
    return outputFile;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// The cover take as the delivered thumbnail: filled to `layout.size`, then its centre cut to
// `layout.crop`.
async function writeCoverJpeg(
  file: string,
  layout: { size: { width: number; height: number }; crop?: { width: number; height: number } },
  outputFile: string,
): Promise<void> {
  const { size, crop } = layout;
  const filters = [`scale=${size.width}:${size.height},setsar=1`];
  if (crop) {
    filters.push(
      `crop=${crop.width}:${crop.height}:(in_w-${crop.width})/2:(in_h-${crop.height})/2`,
    );
  }
  await runFfmpeg(
    ["-y", "-i", file, "-vf", filters.join(","), "-frames:v", "1", "-q:v", "2", outputFile],
    "write the thumbnail",
  );
}

// The file an address stands at on the delivered frame, or null where that is its working-size
// take: an upscaled layer's upscale, or a thumbnail frame taken again from one. A patched take is
// never re-made. Memoized per export.
class DeliveredFiles {
  private readonly made = new Map<string, Promise<string | null>>();

  constructor(
    private readonly opts: {
      video: VideoDefinition;
      manager: StateManager;
      delivered: ReadonlyMap<string, string>;
      rederive?: RederiveLocal;
    },
    private readonly workDir: string,
  ) {}

  of(address: string): Promise<string | null> {
    const upscaled = this.opts.delivered.get(address);
    if (upscaled) return Promise.resolve(upscaled);
    let made = this.made.get(address);
    if (!made) {
      made = this.remake(address);
      this.made.set(address, made);
    }
    return made;
  }

  private async remake(address: string): Promise<string | null> {
    const { video, manager, rederive } = this.opts;
    if (!rederive || this.opts.delivered.size === 0 || !isThumbnailAddress(address)) return null;
    const name = parseAddress(address).assetName;
    const definition = video.thumbnail?.assets[name];
    if (definition?.kind !== "local" || definition.operation !== "frame") return null;
    const resolved = resolveCompositionRef(manager, address);
    const patched =
      resolved && manager.getState().assets[address]?.variants?.[resolved.variantId]?.derivedFrom;
    if (patched) return null;
    const deps = extractRefs(definition);
    const remade = await Promise.all(deps.map((dep) => this.of(dep)));
    if (remade.every((file) => file === null)) return null;
    const resolvedDependencies: Record<string, string> = {};
    for (const [i, dep] of deps.entries()) {
      const file = remade[i] ?? resolveCompositionRef(manager, dep)?.file;
      if (!file) throw new Error(`${address} is built on ${dep}, which has no ready take`);
      resolvedDependencies[dep] = file;
    }
    return rederive(
      formatThumbnailAddress(name),
      definition,
      resolvedDependencies,
      path.join(this.workDir, name),
    );
  }
}
