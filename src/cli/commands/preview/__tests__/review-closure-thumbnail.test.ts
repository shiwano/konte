import { describe, expect, it, vi } from "vitest";
import { unacceptedThumbnailRefs } from "../../../../core/render-plan.js";
import { formatReviewRecord, loadAllReviewRecords } from "../../../../core/review-record.js";
import { StateManager } from "../../../../core/state/index.js";
import { loadPreviewDefinitions } from "../load-definitions.js";
import { useTempWorkspace } from "../../../__tests__/cli-fixtures.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CHAINED_THUMBNAIL_VIDEO_TSX,
  THUMBNAIL_VIDEO_TSX,
  acceptAll,
  frameThumbnailVideoTsx,
  generateAll,
  outstanding,
  project,
  seed,
  settle,
} from "./review-closure-harness.js";

vi.setConfig({ testTimeout: 60000 });

useTempWorkspace();

const FRAME = "video:thumbnail#frame";
const STILL = "video:thumbnail#still";
const COVER = "video:thumbnail.cover";
const FIT = "video:thumbnail.fit";

describe("video review closure with a thumbnail", () => {
  it("settles a video with a thumbnail, its accept signing off its still and frame", async () => {
    const videoRoot = await project(undefined, THUMBNAIL_VIDEO_TSX);
    expect(await settle(videoRoot)).toBeLessThanOrEqual(3);
    const manager = await StateManager.load(videoRoot);
    expect(manager.getAcceptedVariant(STILL)).not.toBeNull();
    expect(manager.getAcceptedVariant(FRAME)).not.toBeNull();
    expect(manager.getAcceptedVariant(COVER)).not.toBeNull();
    expect(manager.getAcceptedVariant("video:shot.01.motion")).not.toBeNull();
  });

  it("signs off a frame cut at `at`, and asks again once `at` moves", async () => {
    const videoRoot = await project(undefined, frameThumbnailVideoTsx(1));
    expect(await settle(videoRoot)).toBeLessThanOrEqual(3);
    const before = (await StateManager.load(videoRoot)).getAcceptedVariant(FRAME);
    expect(before).not.toBeNull();

    await fs.writeFile(path.join(videoRoot, "video.tsx"), frameThumbnailVideoTsx(1.5));
    const { video } = await loadPreviewDefinitions({
      videoRoot,
      mode: "video-preview",
      reload: true,
    });
    expect(unacceptedThumbnailRefs(video!, await StateManager.load(videoRoot))).toEqual([FRAME]);

    await generateAll(videoRoot);
    expect((await outstanding(videoRoot)).needsReview).toContain(FRAME);
    await acceptAll(videoRoot);
    const after = await StateManager.load(videoRoot);
    expect(after.getAcceptedVariant(FRAME)).not.toBe(before);
    expect((await outstanding(videoRoot)).needsReview).toEqual([]);
  });

  // A reroll of a thumbnail asset lands beside its accept. Picking it accepts that take alone: the
  // still on screen was made from the other, so `generate` makes it again and the next review signs
  // it off.
  it("takes a picked rival alone, and signs off the still generate makes from it", async () => {
    const videoRoot = await project(undefined, THUMBNAIL_VIDEO_TSX);
    await settle(videoRoot);
    const manager = await StateManager.load(videoRoot);
    const stillBefore = manager.getAcceptedVariant(STILL);
    const kept = manager.getAcceptedVariant(COVER)!;
    const accepted = manager.getAssetState(COVER).variants![kept]!;
    const rival = await seed(manager, COVER, "image");
    const variant = manager.getAssetState(COVER).variants![rival]!;
    variant.definitionHash = accepted.definitionHash;
    variant.inputFingerprints = accepted.inputFingerprints;
    await manager.save();

    expect((await outstanding(videoRoot)).needsReview).toContain(COVER);
    const payload = (await acceptAll(videoRoot, "video", { allowSkipped: true })) as {
      skippedDecisions?: Array<{ address: string; reason: string }>;
    };
    expect(payload.skippedDecisions).toEqual([
      { address: STILL, reason: expect.stringContaining("`konte generate video`") },
    ]);
    const picked = await StateManager.load(videoRoot);
    expect(picked.getAcceptedVariant(COVER)).toBe(rival);
    const { video } = await loadPreviewDefinitions({ videoRoot, mode: "video-preview" });
    expect(unacceptedThumbnailRefs(video!, picked)).toEqual([STILL]);

    await generateAll(videoRoot);
    await acceptAll(videoRoot);
    const after = await StateManager.load(videoRoot);
    expect(after.getAcceptedVariant(STILL)).not.toBe(stillBefore);
    expect(after.getAcceptedVariant(STILL)).not.toBeNull();
    expect((await outstanding(videoRoot)).needsReview).toEqual([]);
  });

  it("takes a rival the still reaches only through another asset alone", async () => {
    const videoRoot = await project(undefined, CHAINED_THUMBNAIL_VIDEO_TSX);
    await settle(videoRoot);
    const manager = await StateManager.load(videoRoot);
    const fitBefore = manager.getAcceptedVariant(FIT);
    const kept = manager.getAcceptedVariant(COVER)!;
    const accepted = manager.getAssetState(COVER).variants![kept]!;
    const rival = await seed(manager, COVER, "image");
    const variant = manager.getAssetState(COVER).variants![rival]!;
    variant.definitionHash = accepted.definitionHash;
    variant.inputFingerprints = accepted.inputFingerprints;
    await manager.save();

    const payload = (await acceptAll(videoRoot, "video", { allowSkipped: true })) as {
      skippedDecisions?: Array<{ address: string; reason: string }>;
    };
    expect(payload.skippedDecisions).toEqual([
      { address: STILL, reason: expect.stringContaining(`${COVER} (${rival})`) },
    ]);
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(COVER)).toBe(rival);

    await generateAll(videoRoot);
    await acceptAll(videoRoot);
    const after = await StateManager.load(videoRoot);
    expect(after.getAcceptedVariant(FIT)).not.toBe(fitBefore);
    expect((await outstanding(videoRoot)).needsReview).toEqual([]);
  });

  it("records the takes the accepted thumbnail drew, and holds an export to them", async () => {
    const videoRoot = await project(undefined, THUMBNAIL_VIDEO_TSX);
    await settle(videoRoot);
    const manager = await StateManager.load(videoRoot);
    const still = manager.getAcceptedVariant(STILL)!;
    const frame = manager.getAcceptedVariant(FRAME)!;
    const cover = manager.getAcceptedVariant(COVER)!;
    const motion = manager.getAcceptedVariant("video:shot.01.motion")!;

    const record = (await loadAllReviewRecords(videoRoot))
      .map((r) => r.record)
      .find((r) => r.thumbnailDecision === "accepted")!;
    expect(record.context.thumbnailSources).toEqual({
      [STILL]: still,
      [FRAME]: frame,
      [COVER]: cover,
    });
    expect(formatReviewRecord(record)).toContain(`${COVER} (${cover})`);

    const { video } = await loadPreviewDefinitions({ videoRoot, mode: "video-preview" });
    expect(unacceptedThumbnailRefs(video!, manager)).toEqual([]);
    manager.setUnaccepted("video:shot.01.motion", motion);
    manager.setUnaccepted(COVER, cover);
    expect(unacceptedThumbnailRefs(video!, manager)).toEqual([COVER]);
  });
});
