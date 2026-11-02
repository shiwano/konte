import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressToCacheSegments } from "../address.js";
import { readVariantThumbnails } from "../variant-thumbnails.js";

describe("readVariantThumbnails", () => {
  const address = "video:shot.01.motion";
  const variantId = "v-abc123";
  const outputHash = "deadbeef";
  let videoRoot: string;

  beforeEach(() => {
    videoRoot = mkdtempSync(path.join(tmpdir(), "konte-thumb-"));
  });
  afterEach(() => {
    rmSync(videoRoot, { recursive: true, force: true });
  });

  function writeManifest(hash: string, frames: { file: string; timestamp: number }[]): void {
    const dir = path.join(
      videoRoot,
      ".konte",
      "cache",
      "thumbnails",
      ...addressToCacheSegments(address),
      variantId,
      hash,
    );
    mkdirSync(dir, { recursive: true });
    for (const f of frames) {
      const abs = path.join(videoRoot, f.file);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "x");
    }
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(frames));
  }

  it("reads the manifest keyed by outputHash", () => {
    const frames = [{ file: "frame.jpg", timestamp: 0 }];
    writeManifest(outputHash, frames);
    expect(readVariantThumbnails(videoRoot, address, variantId, outputHash, "v.mp4")).toEqual(
      frames,
    );
  });

  it("misses when the outputHash differs (bytes changed)", () => {
    writeManifest(outputHash, [{ file: "frame.jpg", timestamp: 0 }]);
    expect(readVariantThumbnails(videoRoot, address, variantId, "newhash", "v.mp4")).toEqual([]);
  });

  it("bypasses the cache when outputHash is null", () => {
    writeManifest(outputHash, [{ file: "frame.jpg", timestamp: 0 }]);
    expect(readVariantThumbnails(videoRoot, address, variantId, null, "v.mp4")).toEqual([]);
  });

  it("returns the file itself for images, ignoring outputHash", () => {
    expect(readVariantThumbnails(videoRoot, address, variantId, null, "still.png")).toEqual([
      { file: "still.png", timestamp: 0 },
    ]);
  });
});
