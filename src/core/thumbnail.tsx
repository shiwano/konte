import * as path from "node:path";
import { CompositionDocument } from "./dsl/composition/composition.js";
import { makeAddressPlaceholder } from "./dsl/shot-context.js";
import {
  renderThumbnailStage,
  type ThumbnailLayout,
  thumbnailRenderContext,
} from "./dsl/stage-define.js";
import { renderToHtml } from "./jsx-html.js";
import { captureHtmlToImage } from "./still-capture.js";
import type { ThumbnailCompose, VideoDefinition } from "./types/index.js";

/**
 * Capture the thumbnail's still to `outputFile` on `layout`. `fileOf` returns the absolute file behind each
 * ref it draws; a ref it returns null for fails the capture.
 */
export async function captureThumbnail(opts: {
  video: VideoDefinition;
  compose: ThumbnailCompose;
  outputFile: string;
  videoRoot: string;
  layout: Omit<ThumbnailLayout, "typography" | "fps">;
  format: "png" | "jpeg";
  quality?: number;
  fileOf: (address: string) => string | null;
}): Promise<void> {
  const layout: ThumbnailLayout = {
    ...opts.layout,
    fps: opts.video.format.fps,
    typography: opts.video.typography,
  };
  let html = renderToHtml(
    <CompositionDocument stageHtml={renderThumbnailStage(opts.compose.fn, layout)} />,
    thumbnailRenderContext(layout, false),
  );
  const assetFiles: Record<string, string> = {};
  // Longest first: one placeholder can be a prefix of another (see `substituteRefs`).
  const refs = [...opts.compose.compositionRefs].sort((a, b) => b.length - a.length);
  for (const [index, address] of refs.entries()) {
    const file = opts.fileOf(address);
    if (file === null) throw new Error(`the thumbnail draws ${address}, which has no ready take`);
    const name = `asset-${index}${path.extname(file)}`;
    assetFiles[name] = file;
    html = html.split(makeAddressPlaceholder(address)).join(name);
  }
  await captureHtmlToImage({
    html,
    assetFiles,
    outputFile: opts.outputFile,
    videoRoot: opts.videoRoot,
    size: layout.crop ?? layout.size,
    format: opts.format,
    ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
  });
}
