import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "./content-hash.js";
import { HYPERFRAME_MANIFEST, HYPERFRAME_RUNTIME } from "./generated/hyperframes-assets.js";
import { provisionOnce, toolCacheDir } from "./tool-cache.js";

const MANIFEST = "hyperframe.manifest.json";
const RUNTIME = "hyperframe.runtime.iife.js";

// The embedded runtime's identity is its content; a changed asset lands in a new dir.
function assetsHash(): string {
  return sha256Hex(HYPERFRAME_MANIFEST, HYPERFRAME_RUNTIME).slice(0, 16);
}

export async function ensureHyperFramesEnv(): Promise<void> {
  if (process.env.PRODUCER_HYPERFRAME_MANIFEST_PATH) return;

  const hash = assetsHash();
  const dir = toolCacheDir(`hyperframes-${hash}`);
  await provisionOnce({
    dir,
    pin: hash,
    files: [MANIFEST, RUNTIME],
    label: "HyperFrames runtime",
    errorCode: "HYPERFRAMES_ERROR",
    fill: async () => {
      fs.writeFileSync(path.join(dir, MANIFEST), HYPERFRAME_MANIFEST);
      fs.writeFileSync(path.join(dir, RUNTIME), HYPERFRAME_RUNTIME);
    },
  });

  process.env.PRODUCER_HYPERFRAME_MANIFEST_PATH = path.join(dir, MANIFEST);
}
