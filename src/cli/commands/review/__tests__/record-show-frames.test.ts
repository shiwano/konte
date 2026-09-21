import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { applyResolutionDefinitions } from "../../../../core/definition-hashes.js";
import { StateManager } from "../../../../core/state/manager.js";
import { feedbackFramePath, resolveShotFeedbackFrames } from "../../../../core/thumbnail.js";
import { loadVideoAndAnimatic } from "../../../load-definition.js";
import {
  useReviewShowProject,
  projectDir,
  dropShotTakes,
  writeFrame,
} from "./record-show-fixtures.js";

useReviewShowProject();

describe("feedbackFramePath", () => {
  async function framePath(): Promise<string | null> {
    const { video } = await loadVideoAndAnimatic(projectDir);
    const manager = await StateManager.load(projectDir);
    await applyResolutionDefinitions({ videoRoot: projectDir, state: manager.getState() });
    return feedbackFramePath({
      video,
      manager,
      videoRoot: projectDir,
      feedbackId: "fb-a",
      shotId: "01",
      localTime: 1,
    });
  }

  it("moves to another dir when an input's bytes change under the same variant", async () => {
    const before = await framePath();
    expect(before).not.toBeNull();

    // What `file-sync` does to an authored file asset: same variant, same path, new content hash.
    // The composition HTML is byte-identical across it, so only the input fingerprints separate
    // the two — without them the old frame would be served as the current one.
    const sm = await StateManager.load(projectDir);
    const variants = sm.getAssetState("video:shot.01.motion").variants!;
    Object.values(variants)[0]!.outputHash = "deadbeef";
    await sm.save();

    expect(await framePath()).not.toBe(before);
  });

  it("moves to another dir when the shot resolves a different variant", async () => {
    const before = await framePath();

    const sm = await StateManager.load(projectDir);
    const address = "video:shot.01.motion";
    const variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = path.join("assets", "motion-2.mp4");
    await fs.writeFile(path.join(projectDir, "assets", "motion-2.mp4"), "");
    sm.setAccepted(address, variantId);
    await sm.save();

    expect(await framePath()).not.toBe(before);
  });

  it("is null for a shot id that would leave the cache tree", async () => {
    const { video } = await loadVideoAndAnimatic(projectDir);
    const manager = await StateManager.load(projectDir);
    await applyResolutionDefinitions({ videoRoot: projectDir, state: manager.getState() });
    expect(
      await feedbackFramePath({
        video,
        manager,
        videoRoot: projectDir,
        feedbackId: "fb-a",
        shotId: "../../../../etc",
        localTime: 1,
      }),
    ).toBeNull();
  });

  it("is null for a pinned note whose id is not a safe path component", async () => {
    const { video } = await loadVideoAndAnimatic(projectDir);
    const manager = await StateManager.load(projectDir);
    await applyResolutionDefinitions({ videoRoot: projectDir, state: manager.getState() });
    expect(
      await feedbackFramePath({
        video,
        manager,
        videoRoot: projectDir,
        feedbackId: "../../escape",
        shotId: "01",
        localTime: 1,
        annotation: { kind: "pin", x: 0.5, y: 0.5 },
      }),
    ).toBeNull();
  });

  it("shares one frame between two notes standing at the same instant", async () => {
    const { video } = await loadVideoAndAnimatic(projectDir);
    const manager = await StateManager.load(projectDir);
    await applyResolutionDefinitions({ videoRoot: projectDir, state: manager.getState() });
    const of = (feedbackId: string) =>
      feedbackFramePath({
        video,
        manager,
        videoRoot: projectDir,
        feedbackId,
        shotId: "01",
        localTime: 1,
      });
    expect(await of("fb-a")).toBe(await of("fb-b"));
  });

  it("is null for a fallback shot, which composes nothing of its own", async () => {
    const { video } = await loadVideoAndAnimatic(projectDir);
    const manager = await StateManager.load(projectDir);
    await applyResolutionDefinitions({ videoRoot: projectDir, state: manager.getState() });
    // What an undeveloped shot looks like: it still renders (its board frame stands in), but its
    // address is not a live composition, so `prune` would read the cache as orphaned.
    const fallback = {
      ...video,
      shots: video.shots.map((sh) => (sh.id === "01" ? { ...sh, shotFn: null } : sh)),
    };
    expect(
      await feedbackFramePath({
        video: fallback as typeof video,
        manager,
        videoRoot: projectDir,
        feedbackId: "fb-a",
        shotId: "01",
        localTime: 1,
      }),
    ).toBeNull();
  });

  it("is null for a shot the definition no longer has", async () => {
    const { video } = await loadVideoAndAnimatic(projectDir);
    const manager = await StateManager.load(projectDir);
    expect(
      await feedbackFramePath({
        video,
        manager,
        videoRoot: projectDir,
        feedbackId: "fb-a",
        shotId: "99",
        localTime: 1,
      }),
    ).toBeNull();
  });
});

describe("resolveShotFeedbackFrames", () => {
  it("gives two notes at one instant the same seeded frame, in the order asked", async () => {
    await writeFrame("fb-a", 1);
    const { video } = await loadVideoAndAnimatic(projectDir);
    const manager = await StateManager.load(projectDir);
    await applyResolutionDefinitions({ videoRoot: projectDir, state: manager.getState() });

    const results = await resolveShotFeedbackFrames({
      video,
      manager,
      videoRoot: projectDir,
      shotId: "01",
      notes: [
        { feedbackId: "fb-a", localTime: 1 },
        { feedbackId: "fb-b", localTime: 1 },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.kind).toBe("frame");
  });

  // The picture is gone but the subtitle is not, so there is a frame. Only a shot that draws nothing
  // at all is unavailable (`compositionDrawsSomething`).
  it("still frames a note when the take is gone and the shot's own markup is not", async () => {
    const { video } = await loadVideoAndAnimatic(projectDir);
    await dropShotTakes("01");
    // Seeded after the drop, so the cache key is the dropped shot's — a hit, and no headless capture.
    await writeFrame("fb-a", 1);
    const dropped = await StateManager.load(projectDir);
    await applyResolutionDefinitions({ videoRoot: projectDir, state: dropped.getState() });

    const results = await resolveShotFeedbackFrames({
      video,
      manager: dropped,
      videoRoot: projectDir,
      shotId: "01",
      notes: [{ feedbackId: "fb-a", localTime: 1 }],
    });

    expect(results[0]!.kind).toBe("frame");
  });
});
