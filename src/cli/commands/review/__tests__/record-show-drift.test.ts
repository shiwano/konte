import { describe, expect, it } from "vitest";
import { getAssetEntryByAddress } from "../../../../core/address.js";
import { writeDefinitionSnapshot } from "../../../../core/definition-snapshot.js";
import { type ReviewRecord, saveReviewRecord } from "../../../../core/review-record.js";
import { StateManager } from "../../../../core/state/manager.js";
import type { AssetDefinition } from "../../../../core/types/index.js";
import { loadVideoAndAnimatic } from "../../../load-definition.js";
import { run } from "../../../__tests__/harness.js";
import { projectDir, useReviewShowProject } from "./record-show-fixtures.js";

useReviewShowProject();

async function acceptingRecord(): Promise<{ record: ReviewRecord; address: string; vid: string }> {
  const { video } = await loadVideoAndAnimatic(projectDir);
  const shot = video.shots[0]!;
  const sm = await StateManager.load(projectDir);
  const variants: Record<string, string> = {};
  for (const name of Object.keys(shot.assets ?? {})) {
    variants[name] = sm.selectVariant(`video:shot.${shot.id}.${name}`)!.variantId;
  }
  const [name, vid] = Object.entries(variants)[0]!;
  return {
    record: {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: shot.id, start: 0, duration: 5, variants }] },
      decisions: { [shot.id]: "accepted" },
    },
    address: `video:shot.${shot.id}.${name}`,
    vid,
  };
}

// Age the take out of its definition: a hash the current one no longer matches, and a snapshot
// that differs from the current definition at `field`.
async function driftTake(address: string, vid: string, field: string): Promise<void> {
  const { video } = await loadVideoAndAnimatic(projectDir);
  const current = getAssetEntryByAddress(video, address) as AssetDefinition & {
    inputs?: Record<string, unknown>;
  };
  writeDefinitionSnapshot(projectDir, address, vid, {
    ...current,
    inputs: { ...current.inputs, [field]: "an earlier value" },
  } as AssetDefinition);
  const sm = await StateManager.load(projectDir);
  sm.getAssetState(address).variants![vid]!.definitionHash = "an-earlier-hash";
  await sm.save();
}

describe("review record show — accepted against a changed definition", () => {
  it("names a still-accepted take whose definition moved, with the fields that moved", async () => {
    const { record, address, vid } = await acceptingRecord();
    await saveReviewRecord(projectDir, record, { force: true });
    await driftTake(address, vid, "prompt");

    const { stdout } = await run(["review", "record", "show"], projectDir);

    expect(stdout).toContain("Accepted against a changed definition:");
    expect(stdout).toContain(`  ${address} (${vid}) — inputs.prompt changed since this take`);
  });

  it("lists nothing while every accepted take matches its definition", async () => {
    const { record } = await acceptingRecord();
    await saveReviewRecord(projectDir, record, { force: true });

    const { stdout } = await run(["review", "record", "show"], projectDir);

    expect(stdout).not.toContain("Accepted against a changed definition:");
  });

  it("drops a take a later accept replaced", async () => {
    const { record, address, vid } = await acceptingRecord();
    await saveReviewRecord(projectDir, record, { force: true });
    await driftTake(address, vid, "prompt");
    const sm = await StateManager.load(projectDir);
    const newer = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![newer]!.file =
      sm.getAssetState(address).variants![vid]!.file;
    sm.setAccepted(address, newer);
    await sm.save();

    const { stdout } = await run(["review", "record", "show"], projectDir);

    expect(stdout).not.toContain("Accepted against a changed definition:");
  });
});
