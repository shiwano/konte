import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressToCacheSegments, addressToUrlPath } from "../../../../core/address.js";
import { FeedbackManager } from "../../../../core/feedback/index.js";
import { StateManager } from "../../../../core/state/manager.js";
import type { Direction } from "../../../../core/dsl/direction.js";
import type { VideoDefinition } from "../../../../core/types/index.js";
import {
  applyFeedbackMutations,
  shotFactsIndex,
  buildAddressFeedback,
  buildVariantCandidates,
  consumedTakePreviewUrl,
  displayedVariantStatus,
  hasNewerReadyVariant,
  isValidSubmitPayload,
  recordFeedbackFor,
  takeDefinitionSnapshot,
  variantPreviewUrl,
  videoVariantThumbUrl,
  withShotLocalTime,
} from "../review-shared.js";
import { unacceptReelShots } from "../reel-review.js";
import { writeDefinitionSnapshot } from "../../../../core/definition-snapshot.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-preview-helpers-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-06-02T00:00:00.000Z";

function setFile(mgr: StateManager, addr: string, variantId: string, file: string): void {
  const variant = mgr.ensureAssetState(addr).variants?.[variantId];
  if (variant) variant.file = file;
}

function setReady(
  mgr: StateManager,
  addr: string,
  variantId: string,
  file: string,
  readyAt: string,
): void {
  const variant = mgr.ensureAssetState(addr).variants?.[variantId];
  if (variant) {
    variant.file = file;
    variant.readyAt = readyAt;
  }
}

async function setThumbnail(
  mgr: StateManager,
  addr: string,
  variantId: string,
  file: string,
): Promise<void> {
  const variant = mgr.ensureAssetState(addr).variants?.[variantId];
  const outputHash = `hash-${variantId}`;
  if (variant) variant.outputHash = outputHash;
  const dir = path.join(
    tmpDir,
    ".konte",
    "cache",
    "thumbnails",
    ...addressToCacheSegments(addr),
    variantId,
    outputHash,
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(tmpDir, path.dirname(file)), { recursive: true });
  await fs.writeFile(path.join(tmpDir, file), "x");
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify([{ file, timestamp: 0 }]));
}

describe("displayedVariantStatus", () => {
  const ADDR = "reference:bgm";
  const UPSTREAM = "reference:stemSource";

  // One accepted take whose recorded input no longer matches what the upstream resolves to now.
  async function withStaleAccept(deterministic: boolean): Promise<{
    mgr: StateManager;
    variantId: string;
  }> {
    const mgr = await StateManager.init(tmpDir);
    const up = mgr.reserveVariantId(UPSTREAM);
    setFile(mgr, UPSTREAM, up, "/tmp/source.wav");
    mgr.getAssetState(UPSTREAM).variants![up]!.outputHash = "up-current";
    mgr.setAccepted(UPSTREAM, up);

    const vid = mgr.reserveVariantId(ADDR);
    setFile(mgr, ADDR, vid, "/tmp/bgm.wav");
    mgr.getAssetState(ADDR).variants![vid]!.inputFingerprints = { [UPSTREAM]: "up-old" };
    mgr.setAccepted(ADDR, vid);
    mgr.useResolutionDefinitions({
      definitionHash: () => null,
      isDeterministic: (address) => deterministic && address === ADDR,
    });
    return { mgr, variantId: vid };
  }

  it("reports a human accept as accepted even once it goes stale", async () => {
    const { mgr, variantId } = await withStaleAccept(false);
    expect(displayedVariantStatus(mgr, ADDR, variantId)).toBe("accepted");
  });

  // A deterministic accept stops resolving the moment its inputs move, so the card stops calling it
  // signed off.
  it("drops a deterministic accept once it goes stale", async () => {
    const { mgr, variantId } = await withStaleAccept(true);
    expect(displayedVariantStatus(mgr, ADDR, variantId)).toBe("none");
  });

  it("reports an unaccepted take as none", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vid = mgr.reserveVariantId(ADDR);
    setFile(mgr, ADDR, vid, "/tmp/bgm.wav");
    expect(displayedVariantStatus(mgr, ADDR, vid)).toBe("none");
  });

  it("reports nothing shown as none", async () => {
    const mgr = await StateManager.init(tmpDir);
    expect(displayedVariantStatus(mgr, ADDR, null)).toBe("none");
  });
});

