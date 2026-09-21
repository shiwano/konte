import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineReference, videoFile } from "../dsl/index.js";
import { KonteError } from "../errors.js";
import { syncFileAssets } from "../file-sync.js";
import { StateManager } from "../state/index.js";
import { isVariantStale } from "../staleness.js";
import { plainDirection } from "./helpers/direction.js";

const simpleComfy = defineComfyAsset({
  workflow: "w.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "video" } },
});

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function writeAsset(dir: string, relPath: string, content: string): Promise<void> {
  const absPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-filesync-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("syncFileAssets (reference stage)", () => {
  it("creates an undecided variant for reference file assets", async () => {
    await writeAsset(tmpDir, "assets/files/bg.mp4", "video-data");

    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });

    const manager = await StateManager.init(tmpDir);
    await syncFileAssets({ reference }, manager);

    expect(manager.getAcceptedVariant("reference:bg")).toBeNull();
    const [variant] = Object.values(manager.getAssetState("reference:bg").variants!);
    expect(variant!.status).toBe("none");
    expect(variant!.file).toBe("assets/files/bg.mp4");
  });

  it("skips file assets already synced", async () => {
    await writeAsset(tmpDir, "assets/files/bg.mp4", "video-data");

    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });

    const manager = await StateManager.init(tmpDir);
    await syncFileAssets({ reference }, manager);
    await syncFileAssets({ reference }, manager);

    const state = manager.getState();
    const p = state.assets["reference:bg"]!;
    expect(Object.keys(p.variants ?? {})).toHaveLength(1);
  });

  it("ignores generative reference assets", async () => {
    await writeAsset(tmpDir, "assets/files/bg.mp4", "video-data");

    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      const motion = asset("motion", simpleComfy, {});
      return { bg, motion };
    });

    const manager = await StateManager.init(tmpDir);
    await syncFileAssets({ reference }, manager);

    const state = manager.getState();
    expect(state.assets["reference:motion"]).toBeUndefined();
    expect(state.assets["reference:bg"]).toBeDefined();
  });

  it("validates file existence when validate option is true", async () => {
    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/nonexistent.mp4" });
      return { bg };
    });

    const manager = await StateManager.init(tmpDir);
    await expect(syncFileAssets({ reference }, manager, { validate: true })).rejects.toThrow(
      KonteError,
    );
    await expect(syncFileAssets({ reference }, manager, { validate: true })).rejects.toThrow(
      "does not exist",
    );
  });

  it("stores outputHash from file content", async () => {
    await writeAsset(tmpDir, "assets/files/bg.mp4", "video-content");

    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });

    const manager = await StateManager.init(tmpDir);
    await syncFileAssets({ reference }, manager);

    const [variant] = Object.values(manager.getAssetState("reference:bg").variants!);
    expect(variant!.outputHash).toBe(sha256("video-content"));
  });

  it("updates contentHash in-place and drops the accept when file content changes", async () => {
    await writeAsset(tmpDir, "assets/files/bg.mp4", "original-content");

    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });

    const manager = await StateManager.init(tmpDir);
    await syncFileAssets({ reference }, manager);

    const vid = Object.keys(manager.getAssetState("reference:bg").variants!)[0];
    manager.setAccepted("reference:bg", vid!);
    expect(manager.getAssetState("reference:bg").variants![vid!]!.outputHash).toBe(
      sha256("original-content"),
    );

    await writeAsset(tmpDir, "assets/files/bg.mp4", "updated-content");
    const changed = await syncFileAssets({ reference }, manager);

    expect(changed).toContain("reference:bg");

    const state2 = manager.getState();
    const p2 = state2.assets["reference:bg"]!;
    expect(Object.keys(p2.variants ?? {})).toHaveLength(1);
    expect(p2.variants![vid!]!.outputHash).toBe(sha256("updated-content"));
    expect(p2.variants![vid!]!.status).toBe("none");
  });

  it("makes dependents input-stale when file content changes", async () => {
    await writeAsset(tmpDir, "assets/files/bg.mp4", "original");

    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });

    const manager = await StateManager.init(tmpDir);
    await syncFileAssets({ reference }, manager);

    const motionAddr = "video:shot.01.motion";
    const motionVid = manager.reserveVariantId(motionAddr);
    const motionVariant = manager.getAssetState(motionAddr).variants![motionVid]!;
    motionVariant.file = "out.mp4";
    motionVariant.inputFingerprints = { "reference:bg": sha256("original") };
    manager.setAccepted(motionAddr, motionVid);

    expect(isVariantStale(manager.getState(), motionAddr, motionVariant, null)).toBe(false);

    await writeAsset(tmpDir, "assets/files/bg.mp4", "changed");
    await syncFileAssets({ reference }, manager);

    expect(isVariantStale(manager.getState(), motionAddr, motionVariant, null)).toBe(true);
  });

  it("keeps dependents fresh when file path changes but bytes are identical", async () => {
    await writeAsset(tmpDir, "assets/files/bg.mp4", "original");

    const makeReference = (filePath: `assets/files/${string}`) =>
      defineReference(plainDirection, () => {
        const bg = asset("bg", videoFile, { path: filePath });
        return { bg };
      });

    const manager = await StateManager.init(tmpDir);
    await syncFileAssets({ reference: makeReference("assets/files/bg.mp4") }, manager);

    const motionAddr = "video:shot.01.motion";
    const motionVid = manager.reserveVariantId(motionAddr);
    const motionVariant = manager.getAssetState(motionAddr).variants![motionVid]!;
    motionVariant.file = "out.mp4";
    motionVariant.inputFingerprints = { "reference:bg": sha256("original") };
    manager.setAccepted(motionAddr, motionVid);

    expect(isVariantStale(manager.getState(), motionAddr, motionVariant, null)).toBe(false);

    // Same bytes at a new path: content-addressed staleness keeps the dependent fresh.
    await writeAsset(tmpDir, "assets/files/bg_v2.mp4", "original");
    await syncFileAssets({ reference: makeReference("assets/files/bg_v2.mp4") }, manager);

    expect(isVariantStale(manager.getState(), motionAddr, motionVariant, null)).toBe(false);
  });

  it("does not change outputHash when file content is unchanged", async () => {
    await writeAsset(tmpDir, "assets/files/bg.mp4", "same-content");

    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });

    const manager = await StateManager.init(tmpDir);
    await syncFileAssets({ reference }, manager);

    const motionAddr = "video:shot.01.motion";
    const motionVid = manager.reserveVariantId(motionAddr);
    const motionVariant = manager.getAssetState(motionAddr).variants![motionVid]!;
    motionVariant.file = "out.mp4";
    motionVariant.inputFingerprints = { "reference:bg": sha256("same-content") };
    manager.setAccepted(motionAddr, motionVid);

    expect(isVariantStale(manager.getState(), motionAddr, motionVariant, null)).toBe(false);

    const changed = await syncFileAssets({ reference }, manager);
    expect(changed).toHaveLength(0);
    expect(isVariantStale(manager.getState(), motionAddr, motionVariant, null)).toBe(false);

    const state = manager.getState();
    const p = state.assets["reference:bg"]!;
    expect(Object.keys(p.variants ?? {})).toHaveLength(1);
  });
});
