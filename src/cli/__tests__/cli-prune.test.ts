import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateFeedbackId } from "../../core/feedback/index.js";
import { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/manager.js";
import {
  useTempWorkspace,
  seedFeedback,
  readFeedback,
  initWithTestVideo,
  run,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

// "Pruned: <address> (<counts>)" and its siblings — one line per thing prune reclaimed.
const prunedLines = (stdout: string, suffix = "") => [
  ...stdout.matchAll(
    new RegExp(`^(?:Pruned|Would prune): (\\S+)(?: (\\S+))?.* \\(${suffix}`, "gm"),
  ),
];
const prunedAddresses = (stdout: string) => prunedLines(stdout).map((m) => m[1]!);

describe("prune command", () => {
  let projectDir: string;
  const validAddress = "video:shot.01.motion";
  const orphanAddress = "video:shot.99.old";
  const orphanBare = "shot.99.old";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  async function setupOrphan(): Promise<{ orphanVid: string; validVid: string }> {
    const sm = await StateManager.load(projectDir);

    // valid (in-definition) accepted target — must survive prune
    const validVid = sm.reserveVariantId(validAddress);
    sm.getAssetState(validAddress).variants![validVid]!.file =
      `assets/video/shot.01.motion/${validVid}/output.mp4`;
    sm.setAccepted(validAddress, validVid);

    // orphan accepted target with feedback — should be pruned despite accepted
    const orphanVid = sm.reserveVariantId(orphanAddress);
    sm.getAssetState(orphanAddress).variants![orphanVid]!.file =
      `assets/video/${orphanBare}/${orphanVid}/output.mp4`;
    sm.setAccepted(orphanAddress, orphanVid);

    await sm.save();
    await seedFeedback(projectDir, orphanAddress, {
      id: generateFeedbackId(),
      displayedVariants: { [orphanAddress]: orphanVid },
      annotation: null,
      text: "looks off",
      createdAt: new Date().toISOString(),
      createdBy: "local",
    });

    await fs.mkdir(path.join(projectDir, `assets/video/${orphanBare}/${orphanVid}`), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, `assets/video/${orphanBare}/${orphanVid}/output.mp4`),
      "data",
    );

    return { orphanVid, validVid };
  }

  it("prunes an orphaned accepted target (state key + files + feedback)", async () => {
    const { validVid } = await setupOrphan();

    const { stdout } = await run(["prune", "--yes"], projectDir);

    expect(prunedAddresses(stdout)).toEqual([orphanAddress]);

    const sm = await StateManager.load(projectDir);
    expect(sm.tryGetAssetState(orphanAddress)).toBeUndefined();
    expect(sm.getAssetState(validAddress).variants![validVid]!).toBeDefined();

    await expect(fs.access(path.join(projectDir, `assets/video/${orphanBare}`))).rejects.toThrow();
  });

  it("prunes an orphaned job whose variant is gone from state", async () => {
    const jm = new JobManager(projectDir);
    const orphanJobVid = "v-orphanedjob01";
    await jm.createJob({
      address: validAddress,
      variantId: orphanJobVid,
      resolvedDeps: {},
      backendKind: "fal",
    });
    // A fresh no-deps job is "queued" (active) — move it terminal so prune may reclaim it.
    await jm.updateJob(orphanJobVid, {
      status: "failed",
      completedAt: new Date().toISOString(),
    });
    const logFile = path.join(projectDir, ".konte/logs", `${orphanJobVid}.log`);
    await fs.writeFile(logFile, "log");

    const { stdout } = await run(["prune", "--yes"], projectDir);

    expect(prunedLines(stdout, "orphaned job").map((m) => m[2])).toContain(orphanJobVid);
    await expect(jm.getJob(orphanJobVid)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(fs.access(logFile)).rejects.toThrow();
  });

  it("does not prune an orphaned target while a job for its variant is active", async () => {
    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(orphanAddress);
    await sm.save();
    const jm = new JobManager(projectDir);
    // A fresh no-deps job is "queued" (active): deleting the target would strand it.
    await jm.createJob({
      address: orphanAddress,
      variantId: vid,
      resolvedDeps: {},
      backendKind: "fal",
    });

    const { stdout } = await run(["prune", "--yes"], projectDir);

    expect(prunedAddresses(stdout)).toEqual([]);
    expect(stdout).toContain(`with an active job: ${orphanAddress}`);

    const sm2 = await StateManager.load(projectDir);
    expect(sm2.tryGetAssetState(orphanAddress)).toBeDefined();
    await jm.getJob(vid);
  });

  it("filters orphaned jobs by address-scope", async () => {
    const jm = new JobManager(projectDir);
    for (const [addr, vid] of [
      ["video:shot.98.gone", "v-scopejob98"],
      ["video:shot.97.gone", "v-scopejob97"],
    ] as const) {
      await jm.createJob({ address: addr, variantId: vid, resolvedDeps: {}, backendKind: "fal" });
      await jm.updateJob(vid, { status: "failed", completedAt: new Date().toISOString() });
    }

    const { stdout } = await run(["prune", "video:shot.98", "--yes"], projectDir);

    expect(prunedLines(stdout, "orphaned job").map((m) => m[2])).toEqual(["v-scopejob98"]);
    await jm.getJob("v-scopejob97");
  });

  it("does not prune an active (queued) orphaned job", async () => {
    const jm = new JobManager(projectDir);
    const activeJobVid = "v-activejob01";
    await jm.createJob({
      address: validAddress,
      variantId: activeJobVid,
      resolvedDeps: {},
      backendKind: "fal",
    });

    const { stdout } = await run(["prune", "--yes"], projectDir);

    expect(prunedLines(stdout, "orphaned job")).toEqual([]);
    await jm.getJob(activeJobVid);
  });

  it("does not prune in-definition addresses", async () => {
    const sm = await StateManager.load(projectDir);
    const v = sm.reserveVariantId(validAddress);
    sm.setAccepted(validAddress, v);
    await sm.save();

    const { stdout } = await run(["prune"], projectDir);
    expect(stdout).toContain("Nothing to prune.");
  });

  it("prunes feedback on an orphaned bare-shot target with no state asset", async () => {
    // Whole-shot feedback on shot.99, which is not in the definition → orphaned. It has no
    // variants, so it never enters the state-orphan pass; prune must still shed its feedback.
    const bareShot = "video:shot.99";
    await seedFeedback(projectDir, bareShot, {
      id: generateFeedbackId(),
      displayedVariants: {},
      annotation: null,
      text: "whole shot note",
      createdAt: new Date().toISOString(),
      createdBy: "local",
    });

    const { stdout } = await run(["prune", "--yes"], projectDir);
    expect(prunedLines(stdout, "\\d+ feedback\\)").map((m) => m[1])).toContain(bareShot);
    expect(await readFeedback(projectDir, bareShot)).toHaveLength(0);
  });

  it("keeps feedback on an in-definition bare-shot target", async () => {
    // shot.01 IS in the definition, so its whole-shot feedback is not an orphan.
    const bareShot = "video:shot.01";
    await seedFeedback(projectDir, bareShot, {
      id: generateFeedbackId(),
      displayedVariants: {},
      annotation: null,
      text: "keep me",
      createdAt: new Date().toISOString(),
      createdBy: "local",
    });

    await run(["prune", "--yes"], projectDir);
    expect(await readFeedback(projectDir, bareShot)).toHaveLength(1);
  });

  it("prunes orphaned composition caches but keeps live ones", async () => {
    // shot.01 has a shotFn in the test definition → live composition cache (keep).
    const liveCache = path.join(projectDir, ".konte/cache/thumbnails/video/shot.01#composition/h1");
    // shot.99 is not in the definition → orphaned composition cache (prune).
    const orphanCache = path.join(
      projectDir,
      ".konte/cache/thumbnails/video/shot.99#composition/h2",
    );
    await fs.mkdir(liveCache, { recursive: true });
    await fs.mkdir(orphanCache, { recursive: true });
    await fs.writeFile(path.join(liveCache, "keyframe-001.jpeg"), "img");
    await fs.writeFile(path.join(orphanCache, "keyframe-001.jpeg"), "img");

    const { stdout } = await run(["prune", "--yes"], projectDir);

    expect(stdout.match(/\(composition cache\)/g)).toHaveLength(1);
    await expect(
      fs.access(path.join(projectDir, ".konte/cache/thumbnails/video/shot.99#composition")),
    ).rejects.toThrow();
    await fs.access(path.join(projectDir, ".konte/cache/thumbnails/video/shot.01#composition"));
  });

  it("keeps a live accepted composition stored in state", async () => {
    // shot.01 has a shotFn in the test definition → its composition is a live target.
    // Preview submit / `konte accept` accept it into state as the re-review baseline;
    // listAddresses does not enumerate composition addresses, so prune must not treat it
    // as an orphan and silently delete the baseline.
    const compAddress = "video:shot.01#composition";
    const sm = await StateManager.load(projectDir);
    const compVid = sm.reserveVariantId(compAddress);
    sm.getAssetState(compAddress).variants![compVid]!.file =
      `assets/video/shot.01#composition/${compVid}/output.mp4`;
    sm.setAccepted(compAddress, compVid);
    await sm.save();

    const { stdout } = await run(["prune"], projectDir);
    expect(prunedAddresses(stdout)).not.toContain(compAddress);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(compAddress)).toBe(compVid);
  });

  it("does not delete in dry-run mode", async () => {
    await setupOrphan();

    const { stdout } = await run(["prune", "--dry-run"], projectDir);
    expect(prunedAddresses(stdout)).toEqual([orphanAddress]);

    const sm = await StateManager.load(projectDir);
    expect(sm.tryGetAssetState(orphanAddress)).toBeDefined();
    await fs.access(path.join(projectDir, `assets/video/${orphanBare}`));
  });

  it("aborts without deleting when --no is passed", async () => {
    await setupOrphan();

    const { stdout } = await run(["prune", "--no"], projectDir);
    expect(stdout).toContain("Aborted");

    const sm = await StateManager.load(projectDir);
    expect(sm.tryGetAssetState(orphanAddress)).toBeDefined();
  });

  it("errors instead of hanging when confirmation is needed non-interactively", async () => {
    await setupOrphan();

    await expect(run(["prune"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });

    const sm = await StateManager.load(projectDir);
    expect(sm.tryGetAssetState(orphanAddress)).toBeDefined();
  });

  it("filters orphans by address-scope", async () => {
    await setupOrphan();
    const sm = await StateManager.load(projectDir);
    const otherOrphan = "video:shot.88.gone";
    const ov = sm.reserveVariantId(otherOrphan);
    sm.setAccepted(otherOrphan, ov);
    await sm.save();

    const { stdout } = await run(["prune", orphanAddress, "--yes"], projectDir);
    expect(prunedAddresses(stdout)).toEqual([orphanAddress]);

    const sm2 = await StateManager.load(projectDir);
    expect(sm2.tryGetAssetState(otherOrphan)).toBeDefined();
  });

  it("aborts (no deletion) when video.tsx cannot be loaded", async () => {
    await setupOrphan();
    await fs.writeFile(path.join(projectDir, "video.tsx"), "this is not valid typescript {{{");

    await expect(run(["prune"], projectDir)).rejects.toBeDefined();

    const sm = await StateManager.load(projectDir);
    expect(sm.tryGetAssetState(orphanAddress)).toBeDefined();
  });

  describe("spent provisioning jobs", () => {
    const NODE = { id: "comfyui-kjnodes" };

    it("prunes a settled node-install job and its log", async () => {
      const jm = new JobManager(projectDir);
      const { id } = await jm.ensureComfyNodeInstallJob(NODE);
      await jm.updateJob(id, { status: "completed", completedAt: new Date().toISOString() });
      const logFile = path.join(projectDir, ".konte/logs", `${id}.log`);
      await fs.writeFile(logFile, "log");

      const { stdout } = await run(["prune", "--yes"], projectDir);

      expect(prunedLines(stdout, "spent provisioning job").map((m) => m[1])).toContain(id);
      await expect(jm.getJob(id)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
      await expect(fs.access(logFile)).rejects.toThrow();
    });

    it("leaves one a pending job still depends on", async () => {
      const jm = new JobManager(projectDir);
      const install = await jm.ensureComfyNodeInstallJob(NODE);
      await jm.updateJob(install.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      // The activation reads its dependency back to decide whether it may run; deleting a
      // settled dependency out from under it fails it outright.
      await jm.ensureComfyNodeActivateJob({ dependsOnJobs: [install.id], cnrIds: [NODE.id] });

      const { stdout } = await run(["prune", "--yes"], projectDir);

      expect(prunedLines(stdout, "spent provisioning job")).toEqual([]);
      await jm.getJob(install.id);
    });

    it("leaves an in-flight one alone", async () => {
      const jm = new JobManager(projectDir);
      const { id } = await jm.ensureComfyNodeInstallJob(NODE);
      await jm.updateJob(id, { status: "running" });

      const { stdout } = await run(["prune", "--yes"], projectDir);

      expect(prunedLines(stdout, "spent provisioning job")).toEqual([]);
    });

    // A provisioning job has no address, so no scope can be said to match it — a scoped run must
    // not sweep it up as a side effect of pruning something else.
    it("is left out of a scoped run", async () => {
      const sm = await StateManager.load(projectDir);
      sm.reserveVariantId(orphanAddress);
      await sm.save();
      const jm = new JobManager(projectDir);
      const { id } = await jm.ensureComfyNodeInstallJob(NODE);
      await jm.updateJob(id, { status: "completed", completedAt: new Date().toISOString() });

      // A scope that does prune something, so the run succeeds and its silence about the
      // provisioning job is the assertion rather than an early "nothing matched" exit.
      const { stdout } = await run(["prune", "video", "--yes"], projectDir);

      expect(prunedLines(stdout, "spent provisioning job")).toEqual([]);
      await jm.getJob(id);
    });
  });

  describe("stray variant directories", () => {
    const stray = "assets/video/shot.01.motion/v-stray001";
    const strayStep = "assets/reference/patch/v-src0001/fix/v-stray002";

    async function seedDirs(): Promise<{ absentVid: string }> {
      const sm = await StateManager.load(projectDir);
      // Recorded, its media absent, its directory holding only a sidecar: not stray.
      const absentVid = sm.reserveVariantId(validAddress);
      sm.getAssetState(validAddress).variants![absentVid]!.file =
        `assets/video/shot.01.motion/${absentVid}/output.mp4`;
      await sm.save();
      await fs.mkdir(path.join(projectDir, `assets/video/shot.01.motion/${absentVid}`), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectDir, `assets/video/shot.01.motion/${absentVid}/definition.json`),
        "{}",
      );
      for (const dir of [stray, strayStep, "assets/files/voices/v-authored"]) {
        await fs.mkdir(path.join(projectDir, dir), { recursive: true });
        await fs.writeFile(path.join(projectDir, dir, "output.png"), "data");
      }
      return { absentVid };
    }

    it("prunes a variant directory no state row records, and nothing else", async () => {
      const { absentVid } = await seedDirs();

      const { stdout } = await run(["prune", "--yes"], projectDir);

      expect(prunedLines(stdout, "stray variant directory").map((m) => m[1])).toEqual([
        strayStep,
        stray,
      ]);
      await expect(fs.access(path.join(projectDir, stray))).rejects.toThrow();
      await expect(fs.access(path.join(projectDir, "assets/reference/patch"))).rejects.toThrow();
      await fs.access(path.join(projectDir, `assets/video/shot.01.motion/${absentVid}`));
      await fs.access(path.join(projectDir, "assets/files/voices/v-authored"));
    });

    it("is left out of a scoped run", async () => {
      await seedDirs();
      await setupOrphan();

      const { stdout } = await run(["prune", "video", "--yes"], projectDir);

      expect(prunedLines(stdout, "stray variant directory")).toEqual([]);
      await fs.access(path.join(projectDir, stray));
    });
  });

  it("prints nothing to prune when there are no orphans", async () => {
    const { stdout } = await run(["prune"], projectDir);
    expect(stdout).toContain("Nothing to prune");
  });
});