describe("variantPreviewUrl", () => {
  const BASE = "http://127.0.0.1:1234/api/assets";

  // An image variant's own file is the still, and it lives under assets/ — the thumbnail endpoint
  // is confined to the thumbnail cache and would refuse it.
  it("serves an image take's own file through /api/assets", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "animatic:shot.01.first";
    const vid = mgr.reserveVariantId(addr);
    const file = `assets/animatic/shot.01/first/${vid}/ComfyUI_00001_.png`;
    setFile(mgr, addr, vid, file);

    const variant = mgr.getAssetState(addr).variants![vid]!;
    expect(variantPreviewUrl(tmpDir, addr, vid, variant, BASE)).toBe(
      `${BASE}/${addressToUrlPath(addr)}/${vid}/ComfyUI_00001_.png`,
    );
  });

  it("serves a video take's first cached thumbnail", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const vid = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vid, `assets/video/shot.01/motion/${vid}/out.mp4`);
    await setThumbnail(mgr, addr, vid, ".konte/cache/thumbnails/t0.jpg");

    const variant = mgr.getAssetState(addr).variants![vid]!;
    expect(variantPreviewUrl(tmpDir, addr, vid, variant, BASE)).toBe(
      `/api/thumbnail-assets/${encodeURIComponent(".konte/cache/thumbnails/t0.jpg")}`,
    );
  });

  it("has no still for an audio take", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "animatic:shot.01.line1";
    const vid = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vid, `assets/animatic/shot.01/line1/${vid}/voice.wav`);

    const variant = mgr.getAssetState(addr).variants![vid]!;
    expect(variantPreviewUrl(tmpDir, addr, vid, variant, BASE)).toBeNull();
  });
});

describe("consumedTakePreviewUrl", () => {
  const BASE = "/api/assets";
  const UP = "animatic:shot.01.first";
  const DOWN = "video:shot.01.motion";

  async function twoUpstreamTakes() {
    const mgr = await StateManager.init(tmpDir);
    const used = mgr.reserveVariantId(UP);
    const newer = mgr.reserveVariantId(UP);
    for (const [vid, hash] of [
      [used, "h-used"],
      [newer, "h-newer"],
    ] as const) {
      setFile(mgr, UP, vid, `assets/animatic/shot.01/first/${vid}/a.png`);
      mgr.getAssetState(UP).variants![vid]!.outputHash = hash;
    }
    const down = mgr.reserveVariantId(DOWN);
    return { mgr, used, newer, down };
  }

  it("draws the upstream take whose bytes the take consumed, not the one resolving now", async () => {
    const { mgr, used, newer, down } = await twoUpstreamTakes();
    mgr.getAssetState(DOWN).variants![down]!.inputFingerprints = { [UP]: "h-used" };
    mgr.getAssetState(UP).variants![newer]!.status = "accepted";

    expect(consumedTakePreviewUrl(mgr, tmpDir, DOWN, down, UP, BASE)).toBe(
      `${BASE}/${addressToUrlPath(UP)}/${used}/a.png`,
    );
  });

  it("reads a patched take's consumed input off the take its lineage was generated from", async () => {
    const { mgr, used, newer, down } = await twoUpstreamTakes();
    mgr.getAssetState(DOWN).variants![down]!.inputFingerprints = { [UP]: "h-used" };
    const patched = mgr.reserveVariantId(DOWN);
    const variant = mgr.getAssetState(DOWN).variants![patched]!;
    variant.derivedFrom = down;
    variant.inputFingerprints = { [UP]: "h-newer" };

    expect(newer).not.toBe(used);
    expect(consumedTakePreviewUrl(mgr, tmpDir, DOWN, patched, UP, BASE)).toBe(
      `${BASE}/${addressToUrlPath(UP)}/${used}/a.png`,
    );
  });

  it("draws nothing once the consumed take is gone", async () => {
    const { mgr, down } = await twoUpstreamTakes();
    mgr.getAssetState(DOWN).variants![down]!.inputFingerprints = { [UP]: "h-cleaned" };

    expect(consumedTakePreviewUrl(mgr, tmpDir, DOWN, down, UP, BASE)).toBeNull();
  });
});

