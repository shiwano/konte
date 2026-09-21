import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  acceptDirection,
  acceptFileAssets,
  initWithCrossStageVideo,
  run,
  TEST_CROSS_STAGE_ANIMATIC_TS,
  useTempWorkspace,
  writeWorkspaceConfig,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 20000 });

useTempWorkspace();

const ADDRESS = "animatic:shot.01.keyframe";
const BOUND = `<Panel src={kf} blocking="the cat rises to sit" camera="fixed" />`;

// The fixture board is bound; strip the movement to get the state a fresh take lands in.
async function unbind(projectDir: string): Promise<void> {
  await fs.writeFile(
    path.join(projectDir, "animatic.tsx"),
    TEST_CROSS_STAGE_ANIMATIC_TS.replace(BOUND, "<Panel src={kf} />"),
  );
}

// The take the movement is written from — a ready variant with a file.
async function seedTake(projectDir: string): Promise<string> {
  const sm = await StateManager.load(projectDir);
  const variantId = sm.reserveVariantId(ADDRESS);
  sm.getAssetState(ADDRESS).variants![variantId]!.file = "/tmp/keyframe.png";
  await sm.save();
  return variantId;
}

describe("review prerequisite gates", () => {
  describe("accept", () => {
    it("refuses a take whose movement is not written yet", async () => {
      const projectDir = await initWithCrossStageVideo();
      const variantId = await seedTake(projectDir);
      await unbind(projectDir);

      await expect(run(["accept", variantId], projectDir)).rejects.toMatchObject({
        stderr: expect.stringContaining("REVIEW_PREREQUISITE_MISSING"),
      });
    });

    it("names the halves that are missing", async () => {
      const projectDir = await initWithCrossStageVideo();
      const variantId = await seedTake(projectDir);
      await fs.writeFile(
        path.join(projectDir, "animatic.tsx"),
        TEST_CROSS_STAGE_ANIMATIC_TS.replace(
          BOUND,
          `<Panel src={kf} blocking="the cat rises to sit" />`,
        ),
      );

      await expect(run(["accept", variantId], projectDir)).rejects.toMatchObject({
        stderr: expect.stringContaining("no camera"),
      });
    });

    it("accepts once the movement is written", async () => {
      const projectDir = await initWithCrossStageVideo();
      const variantId = await seedTake(projectDir);

      const { stdout } = await run(["accept", variantId], projectDir);
      expect(stdout).toContain(`Accepted: ${ADDRESS} → ${variantId}`);
    });
  });

  describe("preview", () => {
    it("refuses to open the animatic review while a take is unbound", async () => {
      const projectDir = await initWithCrossStageVideo();
      await seedTake(projectDir);
      await unbind(projectDir);

      await expect(run(["preview", "animatic"], projectDir)).rejects.toMatchObject({
        stderr: expect.stringContaining("REVIEW_PREREQUISITE_MISSING"),
      });
    });
  });

  describe("status", () => {
    it("lists the unbound panel and points Next steps at writing it, not at the review", async () => {
      const projectDir = await initWithCrossStageVideo();
      await seedTake(projectDir);
      await unbind(projectDir);
      await acceptDirection(projectDir);

      const { stdout } = await run(["status"], projectDir);
      expect(stdout).toContain("edit animatic.tsx");
      expect(stdout).not.toContain("konte preview animatic");

      // The section itself is behind `-v`: the default drops what Next steps already names.
      const { stdout: verbose } = await run(["status", "-v"], projectDir);
      expect(verbose).toContain("Needs authoring");
      expect(verbose).toContain(ADDRESS);
    });

    // The control for the assertion above: with the movement written, the same take does reach the
    // review suggestion — so its absence there is the binding note displacing it, not a no-op.
    it("suggests the review once the movement is written", async () => {
      const projectDir = await initWithCrossStageVideo();
      await seedTake(projectDir);
      await acceptDirection(projectDir);

      const { stdout } = await run(["status", "-v"], projectDir);
      expect(stdout).not.toContain("Needs authoring");
      expect(stdout).toContain("konte preview animatic");
    });

    it("says nothing while the panel has no take to write from", async () => {
      const projectDir = await initWithCrossStageVideo();
      await unbind(projectDir);
      await acceptDirection(projectDir);

      const { stdout } = await run(["status", "-v"], projectDir);
      expect(stdout).not.toContain("Needs authoring");
    });
  });

  describe("video spend", () => {
    it("refuses while the board it builds on has an unwritten panel", async () => {
      const projectDir = await initWithCrossStageVideo();
      await writeWorkspaceConfig(projectDir, { comfyui: { url: "http://127.0.0.1:8188" } });
      const variantId = await seedTake(projectDir);
      const sm = await StateManager.load(projectDir);
      sm.setAccepted(ADDRESS, variantId);
      await sm.save();
      await unbind(projectDir);
      await acceptDirection(projectDir);
      await acceptFileAssets(projectDir);

      await expect(run(["generate", "video"], projectDir)).rejects.toMatchObject({
        stderr: expect.stringContaining("REVIEW_PREREQUISITE_MISSING"),
      });
    });
  });
});
