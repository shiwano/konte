import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { addressFromCacheSegments, addressToCacheSegments } from "./address.js";
import {
  extractKeyframes,
  type ExtractKeyframesOptions,
  type ThumbnailInfo,
} from "./frame-extract.js";
import { inferMediaType } from "./media-type.js";

// Variant thumbnails live entirely on disk, mirroring the composition-frame cache: the
// keyframes plus a manifest.json recording the scene-detected set (whose timestamps vary
// per run, so filenames alone can't restore them). The files are the source of truth, the
// manifest is the cache index — state holds nothing, so there is no path that can go stale.
// The cache is keyed `<stage>/<suffix>/<variantId>/<outputHash>` (the address split at its `:`
// delimiter into path-safe segments) so a variant whose bytes change (a swapped `file` asset)
// misses on the new hash; clean/prune still delete by variantId.
export function variantThumbnailDir(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string,
): string {
  return path.join(
    videoRoot,
    ".konte",
    "cache",
    "thumbnails",
    ...addressToCacheSegments(address),
    variantId,
    outputHash,
  );
}

// Walk the nested thumbnail cache (`<stage>/<suffix>`) and yield every address-level dir with its
// reconstructed address. Composition caches carry no state and live only on disk, so clean/prune
// enumerate them from here. Returns [] when no thumbnails dir exists yet.
export async function listThumbnailAddressDirs(
  thumbnailsRoot: string,
): Promise<{ address: string; dir: string }[]> {
  const out: { address: string; dir: string }[] = [];
  let stages: string[];
  try {
    stages = await fs.readdir(thumbnailsRoot);
  } catch {
    return out;
  }
  for (const stage of stages) {
    const stageDir = path.join(thumbnailsRoot, stage);
    let suffixes: string[];
    try {
      suffixes = await fs.readdir(stageDir);
    } catch {
      continue;
    }
    for (const suffix of suffixes) {
      out.push({
        address: addressFromCacheSegments([stage, suffix]),
        dir: path.join(stageDir, suffix),
      });
    }
  }
  return out;
}

function variantManifestPath(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string,
): string {
  return path.join(variantThumbnailDir(videoRoot, address, variantId, outputHash), "manifest.json");
}

/**
 * Cached thumbnails for a variant, or [] when none are cached. For images the variant file
 * is itself the thumbnail (nothing to extract). For videos, reads the on-disk manifest and
 * validates every referenced frame still exists. Synchronous so preview/inspect can call it
 * inline without an extraction round-trip.
 */
// Positive manifest cache. A manifest is content-addressed (its path carries the variant's
// outputHash), so a re-read — and the per-frame exists checks — is only needed when the file
// on disk changed; a matching mtime serves the parsed result for one stat call. The preview
// server calls this once per variant per state request, which was thousands of blocking
// syscalls on the request path. clean/prune remove the whole variant dir, so the stat fails
// (ENOENT) and the entry drops.
const manifestCache = new Map<string, { mtimeMs: number; thumbs: ThumbnailInfo[] }>();

export function readVariantThumbnails(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string | null | undefined,
  variantFile: string | null | undefined,
): ThumbnailInfo[] {
  if (!variantFile) return [];
  if (inferMediaType(variantFile) === "image") {
    return [{ file: variantFile, timestamp: 0 }];
  }
  // No content hash (e.g. a `file` asset whose file is missing) → nothing to key the cache on.
  if (!outputHash) return [];

  const manifestPath = variantManifestPath(videoRoot, address, variantId, outputHash);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    manifestCache.delete(manifestPath);
    return [];
  }
  const cached = manifestCache.get(manifestPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.thumbs;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ThumbnailInfo[];
    if (manifest.length > 0 && manifest.every((m) => existsSync(path.resolve(videoRoot, m.file)))) {
      manifestCache.set(manifestPath, { mtimeMs, thumbs: manifest });
      return manifest;
    }
  } catch {
    // corrupt manifest: treat as a cache miss
  }
  return [];
}

/**
 * Ensure a variant's thumbnails exist on disk and return them, extracting keyframes (and
 * writing the manifest) on a cache miss. Images need no extraction — the file is the
 * thumbnail. Pass `force` to re-extract even when a valid cache is present.
 */
export async function ensureVariantThumbnails(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string | null | undefined,
  variantFile: string,
  options?: ExtractKeyframesOptions & { force?: boolean },
): Promise<ThumbnailInfo[]> {
  const mediaType = inferMediaType(variantFile);

  if (mediaType === "image") {
    return [{ file: variantFile, timestamp: 0 }];
  }
  if (mediaType !== "video") return [];
  // No content hash to key on — the only trigger is a `file` asset whose source is missing,
  // so there is nothing to extract from. Mirror readVariantThumbnails and report no cache.
  if (!outputHash) return [];

  if (!options?.force) {
    const cached = readVariantThumbnails(videoRoot, address, variantId, outputHash, variantFile);
    if (cached.length > 0) return cached;
  }

  const dir = variantThumbnailDir(videoRoot, address, variantId, outputHash);
  const rawResults = await extractKeyframes(path.resolve(videoRoot, variantFile), dir, options);
  const thumbnails: ThumbnailInfo[] = rawResults.map((r) => ({
    file: path.relative(videoRoot, r.file),
    timestamp: r.timestamp,
  }));

  // Sweep sibling hash dirs (superseded bytes) for this variant, mirroring the composition
  // cache's pruneSuperseded — clean is variant-scoped and won't reclaim them otherwise.
  pruneSupersededVariantHashes(videoRoot, address, variantId, outputHash);
  try {
    await fs.writeFile(
      variantManifestPath(videoRoot, address, variantId, outputHash),
      JSON.stringify(thumbnails),
      "utf-8",
    );
  } catch {
    // manifest is best-effort; its absence just means a cache miss next time
  }

  return thumbnails;
}

function pruneSupersededVariantHashes(
  videoRoot: string,
  address: string,
  variantId: string,
  currentHash: string,
): void {
  const variantDir = path.join(
    videoRoot,
    ".konte",
    "cache",
    "thumbnails",
    ...addressToCacheSegments(address),
    variantId,
  );
  try {
    for (const entry of readdirSync(variantDir)) {
      if (entry !== currentHash) {
        rmSync(path.join(variantDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // best-effort GC of stale variant thumbnail caches
  }
}