describe("takeDefinitionSnapshot", () => {
  const ADDR = "video:shot.01.motion";
  const DEF = { kind: "fal", endpointId: "fal-ai/x", mediaType: "video", inputs: {} } as const;

  it("reads the snapshot a patched take's origin was generated from", async () => {
    const mgr = await StateManager.init(tmpDir);
    const origin = mgr.reserveVariantId(ADDR);
    writeDefinitionSnapshot(tmpDir, ADDR, origin, DEF);
    const patched = mgr.reserveVariantId(ADDR);
    mgr.getAssetState(ADDR).variants![patched]!.derivedFrom = origin;

    expect(takeDefinitionSnapshot(mgr, tmpDir, ADDR, patched)).toEqual(DEF);
  });

  it("reads nothing for a take whose snapshot is gone", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vid = mgr.reserveVariantId(ADDR);

    expect(takeDefinitionSnapshot(mgr, tmpDir, ADDR, vid)).toBeNull();
  });
});

describe("buildVariantCandidates", () => {
  it("orders variants newest-first", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const v1 = mgr.reserveVariantId(addr);
    const v2 = mgr.reserveVariantId(addr);
    const v3 = mgr.reserveVariantId(addr);
    setFile(mgr, addr, v1, "v1.mp4");
    setFile(mgr, addr, v2, "v2.mp4");
    setFile(mgr, addr, v3, "v3.mp4");
    mgr.setAccepted(addr, v1);
    await setThumbnail(mgr, addr, v3, ".konte/cache/thumbnails/v3.jpg");

    const candidates = buildVariantCandidates(mgr, addr, v1, null, (vid, v) =>
      videoVariantThumbUrl(tmpDir, addr, vid, v),
    );

    expect(candidates.map((c) => c.variantId)).toEqual([v3, v2, v1]);
    expect(candidates.map((c) => c.variantStatus)).toEqual(["none", "none", "accepted"]);
    expect(candidates[0]!.imageUrl).toBe(
      `/api/thumbnail-assets/${encodeURIComponent(".konte/cache/thumbnails/v3.jpg")}`,
    );
    expect(candidates[1]!.imageUrl).toBeNull();
  });

  it("skips variants without a file", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const v1 = mgr.reserveVariantId(addr);
    mgr.reserveVariantId(addr); // no file
    setFile(mgr, addr, v1, "v1.mp4");

    const candidates = buildVariantCandidates(mgr, addr, null, null, (vid, v) =>
      videoVariantThumbUrl(tmpDir, addr, vid, v),
    );
    expect(candidates.map((c) => c.variantId)).toEqual([v1]);
  });

  it("de-emphasizes a definition-stale accepted variant below a fresh newer one", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const v1 = mgr.reserveVariantId(addr);
    const v2 = mgr.reserveVariantId(addr);
    setFile(mgr, addr, v1, "v1.mp4");
    setFile(mgr, addr, v2, "v2.mp4");
    // v1 was generated under an older definition; v2 (the reroll) matches the live one.
    mgr.ensureAssetState(addr).variants![v1]!.definitionHash = "old-hash";
    mgr.ensureAssetState(addr).variants![v2]!.definitionHash = "live-hash";
    mgr.setAccepted(addr, v1);

    const candidates = buildVariantCandidates(mgr, addr, v1, "live-hash", (vid, v) =>
      videoVariantThumbUrl(tmpDir, addr, vid, v),
    );

    // Fresh pending variant is recommended first; stale accepted one is pushed down.
    expect(candidates.map((c) => c.variantId)).toEqual([v2, v1]);
    expect(candidates.find((c) => c.variantId === v1)?.stale).toBe(true);
    expect(candidates.find((c) => c.variantId === v2)?.stale).toBe(false);
  });

  it("marks the fresh reroll as isNew (and the accepted one as not) in the candidate list", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const v1 = mgr.reserveVariantId(addr);
    const v2 = mgr.reserveVariantId(addr);
    setReady(mgr, addr, v1, "v1.mp4", "2026-06-02T00:00:01.000Z");
    mgr.setAccepted(addr, v1);
    setReady(mgr, addr, v2, "v2.mp4", "2026-06-02T00:00:02.000Z");

    const candidates = buildVariantCandidates(mgr, addr, v1, null, (vid, v) =>
      videoVariantThumbUrl(tmpDir, addr, vid, v),
    );
    expect(candidates.find((c) => c.variantId === v2)?.isNew).toBe(true);
    expect(candidates.find((c) => c.variantId === v1)?.isNew).toBe(false);
  });

  it("flags a reroll standing undecided beside the accept, and clears once it is dismissed", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const v1 = mgr.reserveVariantId(addr);
    setReady(mgr, addr, v1, "v1.mp4", "2026-06-02T00:00:01.000Z");
    mgr.setAccepted(addr, v1);
    // No rival yet.
    expect(hasNewerReadyVariant(mgr, addr, v1, null)).toBe(false);
    // A reroll reserves a later variant; not ready until it has a file.
    const v2 = mgr.reserveVariantId(addr);
    expect(hasNewerReadyVariant(mgr, addr, v1, null)).toBe(false);
    setReady(mgr, addr, v2, "v2.mp4", "2026-06-02T00:00:02.000Z");
    expect(hasNewerReadyVariant(mgr, addr, v1, null)).toBe(true);
    // The human saw the reroll and kept the old take: re-accepting it dismisses the rival.
    mgr.setAccepted(addr, v1, { dismiss: [v2] });
    expect(hasNewerReadyVariant(mgr, addr, v1, null)).toBe(false);
  });

  it("detects a parallel reroll that finishes after a later-reserved accept", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    // v1 is reserved first but completes last; v2 is reserved second, completes first, and gets
    // accepted. v1 was not a candidate at that moment (no file), so nothing settled it — it is a
    // take awaiting a verdict as soon as it lands.
    const v1 = mgr.reserveVariantId(addr);
    const v2 = mgr.reserveVariantId(addr);
    setReady(mgr, addr, v2, "v2.mp4", "2026-06-02T00:00:01.000Z");
    mgr.setAccepted(addr, v2);
    expect(hasNewerReadyVariant(mgr, addr, v2, null)).toBe(false);
    setReady(mgr, addr, v1, "v1.mp4", "2026-06-02T00:00:02.000Z");
    expect(hasNewerReadyVariant(mgr, addr, v2, null)).toBe(true);
  });

  it("does not flag when nothing is accepted, or every rival was settled", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const v1 = mgr.reserveVariantId(addr);
    const v2 = mgr.reserveVariantId(addr);
    setReady(mgr, addr, v1, "v1.mp4", "2026-06-02T00:00:01.000Z");
    setReady(mgr, addr, v2, "v2.mp4", "2026-06-02T00:00:02.000Z");
    expect(hasNewerReadyVariant(mgr, addr, null, null)).toBe(false);
    mgr.setAccepted(addr, v2, { dismiss: [v1] });
    expect(hasNewerReadyVariant(mgr, addr, v2, null)).toBe(false);
  });

  it("keeps a dismissed take in the gallery, out of the recommended run", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const v1 = mgr.reserveVariantId(addr);
    const v2 = mgr.reserveVariantId(addr);
    setReady(mgr, addr, v1, "v1.mp4", "2026-06-02T00:00:01.000Z");
    setReady(mgr, addr, v2, "v2.mp4", "2026-06-02T00:00:02.000Z");
    mgr.setAccepted(addr, v2, { dismiss: [v1] });

    const candidates = buildVariantCandidates(mgr, addr, v2, null, (vid, v) =>
      videoVariantThumbUrl(tmpDir, addr, vid, v),
    );
    expect(candidates.map((c) => c.variantId)).toEqual([v2, v1]);
    expect(candidates.find((c) => c.variantId === v1)?.dismissed).toBe(true);
    expect(candidates.find((c) => c.variantId === v1)?.isNew).toBe(false);
  });

  it("ignores a newer variant that is definition-stale", async () => {
    const mgr = await StateManager.init(tmpDir);
    const addr = "video:shot.01.motion";
    const v1 = mgr.reserveVariantId(addr);
    const v2 = mgr.reserveVariantId(addr);
    setReady(mgr, addr, v1, "v1.mp4", "2026-06-02T00:00:01.000Z");
    setReady(mgr, addr, v2, "v2.mp4", "2026-06-02T00:00:02.000Z");
    mgr.ensureAssetState(addr).variants![v2]!.definitionHash = "old-hash";
    mgr.setAccepted(addr, v1);
    expect(hasNewerReadyVariant(mgr, addr, v1, "live-hash")).toBe(false);
  });
});

