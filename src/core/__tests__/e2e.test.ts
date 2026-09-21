import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAssetPath } from "../address.js";
import { FakeBackend } from "../fake-backend.js";
import { computeAcceptedStaleness, isAcceptedStale, isVariantStale } from "../staleness.js";
import { StateManager } from "../state/index.js";
import type { AssetDefinition, VideoDefinition } from "../types/index.js";
import videoDef from "./fixtures/valid-video.js";

const video: VideoDefinition = videoDef;

function getAssetDefinition(video: VideoDefinition, assetPath: string): AssetDefinition {
  const parsed = parseAssetPath(assetPath);
  if (parsed.kind !== "shot") throw new Error(`Expected shot address, got "${parsed.kind}"`);
  const shot = video.shots.find((s) => s.id === parsed.shotId);
  if (!shot) throw new Error(`Shot "${parsed.shotId}" not found`);
  return shot.assets[parsed.assetName]!;
}

function makeTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "konte-e2e-"));
}

let backend: FakeBackend;
let tmpDir: string;

beforeEach(async () => {
  backend = new FakeBackend();
  tmpDir = await makeTempProject();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("E2E: accept -> computed stale propagation -> reroll clears stale", () => {
  it("accept changes propagate stale and reroll clears it", async () => {
    const sm = await StateManager.init(tmpDir);

    const motionAddr = "video:shot.01.motion";
    const voiceAddr = "video:shot.01.voice";

    // motion v1 generated and accepted.
    const motionV1 = sm.reserveVariantId(motionAddr);
    const motionResult = await backend.generate({
      address: motionAddr,
      assetDefinition: getAssetDefinition(video, "video:shot.01.motion"),
      variantId: motionV1,
      outputDir: path.join(tmpDir, "assets", "shot.01.motion", motionV1),
      resolvedDependencies: {},
    });
    sm.getAssetState(motionAddr).variants![motionV1]!.file = motionResult.files[0]!;
    sm.getAssetState(motionAddr).variants![motionV1]!.outputHash = "motion-h1";
    sm.setAccepted(motionAddr, motionV1);

    // voice consumed motion v1 (recording its output hash) and accepted.
    const voiceV1 = sm.reserveVariantId(voiceAddr);
    const voiceResult = await backend.generate({
      address: voiceAddr,
      assetDefinition: getAssetDefinition(video, "video:shot.01.voice"),
      variantId: voiceV1,
      outputDir: path.join(tmpDir, "assets", "shot.01.voice", voiceV1),
      resolvedDependencies: { "video:shot.01.motion": motionResult.files[0]! },
    });
    sm.getAssetState(voiceAddr).variants![voiceV1]!.file = voiceResult.files[0]!;
    sm.getAssetState(voiceAddr).variants![voiceV1]!.inputFingerprints = {
      "video:shot.01.motion": "motion-h1",
    };
    sm.setAccepted(voiceAddr, voiceV1);

    // Matching recorded input -> voice is not stale.
    expect(isAcceptedStale(sm, voiceAddr)).toBe(false);

    // Reroll motion to a different output and accept it.
    const motionV2 = sm.reserveVariantId(motionAddr);
    const motionResult2 = await backend.generate({
      address: motionAddr,
      assetDefinition: getAssetDefinition(video, "video:shot.01.motion"),
      variantId: motionV2,
      outputDir: path.join(tmpDir, "assets", "shot.01.motion", motionV2),
      resolvedDependencies: {},
    });
    sm.getAssetState(motionAddr).variants![motionV2]!.file = motionResult2.files[0]!;
    sm.getAssetState(motionAddr).variants![motionV2]!.outputHash = "motion-h2";
    sm.setAccepted(motionAddr, motionV2);

    // voice's recorded input no longer matches the accepted upstream -> input-stale.
    expect(isAcceptedStale(sm, voiceAddr)).toBe(true);
    const voiceStaleness = computeAcceptedStaleness(sm.getState(), voiceAddr, null);
    expect(voiceStaleness.variantId).toBe(voiceV1);
    expect(voiceStaleness.changedInputs).toEqual([
      { assetPath: "video:shot.01.motion", recorded: "motion-h1", current: "motion-h2" },
    ]);

    // The newly accepted upstream itself is not stale.
    const motionV2State = sm.getAssetState(motionAddr).variants![motionV2]!;
    expect(isVariantStale(sm.getState(), motionAddr, motionV2State, null)).toBe(false);

    // Rerolling voice against the new upstream output clears the staleness.
    const voiceV2 = sm.reserveVariantId(voiceAddr);
    sm.getAssetState(voiceAddr).variants![voiceV2]!.file = "voice.v2.mp3";
    sm.getAssetState(voiceAddr).variants![voiceV2]!.inputFingerprints = {
      "video:shot.01.motion": "motion-h2",
    };
    sm.setAccepted(voiceAddr, voiceV2);
    expect(isAcceptedStale(sm, voiceAddr)).toBe(false);

    await sm.save();
    const reloaded = await StateManager.load(tmpDir);
    expect(isAcceptedStale(reloaded, voiceAddr)).toBe(false);
  });
});
