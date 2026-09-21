import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { HYPERFRAME_MANIFEST, HYPERFRAME_RUNTIME } from "./generated/hyperframes-assets.js";
import { toolCacheDir } from "./tool-cache.js";

// The runtime is an embedded asset re-emitted on every konte release, so its identity is its
// content, not a version constant nobody remembers to bump. A changed asset lands in a new dir
// rather than being skipped by the existsSync guard below.
function assetsHash(): string {
  return createHash("sha256")
    .update(HYPERFRAME_MANIFEST)
    .update(HYPERFRAME_RUNTIME)
    .digest("hex")
    .slice(0, 16);
}

export function ensureHyperFramesEnv(): void {
  if (process.env.PRODUCER_HYPERFRAME_MANIFEST_PATH) return;

  const cacheDir = toolCacheDir(`hyperframes-${assetsHash()}`);
  const manifestPath = path.join(cacheDir, "hyperframe.manifest.json");
  const runtimePath = path.join(cacheDir, "hyperframe.runtime.iife.js");

  fs.mkdirSync(cacheDir, { recursive: true });

  if (!fs.existsSync(manifestPath) || !fs.existsSync(runtimePath)) {
    const tmpManifest = `${manifestPath}.${process.pid}.tmp`;
    const tmpRuntime = `${runtimePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpManifest, HYPERFRAME_MANIFEST);
    fs.writeFileSync(tmpRuntime, HYPERFRAME_RUNTIME);
    fs.renameSync(tmpManifest, manifestPath);
    fs.renameSync(tmpRuntime, runtimePath);
  }

  process.env.PRODUCER_HYPERFRAME_MANIFEST_PATH = manifestPath;
}