describe("recordFeedbackFor", () => {
  it("carries each comment's snapshotted take into the record, omitting an empty one", async () => {
    const fbMgr = await FeedbackManager.load(tmpDir, "video");
    const addr = "video:shot.01";
    fbMgr.addFeedback(addr, {
      id: "fb-1",
      displayedVariants: { "video:shot.01.motion": "v-abc" },
      annotation: null,
      text: "too dark",
      createdAt: NOW,
      createdBy: "local",
    });
    fbMgr.addFeedback(addr, {
      id: "fb-2",
      displayedVariants: {},
      annotation: null,
      text: "pacing feels slow",
      createdAt: NOW,
      createdBy: "local",
    });

    const feedback = recordFeedbackFor(fbMgr, addr, new Map(), new Set(), new Set());
    expect(feedback[0]!.displayedVariants).toEqual({ "video:shot.01.motion": "v-abc" });
    expect(feedback[1]).not.toHaveProperty("displayedVariants");
  });
});

describe("buildAddressFeedback", () => {
  it("returns persisted feedback for a shot-level address with annotations mapped", async () => {
    const state = (await StateManager.init(tmpDir)).getState();
    const fbMgr = await FeedbackManager.load(tmpDir, "video");
    const addr = "video:shot.01";
    fbMgr.addFeedback(addr, {
      id: "fb-1",
      displayedVariants: {},
      annotation: { kind: "pin", x: 0.5, y: 0.25 },
      text: "fix the lighting",
      createdAt: NOW,
      createdBy: "local",
    });
    fbMgr.addFeedback(addr, {
      id: "fb-2",
      displayedVariants: {},
      annotation: null,
      text: "pacing feels slow",
      createdAt: NOW,
      createdBy: "local",
    });

    const feedback = buildAddressFeedback(fbMgr, state, addr);
    expect(feedback).toHaveLength(2);
    expect(feedback[0]).toMatchObject({
      id: "fb-1",
      address: addr,
      annotation: { kind: "pin", x: 0.5, y: 0.25 },
      text: "fix the lighting",
      stale: false,
    });
    expect(feedback[1]!.annotation).toBeNull();
  });

  it("returns empty for an address with no feedback", async () => {
    const state = (await StateManager.init(tmpDir)).getState();
    const fbMgr = await FeedbackManager.load(tmpDir, "video");
    expect(buildAddressFeedback(fbMgr, state, "video:shot.99")).toEqual([]);
  });
});

