import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractFrameWithin } from "./frame-extract.js";
import { loadVideoDefinition } from "./loader.js";
import { renderShotCompositeToFile } from "./render-video.js";
import { STAGE_ENTRY_FILE } from "./roots.js";

/** The frame `at` seconds into the shot as it plays in the cut, overlay included, at working size. */
export async function cutShotFrame(opts: {
  videoRoot: string;
  shotId: string;
  at: number;
  outputFile: string;
  resolvedDependencies: Readonly<Record<string, string>>;
}): Promise<void> {
  const video = await loadVideoDefinition(path.resolve(opts.videoRoot, STAGE_ENTRY_FILE.video));
  const composite = path.join(path.dirname(opts.outputFile), "composite.mp4");
  try {
    await renderShotCompositeToFile({
      videoRoot: opts.videoRoot,
      video,
      shotId: opts.shotId,
      allowUnaccepted: true,
      outputFile: composite,
      pinned: opts.resolvedDependencies,
    });
    await extractFrameWithin(composite, opts.at, opts.outputFile);
  } finally {
    await fs.rm(composite, { force: true });
  }
}
