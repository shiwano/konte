import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateFeedbackId } from "../../core/feedback/index.js";
import { formatTimestamp } from "../../core/format-timestamp.js";
import { StateManager } from "../../core/state/manager.js";
import type { FeedbackEntry } from "../../core/types/index.js";
import {
  useTempWorkspace,
  seedFeedback,
  readFeedback,
  initWithTestVideo,
  run,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("feedback commands", () => {
  let projectDir: string;
  let feedbackId: string;
  const address = "video:shot.01.motion";

  async function setupFeedback(): Promise<{
    variantId: string;
    feedbackId: string;
  }> {
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = "/tmp/motion.mp4";
    sm.setAccepted(address, variantId);
    const acceptedAt = sm.getAssetState(address).variants![variantId]!.decidedAt!;

    feedbackId = generateFeedbackId();
    const entry: FeedbackEntry = {
      id: feedbackId,
      displayedVariants: { [address]: variantId },
      annotation: null,
      text: "Fix the color grading",
      // After the accept above: a comment written before one is stale, signed off as it stands.
      // Offset from the recorded stamp, not the clock, which can step backwards mid-test.
      createdAt: new Date(Date.parse(acceptedAt) + 1_000).toISOString(),
      createdBy: "local",
    };
    await sm.save();
    await seedFeedback(projectDir, address, entry);

    return { variantId, feedbackId };
  }

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  describe("list", () => {
    it("lists feedback entries", async () => {
      await setupFeedback();
      const { stdout } = await run(["review", "feedback", "list"], projectDir);
      expect(stdout).toContain(feedbackId);
      expect(stdout).toContain(address);
    });

    it("filters by address-scope", async () => {
      await setupFeedback();

      const sm = await StateManager.load(projectDir);
      const voiceAddr = "video:shot.01.voice";
      const voiceVid = sm.reserveVariantId(voiceAddr);
      sm.getAssetState(voiceAddr).variants![voiceVid]!.file = "/tmp/voice.mp3";
      const voiceFbId = generateFeedbackId();
      await sm.save();
      await seedFeedback(projectDir, voiceAddr, {
        id: voiceFbId,
        displayedVariants: { [voiceAddr]: voiceVid },
        annotation: null,
        text: "Voice too quiet",
        createdAt: "2025-01-01T00:00:00Z",
        createdBy: "local",
      });

      const { stdout } = await run(["review", "feedback", "list", address], projectDir);
      expect(stdout).toContain(feedbackId);
      expect(stdout).not.toContain(voiceAddr);
    });

    it("keeps the stale ones out of the listing until --verbose asks for them", async () => {
      const sm = await StateManager.load(projectDir);
      const v1 = sm.reserveVariantId(address);
      sm.getAssetState(address).variants![v1]!.file = "/tmp/motion.mp4";
      sm.setAccepted(address, v1);

      const staleFbId = generateFeedbackId();
      await sm.save();
      await seedFeedback(projectDir, address, {
        id: staleFbId,
        displayedVariants: { [address]: "v-old00001" },
        annotation: null,
        text: "Stale feedback",
        createdAt: "2025-01-01T00:00:00Z",
        createdBy: "local",
      });

      const { stdout: standing } = await run(["review", "feedback", "list"], projectDir);
      expect(standing).not.toContain(staleFbId);
      expect(standing).toContain("--verbose");

      const { stdout } = await run(["review", "feedback", "list", "--verbose"], projectDir);
      expect(stdout).toMatch(new RegExp(`\\[${staleFbId}\\] .* {2}\\[stale\\]`));
    });

    it("prints each comment whole with --verbose, pin and time included", async () => {
      const sm = await StateManager.load(projectDir);
      const variantId = sm.reserveVariantId(address);
      sm.getAssetState(address).variants![variantId]!.file = "/tmp/motion.mp4";
      sm.setAccepted(address, variantId);
      const acceptedAt = sm.getAssetState(address).variants![variantId]!.decidedAt!;

      const id = generateFeedbackId();
      const text =
        "船がぐるぐるまわるんじゃなくて、ゆっくり流れる感じにしてほしいです。あと空の色をもう少し暖かくしてください";
      await sm.save();
      await seedFeedback(projectDir, address, {
        id,
        displayedVariants: { [address]: variantId },
        annotation: { kind: "pin", x: 0.42, y: 0.61 },
        time: 3.2,
        shotTime: 1.2,
        text,
        createdAt: new Date(Date.parse(acceptedAt) + 1_000).toISOString(),
        createdBy: "local",
      });

      const { stdout: table } = await run(["review", "feedback", "list"], projectDir);
      expect(table).not.toContain(text);

      const { stdout } = await run(["review", "feedback", "list", "--verbose"], projectDir);
      expect(stdout).toContain(text);
      expect(stdout).toContain("pin: 0.42, 0.61");
      expect(stdout).toContain("time: 3.2s (shot-local: 1.2s)");
    });

    it("shows empty message when no feedback", async () => {
      const { stdout } = await run(["review", "feedback", "list"], projectDir);
      expect(stdout).toContain("No feedback found.");
    });

    it("fails loudly on a non-numeric --limit instead of falling back to the default", async () => {
      await setupFeedback();
      await expect(
        run(["review", "feedback", "list", "--limit", "abc"], projectDir),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("INVALID_OPTION"),
      });
    });
  });

  describe("show", () => {
    it("shows feedback details", async () => {
      await setupFeedback();
      const { stdout } = await run(["review", "feedback", "show", feedbackId], projectDir);
      expect(stdout).toContain(address);
      expect(stdout).toContain(feedbackId);
      expect(stdout).toContain("Fix the color grading");
    });

    it("fails for non-existent ID", async () => {
      await expect(
        run(["review", "feedback", "show", "fb-nonexist"], projectDir),
      ).rejects.toThrow();
    });

    it("renders the created time with the shared compact formatter, not toLocaleString", async () => {
      const id = generateFeedbackId();
      await seedFeedback(projectDir, address, {
        id,
        displayedVariants: {},
        annotation: null,
        text: "note",
        createdAt: "2025-01-01T00:00:00Z",
        createdBy: "local",
      });
      const { stdout } = await run(["review", "feedback", "show", id], projectDir);
      expect(stdout).toContain(`Created:     ${formatTimestamp("2025-01-01T00:00:00Z")}`);
    });
  });

  describe("edit", () => {
    it("updates feedback text", async () => {
      await setupFeedback();
      const { stdout } = await run(
        ["review", "feedback", "edit", feedbackId, "--text", "Updated text"],
        projectDir,
      );
      expect(stdout).toContain("Updated");
      expect(stdout).toContain(feedbackId);

      const feedback = await readFeedback(projectDir, address);
      expect(feedback[0]!.text).toBe("Updated text");
    });

    it("fails for non-existent ID", async () => {
      await expect(
        run(["review", "feedback", "edit", "fb-nonexist", "--text", "test"], projectDir),
      ).rejects.toThrow();
    });
  });

  describe("delete", () => {
    it("deletes feedback", async () => {
      await setupFeedback();
      const { stdout } = await run(
        ["review", "feedback", "delete", feedbackId, "--yes"],
        projectDir,
      );
      expect(stdout).toContain("Deleted");
      expect(stdout).toContain(feedbackId);

      const feedback = await readFeedback(projectDir, address);
      expect(feedback).toHaveLength(0);
    });

    it("aborts without --yes on a non-TTY and leaves the feedback intact", async () => {
      await setupFeedback();
      await expect(
        run(["review", "feedback", "delete", feedbackId], projectDir),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
      });

      expect(await readFeedback(projectDir, address)).toHaveLength(1);
    });

    it("fails for non-existent ID", async () => {
      await expect(
        run(["review", "feedback", "delete", "fb-nonexist", "--yes"], projectDir),
      ).rejects.toThrow();
    });
  });
});