describe("applyFeedbackMutations", () => {
  it("adds, edits, and deletes feedback", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "video");
    const addr = "video:shot.01";

    const { added } = applyFeedbackMutations(
      mgr,
      [{ address: addr, text: "needs more contrast", annotation: { kind: "pin", x: 0.1, y: 0.2 } }],
      [],
    );
    expect(added).toHaveLength(1);
    const id = added[0]!.id;
    expect(added[0]!.address).toBe(addr);
    const stored = mgr.getFeedback(addr);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id, text: "needs more contrast" });
    expect(stored[0]!.annotation).toEqual({ kind: "pin", x: 0.1, y: 0.2 });

    applyFeedbackMutations(mgr, [], [{ op: "edit", id, address: addr, text: "edited" }]);
    expect(mgr.getFeedback(addr)[0]!.text).toBe("edited");

    applyFeedbackMutations(mgr, [], [{ op: "delete", id, address: addr }]);
    expect(mgr.getFeedback(addr)).toHaveLength(0);
  });

  it("returns added feedback in input order with addresses", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "video");
    const { added } = applyFeedbackMutations(
      mgr,
      [
        { address: "video:shot.01", text: "a", annotation: null, time: 1 },
        { address: "video:shot.02", text: "b", annotation: null, time: 2 },
      ],
      [],
    );
    expect(added.map((a) => a.address)).toEqual(["video:shot.01", "video:shot.02"]);
    expect(added.map((a) => a.time)).toEqual([1, 2]);
  });

  it("hands back each pin as stored, so the capture can burn it into the frame", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "video");
    const { added } = applyFeedbackMutations(
      mgr,
      [
        // Past the frame edge: the reticle must land where the stored comment points, not where
        // the client's raw drag ended.
        { address: "video:shot.01", text: "a", annotation: { kind: "pin", x: 1.4, y: 0.2 } },
        { address: "video:shot.02", text: "b", annotation: null },
      ],
      [],
    );
    expect(added.map((a) => a.annotation)).toEqual([{ kind: "pin", x: 1, y: 0.2 }, null]);
  });

  it("deletes the feedback a patch names", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "video");
    const addr = "video:shot.01";
    const { added } = applyFeedbackMutations(
      mgr,
      [{ address: addr, text: "x", annotation: null, time: 1 }],
      [],
    );
    const id = added[0]!.id;

    applyFeedbackMutations(mgr, [], [{ op: "delete", id, address: addr }]);
    expect(mgr.getFeedback(addr)).toEqual([]);
  });

  it("stores the variant snapshot passed with added feedback", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "video");
    const addr = "video:shot.01.motion";
    const v1 = "v-abc00001";

    applyFeedbackMutations(
      mgr,
      [{ address: addr, text: "comment", annotation: null, displayedVariants: { [addr]: v1 } }],
      [],
    );
    expect(mgr.getFeedback(addr)[0]!.displayedVariants).toEqual({ [addr]: v1 });
  });

  it("defaults to an empty snapshot when none is provided", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "video");
    const addr = "video:shot.01.motion";

    applyFeedbackMutations(mgr, [{ address: addr, text: "comment", annotation: null }], []);
    expect(mgr.getFeedback(addr)[0]!.displayedVariants).toEqual({});
  });

  it("persists a shot-local offset passed with added feedback", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "video");
    const addr = "video:shot.02";

    applyFeedbackMutations(
      mgr,
      [{ address: addr, text: "punch here", annotation: null, time: 5.4, shotTime: 2.4 }],
      [],
    );
    expect(mgr.getFeedback(addr)[0]!.shotTime).toBe(2.4);
  });
});

