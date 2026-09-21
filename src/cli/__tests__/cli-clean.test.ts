import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressToCacheSegments } from "../../core/address.js";
import { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/manager.js";
import {
  useTempWorkspace,
  initWithCrossStageStemVideo,
  initWithTestVideo,
  run,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

// "Removed: <address> <variantId> (<status>)" — the one line clean prints per reclaimed variant.
const removedLines = (stdout: string) => [
  ...stdout.matchAll(/^(?:Removed|Would remove): (\S+) (v-\S+) \(/gm),
];
const removedVariantIds = (stdout: string) => removedLines(stdout).map((m) => m[2]!);
const removedAddresses = (stdout: string) => removedLines(stdout).map((m) => m[1]!);

describe("clean command", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  const bareAddress = "shot.01.motion";

  // A settled job and its log, both of which clean must reclaim with the variant.
  async function seedSettledJob(vid: string): Promise<void> {
    const jm = new JobManager(projectDir);
    await jm.createJob({ address, variantId: vid, resolvedDeps: {}, backendKind: "fal" });
    await jm.updateJob(vid, { status: "completed", completedAt: new Date().toISOString() });
    await fs.writeFile(path.join(projectDir, `.konte/logs/${vid}.log`), "log");
  }

  async function setupVariants(): Promise<{ v1: string; v2: string; v3: string }> {
    const sm = await StateManager.load(projectDir);

    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = `assets/video/${bareAddress}/${v1}/output.mp4`;
    sm.setAccepted(address, v1);

    const v2 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v2]!.file = `assets/video/${bareAddress}/${v2}/output.mp4`;

    const v3 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v3]!.file = `assets/video/${bareAddress}/${v3}/output.mp4`;

    await sm.save();

    await fs.mkdir(path.join(projectDir, `assets/video/${bareAddress}/${v1}`), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, `assets/video/${bareAddress}/${v2}`), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, `assets/video/${bareAddress}/${v3}`), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, `assets/video/${bareAddress}/${v1}/output.mp4`),
      "data",
    );
    await fs.writeFile(
      path.join(projectDir, `assets/video/${bareAddress}/${v2}/output.mp4`),
      "data",
    );
    await fs.writeFile(
      path.join(projectDir, `assets/video/${bareAddress}/${v3}/output.mp4`),
      "data",
    );

    await seedSettledJob(v2);
    await seedSettledJob(v3);

    return { v1, v2, v3 };
  }

  it("removes non-accepted variants with --delete-unaccepted", async () => {
    const { v1, v2, v3 } = await setupVariants();

    const { stdout } = await run(["clean", "--delete-unaccepted", "--yes"], projectDir);

    expect(removedVariantIds(stdout).sort()).toEqual([v2, v3].sort());

    const sm = await StateManager.load(projectDir);
    const target = sm.getAssetState(address);
    expect(target.variants![v1]!).toBeDefined();
    expect(target.variants![v2]!).toBeUndefined();
    expect(target.variants![v3]!).toBeUndefined();

    await fs.access(path.join(projectDir, `assets/video/${bareAddress}/${v1}`));
    await expect(
      fs.access(path.join(projectDir, `assets/video/${bareAddress}/${v2}`)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(projectDir, `assets/video/${bareAddress}/${v3}`)),
    ).rejects.toThrow();
    const jm = new JobManager(projectDir);
    await expect(jm.getJob(v2)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(fs.access(path.join(projectDir, `.konte/logs/${v2}.log`))).rejects.toThrow();
  });

  it("reclaims a dead composition leftover without --delete-unaccepted", async () => {
    // A ghost: a composition variant whose upstream motion/voice were never generated, so the
    // current definition can no longer materialize it. It is pure garbage, so plain `clean`
    // (no --delete-unaccepted) reclaims it even though it has a file.
    const compAddr = "video:shot.01#composition";
    const compSeg = "shot.01#composition";
    const sm = await StateManager.load(projectDir);
    const ghost = sm.reserveVariantId(compAddr);
    sm.getAssetState(compAddr).variants![ghost]!.file =
      `assets/video/${compSeg}/${ghost}/composition.html`;
    await sm.save();
    await fs.mkdir(path.join(projectDir, `assets/video/${compSeg}/${ghost}`), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, `assets/video/${compSeg}/${ghost}/composition.html`),
      "<html>",
    );

    const { stdout } = await run(["clean", "--yes"], projectDir);
    expect(removedVariantIds(stdout)).toContain(ghost);

    const after = await StateManager.load(projectDir);
    expect(after.tryGetAssetState(compAddr)?.variants?.[ghost]).toBeUndefined();
    await expect(
      fs.access(path.join(projectDir, `assets/video/${compSeg}/${ghost}`)),
    ).rejects.toThrow();
  });

  it("removes a cleaned variant's audio and thumbnail caches", async () => {
    const { v2 } = await setupVariants();

    const audioCache = path.join(projectDir, ".konte/cache/audio", v2);
    const thumbCache = path.join(
      projectDir,
      ".konte/cache/thumbnails",
      ...addressToCacheSegments(address),
      v2,
    );
    await fs.mkdir(path.join(audioCache, "hash"), { recursive: true });
    await fs.writeFile(path.join(audioCache, "hash.json"), "{}");
    await fs.mkdir(path.join(thumbCache, "hash"), { recursive: true });
    await fs.writeFile(path.join(thumbCache, "hash/manifest.json"), "[]");

    await run(["clean", "--delete-unaccepted", "--yes"], projectDir);

    await expect(fs.access(audioCache)).rejects.toThrow();
    await expect(fs.access(thumbCache)).rejects.toThrow();
  });

  it("removes composition thumbnail caches but leaves feedback frames", async () => {
    const compDir = path.join(
      projectDir,
      ".konte/cache/thumbnails/video/shot.01#composition/abc123def456",
    );
    await fs.mkdir(compDir, { recursive: true });
    await fs.writeFile(path.join(compDir, "keyframe-001.jpeg"), "img");

    // A feedback-frame dir is addressed by the shot (not the composition asset) and is a
    // persistent reference, so clean must leave it alone.
    const feedbackDir = path.join(projectDir, ".konte/cache/thumbnails/video/shot.01/fb-1");
    await fs.mkdir(feedbackDir, { recursive: true });
    await fs.writeFile(path.join(feedbackDir, "frame.jpeg"), "img");

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(stdout.match(/\(composition cache\)/g)).toHaveLength(1);
    await expect(
      fs.access(path.join(projectDir, ".konte/cache/thumbnails/video/shot.01#composition")),
    ).rejects.toThrow();
    await fs.access(feedbackDir);
  });

  it("only removes composition caches within the address-scope", async () => {
    const s1 = path.join(projectDir, ".konte/cache/thumbnails/video/shot.01#composition/h1");
    const s2 = path.join(projectDir, ".konte/cache/thumbnails/video/shot.02#composition/h2");
    await fs.mkdir(s1, { recursive: true });
    await fs.mkdir(s2, { recursive: true });
    await fs.writeFile(path.join(s1, "keyframe-001.jpeg"), "img");
    await fs.writeFile(path.join(s2, "keyframe-001.jpeg"), "img");

    const { stdout } = await run(["clean", "video:shot.01", "--yes"], projectDir);

    expect(stdout.match(/\(composition cache\)/g)).toHaveLength(1);
    await expect(
      fs.access(path.join(projectDir, ".konte/cache/thumbnails/video/shot.01#composition")),
    ).rejects.toThrow();
    await fs.access(path.join(projectDir, ".konte/cache/thumbnails/video/shot.02#composition"));
  });

  // A clone: git never tracked v2's media, so its row is all there is.
  describe("an absent variant", () => {
    async function recordedVariantIds(): Promise<string[]> {
      const raw = JSON.parse(await fs.readFile(path.join(projectDir, "konte.state.json"), "utf-8"));
      return Object.keys(raw.assets[address].variants);
    }

    it("is discarded with --delete-unaccepted", async () => {
      const { v1, v2, v3 } = await setupVariants();
      await fs.rm(path.join(projectDir, `assets/video/${bareAddress}/${v2}`), { recursive: true });

      const { stdout } = await run(["clean", "--delete-unaccepted", "--yes"], projectDir);

      expect(removedVariantIds(stdout).sort()).toEqual([v2, v3].sort());
      expect(await recordedVariantIds()).toEqual([v1]);
    });

    it("is left alone without --delete-unaccepted", async () => {
      const { v1, v2, v3 } = await setupVariants();
      await fs.rm(path.join(projectDir, `assets/video/${bareAddress}/${v2}`), { recursive: true });

      const { stdout } = await run(["clean"], projectDir);

      expect(stdout).not.toContain(v2);
      expect(await recordedVariantIds()).toEqual([v1, v2, v3]);
    });
  });

  it("skips non-accepted variants with files without --delete-unaccepted", async () => {
    const { v1, v2, v3 } = await setupVariants();

    const { stdout } = await run(["clean"], projectDir);

    expect(removedVariantIds(stdout)).toEqual([]);
    expect(stdout).toContain("unaccepted take holding generated media");
    expect(stdout).toContain("2 unaccepted take(s) with media kept.");
    expect(stdout).not.toContain("--delete-unaccepted");

    const sm = await StateManager.load(projectDir);
    const target = sm.getAssetState(address);
    expect(target.variants![v1]!).toBeDefined();
    expect(target.variants![v2]!).toBeDefined();
    expect(target.variants![v3]!).toBeDefined();
  });

  it("does not delete in dry-run mode", async () => {
    const { v2, v3 } = await setupVariants();

    const { stdout } = await run(["clean", "--delete-unaccepted", "--dry-run"], projectDir);

    expect(stdout.match(/^Would remove: /gm)).toHaveLength(2);

    const sm = await StateManager.load(projectDir);
    const target = sm.getAssetState(address);
    expect(target.variants![v2]!).toBeDefined();
    expect(target.variants![v3]!).toBeDefined();

    await fs.access(path.join(projectDir, `assets/video/${bareAddress}/${v2}`));
  });

  it("skips generating (no file) variants with active job", async () => {
    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(address);
    await sm.save();

    const now = new Date().toISOString();
    await new JobManager(projectDir).putJob({
      kind: "generation",
      id: vid,
      address,
      variantId: vid,
      status: "running",
      dependsOnAssets: [],
      backendKind: "comfy",
      backendJobId: null,
      progress: null,
      error: null,
      outputFiles: [],
      metadata: {},
      provenance: { workflowHash: null, inputHash: null, resolvedDependencies: {} },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    const { stdout } = await run(["clean"], projectDir);

    expect(removedVariantIds(stdout)).toEqual([]);
    expect(stdout).toContain("is generating");
  });

  it("removes orphaned (no file, no active job) variants", async () => {
    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(address);
    await sm.save();

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(removedVariantIds(stdout)).toEqual([vid]);
  });

  it("removes failed (file=null with error metadata) variants", async () => {
    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![vid]!.metadata = {
      error: "connection refused",
    };
    await sm.save();

    await seedSettledJob(vid);

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(removedVariantIds(stdout)).toEqual([vid]);

    const sm2 = await StateManager.load(projectDir);
    const target = sm2.getAssetState(address);
    expect(target.variants![vid]!).toBeUndefined();
  });

  it("reclaims a dead stem leftover without --delete-unaccepted", async () => {
    // A stem variant that no longer matches the live definition (an old take left after a re-accept)
    // is pure garbage — reclaimed like a dead composition, even without --delete-unaccepted.
    const stemAddr = "video:shot.01#stem";
    const rel = `assets/video/shot.01#stem`;
    const sm = await StateManager.load(projectDir);
    const ghost = sm.reserveVariantId(stemAddr);
    const v = sm.getAssetState(stemAddr).variants![ghost]!;
    v.file = `${rel}/${ghost}/stem.json`;
    v.definitionHash = "stale-hash";
    v.inputFingerprints = {};
    await sm.save();
    await fs.mkdir(path.join(projectDir, `${rel}/${ghost}`), { recursive: true });
    await fs.writeFile(path.join(projectDir, `${rel}/${ghost}/stem.json`), "{}");

    const { stdout } = await run(["clean", "--yes"], projectDir);
    expect(removedVariantIds(stdout)).toContain(ghost);

    const reloaded = await StateManager.load(projectDir);
    expect(reloaded.tryGetAssetState(stemAddr)?.variants?.[ghost]).toBeUndefined();
  });

  it("removes cancelled (file=null with cancelledAt metadata) variants", async () => {
    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![vid]!.metadata = {
      cancelledAt: "2025-01-01T00:00:00Z",
    };
    await sm.save();

    await seedSettledJob(vid);

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(removedVariantIds(stdout)).toEqual([vid]);

    const sm2 = await StateManager.load(projectDir);
    const target = sm2.getAssetState(address);
    expect(target.variants![vid]!).toBeUndefined();
  });

  it("filters by target (shot scope)", async () => {
    await setupVariants();

    const sm = await StateManager.load(projectDir);
    const voiceAddr = "video:shot.01.voice";
    const voiceVid = sm.reserveVariantId(voiceAddr);
    await sm.save();

    const { stdout } = await run(["clean", "--delete-unaccepted", address, "--yes"], projectDir);

    expect(removedAddresses(stdout).every((a) => a === address)).toBe(true);

    const sm2 = await StateManager.load(projectDir);
    expect(sm2.getAssetState(voiceAddr).variants![voiceVid]!).toBeDefined();
  });

  it("filters by target (asset scope)", async () => {
    await setupVariants();

    const sm = await StateManager.load(projectDir);
    const voiceAddr = "video:shot.01.voice";
    const voiceVid = sm.reserveVariantId(voiceAddr);
    sm.getAssetState(voiceAddr).variants![voiceVid]!.file =
      `assets/video/shot.01.voice/${voiceVid}/output.mp4`;
    await sm.save();

    await fs.mkdir(path.join(projectDir, `assets/video/shot.01.voice/${voiceVid}`), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, `assets/video/shot.01.voice/${voiceVid}/output.mp4`),
      "data",
    );

    const { stdout } = await run(["clean", "--delete-unaccepted", voiceAddr, "--yes"], projectDir);

    expect(removedAddresses(stdout)).toEqual([voiceAddr]);
  });

  it("exits non-zero when no assets match target", async () => {
    await setupVariants();

    const err = (await run(["clean", "video:shot.99"], projectDir).catch((e) => e)) as {
      code: number;
      stderr: string;
    };
    expect(err.code).toBe(1);
    expect(err.stderr).toContain("video:shot.99");
  });

  it("prints nothing to clean when all variants are accepted", async () => {
    const sm = await StateManager.load(projectDir);
    const v1 = sm.reserveVariantId(address);
    sm.setAccepted(address, v1);
    await sm.save();

    const { stdout } = await run(["clean"], projectDir);
    expect(stdout).toContain("Nothing to clean");
  });

  it("deletes without prompt when --yes is passed", async () => {
    const { v1, v2, v3 } = await setupVariants();

    const { stdout } = await run(["clean", "--delete-unaccepted", "--yes"], projectDir);
    expect(stdout).toContain("Removed");

    const sm = await StateManager.load(projectDir);
    const target = sm.getAssetState(address);
    expect(target.variants![v1]!).toBeDefined();
    expect(target.variants![v2]!).toBeUndefined();
    expect(target.variants![v3]!).toBeUndefined();
  });

  it("itemizes what is deleted by class, even under --yes", async () => {
    await setupVariants();
    const sm = await StateManager.load(projectDir);
    const failed = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![failed]!.metadata = { error: "boom" };
    await sm.save();

    const { stdout } = await run(["clean", "--delete-unaccepted", "--yes"], projectDir);

    expect(stdout).toContain("will be deleted:");
    expect(stdout).toMatch(/failed\s+1/);
    expect(stdout).toMatch(/unaccepted \(has media\)\s+2/);
  });

  it("does not prompt in --dry-run mode", async () => {
    await setupVariants();

    const { stdout } = await run(["clean", "--delete-unaccepted", "--dry-run"], projectDir);
    expect(stdout).toContain("Would remove");
  });

  it("aborts without deleting when --no is passed", async () => {
    const { v1, v2, v3 } = await setupVariants();

    const { stdout } = await run(["clean", "--delete-unaccepted", "--no"], projectDir);
    expect(stdout).toContain("Aborted");

    const sm = await StateManager.load(projectDir);
    const target = sm.getAssetState(address);
    expect(target.variants![v1]!).toBeDefined();
    expect(target.variants![v2]!).toBeDefined();
    expect(target.variants![v3]!).toBeDefined();
  });

  it("errors instead of hanging when confirmation is needed non-interactively", async () => {
    const { v1, v2, v3 } = await setupVariants();

    await expect(run(["clean", "--delete-unaccepted"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });
    await expect(run(["clean", "--delete-unaccepted"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("will be deleted"),
    });

    const sm = await StateManager.load(projectDir);
    const target = sm.getAssetState(address);
    expect(target.variants![v1]!).toBeDefined();
    expect(target.variants![v2]!).toBeDefined();
    expect(target.variants![v3]!).toBeDefined();
  });
});

// Its own fixture: the test-video project has no board with a stem.
describe("clean command (the board's stem)", () => {
  it("reclaims a dead leftover of the board's stem the same way", async () => {
    const board = await initWithCrossStageStemVideo();
    const stemAddr = "animatic:shot.01#stem";
    const rel = "assets/animatic/shot.01#stem";
    const sm = await StateManager.load(board);
    const ghost = sm.reserveVariantId(stemAddr);
    const v = sm.getAssetState(stemAddr).variants![ghost]!;
    v.file = `${rel}/${ghost}/stem.wav`;
    v.definitionHash = "an earlier animatic.tsx";
    v.inputFingerprints = {};
    await sm.save();
    await fs.mkdir(path.join(board, `${rel}/${ghost}`), { recursive: true });
    await fs.writeFile(path.join(board, `${rel}/${ghost}/stem.wav`), "");

    const { stdout } = await run(["clean", "--yes"], board);
    expect(removedVariantIds(stdout)).toContain(ghost);
    expect(
      (await StateManager.load(board)).tryGetAssetState(stemAddr)?.variants?.[ghost],
    ).toBeUndefined();
    await expect(fs.access(path.join(board, `${rel}/${ghost}`))).rejects.toThrow();
  });
});
