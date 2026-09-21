import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import { resolveRefs } from "../ref-resolver.js";
import { StateManager } from "../state/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-ref-resolver-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveRefs", () => {
  it("resolves from accepted variant", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![vid]!.file = "/path/to/motion.mp4";
    manager.setAccepted("video:shot.01.motion", vid);

    const result = resolveRefs(["video:shot.01.motion"], manager);
    expect(result).toEqual({ "video:shot.01.motion": "/path/to/motion.mp4" });
  });

  it("falls back to any ready variant in non-strict mode", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![vid]!.file = "/path/to/motion.mp4";

    const result = resolveRefs(["video:shot.01.motion"], manager);
    expect(result).toEqual({ "video:shot.01.motion": "/path/to/motion.mp4" });
  });

  it("throws in strict mode when no accepted variant has a file", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![vid]!.file = "/path/to/motion.mp4";

    expect(() => resolveRefs(["video:shot.01.motion"], manager, { strict: true })).toThrow(
      KonteError,
    );
  });

  it("resolves accepted variant in strict mode", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![vid]!.file = "/path/to/motion.mp4";
    manager.setAccepted("video:shot.01.motion", vid);

    const result = resolveRefs(["video:shot.01.motion"], manager, { strict: true });
    expect(result).toEqual({ "video:shot.01.motion": "/path/to/motion.mp4" });
  });

  it("throws when no ready asset exists", async () => {
    const manager = await StateManager.init(tmpDir);
    manager.reserveVariantId("video:shot.01.motion");

    expect(() => resolveRefs(["video:shot.01.motion"], manager)).toThrow(KonteError);
    expect(() => resolveRefs(["video:shot.01.motion"], manager)).toThrow("no ready asset");
  });

  it("resolves multiple dependencies", async () => {
    const manager = await StateManager.init(tmpDir);

    const vid1 = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![vid1]!.file = "/path/to/motion.mp4";
    manager.setAccepted("video:shot.01.motion", vid1);

    const vid2 = manager.reserveVariantId("video:shot.01.voice");
    manager.getAssetState("video:shot.01.voice").variants![vid2]!.file = "/path/to/voice.wav";
    manager.setAccepted("video:shot.01.voice", vid2);

    const result = resolveRefs(["video:shot.01.motion", "video:shot.01.voice"], manager);
    expect(result).toEqual({
      "video:shot.01.motion": "/path/to/motion.mp4",
      "video:shot.01.voice": "/path/to/voice.wav",
    });
  });

  it("returns empty object for empty addresses", async () => {
    const manager = await StateManager.init(tmpDir);

    const result = resolveRefs([], manager);
    expect(result).toEqual({});
  });

  it("falls back to the newest ready variant, not the oldest", async () => {
    const manager = await StateManager.init(tmpDir);
    const oldVid = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![oldVid]!.file = "/path/to/old.mp4";
    const newVid = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![newVid]!.file = "/path/to/new.mp4";

    const result = resolveRefs(["video:shot.01.motion"], manager);
    expect(result).toEqual({ "video:shot.01.motion": "/path/to/new.mp4" });
  });

  it("skips input-stale variants even when they are the newest", async () => {
    const manager = await StateManager.init(tmpDir);

    const upVid = manager.reserveVariantId("video:shot.01.first");
    const up = manager.getAssetState("video:shot.01.first").variants![upVid]!;
    up.file = "/path/to/first.png";
    up.outputHash = "current-hash";
    manager.setAccepted("video:shot.01.first", upVid);

    const freshVid = manager.reserveVariantId("video:shot.01.motion");
    const fresh = manager.getAssetState("video:shot.01.motion").variants![freshVid]!;
    fresh.file = "/path/to/fresh.mp4";
    fresh.inputFingerprints = { "video:shot.01.first": "current-hash" };

    const staleVid = manager.reserveVariantId("video:shot.01.motion");
    const stale = manager.getAssetState("video:shot.01.motion").variants![staleVid]!;
    stale.file = "/path/to/stale.mp4";
    stale.inputFingerprints = { "video:shot.01.first": "old-hash" };

    const result = resolveRefs(["video:shot.01.motion"], manager);
    expect(result).toEqual({ "video:shot.01.motion": "/path/to/fresh.mp4" });
  });
});