describe("withShotLocalTime", () => {
  const shots = [
    { shotId: "01", duration: 3 },
    { shotId: "02", duration: 4 },
    { shotId: "03", duration: 3 },
  ];

  it("stamps each shot-note with its offset from the shot's timeline start", () => {
    const out = withShotLocalTime(
      [
        { address: "video:shot.01", text: "a", time: 1 }, // shot 01 starts at 0
        { address: "video:shot.02", text: "b", time: 5.5 }, // shot 02 starts at 3 -> 2.5
        { address: "video:shot.03", text: "c", time: 8 }, // shot 03 starts at 7 -> 1
      ],
      shots,
    );
    expect(out.map((n) => n.shotTime)).toEqual([1, 2.5, 1]);
  });

  it("leaves timeless, timeline, and non-video notes unchanged", () => {
    const out = withShotLocalTime(
      [
        { address: "video:shot.01", text: "a" }, // no time
        { address: "video:timeline.bgm", text: "b", time: 2 }, // no shot match
      ],
      shots,
    );
    expect(out.every((n) => n.shotTime === undefined)).toBe(true);
  });
});

describe("unacceptReelShots", () => {
  // Only `stage` and `shots[].id` are read here — enough for the release to format its addresses.
  const video = { stage: "video", shots: [] } as unknown as VideoDefinition;

  function setupAccepted(mgr: StateManager, address: string): void {
    const variantId = mgr.reserveVariantId(address);
    const variant = mgr.ensureAssetState(address).variants?.[variantId];
    if (variant) variant.file = `output/${variantId}.mp4`;
    mgr.setAccepted(address, variantId);
  }

  it("un-accepts a toggled-off shot's assets and composition, leaving other shots alone", async () => {
    const mgr = await StateManager.init(tmpDir);
    setupAccepted(mgr, "video:shot.01.motion");
    setupAccepted(mgr, "video:shot.01#composition");
    setupAccepted(mgr, "video:shot.02.motion");
    setupAccepted(mgr, "video:shot.02#composition");

    // Only the keys (asset names) and shotFn presence matter; values are ignored.
    const shots = [
      { shotId: "01", resolvedVariants: { motion: "v-x" }, shotFn: () => null },
      { shotId: "02", resolvedVariants: { motion: "v-y" }, shotFn: () => null },
    ];

    const result = unacceptReelShots(mgr, video, shots, new Set(["01"]));

    expect(result.sort()).toEqual(["video:shot.01#composition", "video:shot.01.motion"]);
    expect(mgr.getAcceptedVariant("video:shot.01.motion")).toBeNull();
    expect(mgr.getAcceptedVariant("video:shot.01#composition")).toBeNull();
    // A shot the reviewer didn't toggle stays accepted.
    expect(mgr.getAcceptedVariant("video:shot.02.motion")).not.toBeNull();
    expect(mgr.getAcceptedVariant("video:shot.02#composition")).not.toBeNull();
  });

  // The release is symmetric with the accept: the shot's own stem goes with it, because that verdict
  // covered the sound as well as the picture.
  it("releases the shot's stem with it", async () => {
    const mgr = await StateManager.init(tmpDir);
    setupAccepted(mgr, "video:shot.01.motion");
    setupAccepted(mgr, "video:shot.01#composition");
    setupAccepted(mgr, "video:shot.01#stem");

    const shots = [{ shotId: "01", resolvedVariants: { motion: "v-x" }, shotFn: () => null }];

    expect(unacceptReelShots(mgr, video, shots, new Set(["01"])).sort()).toEqual([
      "video:shot.01#composition",
      "video:shot.01#stem",
      "video:shot.01.motion",
    ]);
  });

  it("returns nothing for a no-op decision on an already un-accepted shot", async () => {
    const mgr = await StateManager.init(tmpDir);
    setupAccepted(mgr, "video:shot.01.motion");
    setupAccepted(mgr, "video:shot.01#composition");

    const shots = [{ shotId: "01", resolvedVariants: { motion: "v-x" }, shotFn: () => null }];

    expect(unacceptReelShots(mgr, video, shots, new Set(["01"]))).toHaveLength(2);
    // Second pass: nothing is accepted anymore, so no addresses come back — this is
    // why the submit handler can force-save a real change without saving a no-op.
    expect(unacceptReelShots(mgr, video, shots, new Set(["01"]))).toEqual([]);
  });
});

describe("isValidSubmitPayload", () => {
  it("accepts what each preview mode actually posts", () => {
    expect(
      isValidSubmitPayload("video", {
        decisions: { "01": "accepted", "02": "none" },
        timelineStemDecision: "accepted",
        displayedVariants: { "video:shot.01.motion": "v-abc" },
        displayedStandInShotIds: ["02"],
        addedFeedback: [
          {
            address: "video:shot.01",
            text: "too dark",
            annotation: { kind: "pin", x: 0.4, y: 0.6 },
            time: 1.5,
            displayedVariants: { "video:shot.01.motion": "v-abc" },
          },
        ],
        feedbackPatches: [{ op: "edit", id: "fb-1", address: "video:shot.01", text: "x" }],
        notes: [{ time: 1.5, shotId: "01", text: "too dark", x: 0.4, y: 0.6 }],
      }),
    ).toBe(true);

    expect(
      isValidSubmitPayload("stage", {
        stage: "animatic",
        addedFeedback: [],
        feedbackPatches: [],
        decisions: [{ address: "animatic:shot.01.key", variantId: "v-abc", status: "accepted" }],
      }),
    ).toBe(true);

    expect(
      isValidSubmitPayload("direction", {
        addedFeedback: [],
        feedbackPatches: [],
        accept: true,
        reviewedHash: "abc123",
      }),
    ).toBe(true);
  });

  // Which half each shot displayed cannot be re-derived at submit time (a dependency finishing
  // mid-review flips it), so a caller that cannot state it is refused rather than served a guess.
  it("rejects a video submit that does not say which shots displayed an animatic", () => {
    expect(
      isValidSubmitPayload("video", {
        decisions: { "01": "accepted" },
        displayedVariants: { "video:shot.01.motion": "v-abc" },
      }),
    ).toBe(false);
  });

  it("rejects a malformed decision or shown-variant map before anything is written", () => {
    // Each of these previously reached saveReviewRecord — i.e. after the accepts and the feedback
    // had already been committed — and only failed there.
    expect(isValidSubmitPayload("video", { decisions: { "01": "maybe" } })).toBe(false);
    expect(
      isValidSubmitPayload("video", {
        displayedVariants: { "video:shot.01.motion": 123 },
      }),
    ).toBe(false);
    expect(isValidSubmitPayload("video", { notes: [{ time: "start", text: "x" }] })).toBe(false);
    expect(
      isValidSubmitPayload("stage", {
        addedFeedback: [],
        feedbackPatches: [],
        decisions: [{ address: "animatic:shot.01.key", variantId: 7, status: "accepted" }],
      }),
    ).toBe(false);
    expect(isValidSubmitPayload("video", { addedFeedback: [{ address: "a", text: 5 }] })).toBe(
      false,
    );
  });

  it("rejects a payload shaped for another mode, or missing a mode's required arrays", () => {
    // A video-shaped accept map on an animatic submit, and a direction accept sent as a string:
    // both would otherwise pass the door and then throw mid-write.
    expect(
      isValidSubmitPayload("stage", {
        addedFeedback: [],
        feedbackPatches: [],
        decisions: { "01": "accepted" },
      }),
    ).toBe(false);
    expect(
      isValidSubmitPayload("direction", {
        addedFeedback: [],
        feedbackPatches: [],
        sectionDecisions: { brief: "true" },
      }),
    ).toBe(false);
    // A section nobody reviews is a section nobody can accept: the verdict must name a box the page
    // actually renders, or it would write parts no reviewer ever saw.
    expect(
      isValidSubmitPayload("direction", {
        addedFeedback: [],
        feedbackPatches: [],
        sectionDecisions: { everything: true },
      }),
    ).toBe(false);
    expect(isValidSubmitPayload("stage", { feedbackPatches: [] })).toBe(false);
    expect(isValidSubmitPayload("direction", { addedFeedback: [] })).toBe(false);
  });
});

// The pending animatic tile has no panel of its own, so its script comes from the direction —
// with character ids resolved to the names a reviewer reads, the same as the direction review's.
describe("shotFactsIndex", () => {
  const direction = {
    brief: { logline: "test" },
    characters: { cat: { name: "Mika", description: "a white cat", promptDepiction: "cat" } },
    locations: {
      studio: {
        name: "the studio",
        description: "a plain studio",
        landmarks: {
          studioMark: {
            name: "the mark",
            promptDepiction: "mark",
            description: "a mark only this place has",
          },
        },
      },
    },
    setups: {
      front: {
        name: "the front angle",
        description: "straight on, eye level",
        location: "studio",
        framing: "medium",
        holds: ["studioMark"],
      },
    },
    policy: {
      format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
      lang: "en",
      speech: "free",
    },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        {
          id: "01",
          role: "ordinary",
          action: "she opens the window",
          setup: "front",
          duration: 5,
          script: [{ character: "cat", text: "good morning" }, { narration: "dawn" }],
        },
      ],
    },
  } as unknown as Direction;

  it("resolves a shot's script, its character ids as roster names", () => {
    expect(shotFactsIndex(direction).get("01")?.script).toEqual([
      { speaker: "Mika", text: "good morning", acting: null },
      { speaker: null, text: "dawn", acting: null },
    ]);
  });

  // Both are read through the shot's setup, and the location by NAME — the word the space column shows.
  it("resolves the shot's location name and framing through its setup", () => {
    expect(shotFactsIndex(direction).get("01")?.location).toBe("the studio");
    expect(shotFactsIndex(direction).get("01")?.framing).toBe("medium");
  });

  it("is empty without a direction, so a board with no direction.ts still renders", () => {
    expect(shotFactsIndex(null).size).toBe(0);
  });
});
