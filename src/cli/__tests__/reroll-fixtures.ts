import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect } from "vitest";
import { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/manager.js";
import { ctx, initWorkspace, writeWorkspaceConfig } from "./cli-fixtures.js";

// The record as plain JSON, so a test reads nested metadata without narrowing the union.
export async function readJob(videoRoot: string, id: string): Promise<any> {
  return JSON.parse(JSON.stringify(await new JobManager(videoRoot).getJob(id)));
}

// A reference stage of offline (ffmpeg) building blocks: two independent images plus one that
// consumes the first, so reroll runs end-to-end without a backend and `keyed` gives us a
// downstream to test in-run pinning. They use `internalTestImage` rather than a shipped `local`
// adapter because reroll refuses a deterministic asset — `derived` is the one that stays
// deterministic, to exercise that refusal and the dependent cascade.
export const REROLL_REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
import direction from "./direction";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";

export default defineReference(direction, { references: () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latentA = asset("latentA", internalTestImage, { width: 64, height: 64 });
  const latentB = asset("latentB", internalTestImage, { width: 48, height: 48 });
  const keyed = asset("keyed", internalTestImage, { image: latentA, width: 32, height: 32 });
  const derived = asset("derived", adapters.imageResize, { image: latentA, width: 16, height: 16 });
  return { character, bgm, latentA, latentB, keyed, derived };
} });
`;

export async function initRerollProject(): Promise<string> {
  const inited_rerollproj = await initWorkspace(path.join(ctx.dir, "rerollproj"));
  const projectDir = inited_rerollproj.video;
  await fs.writeFile(path.join(projectDir, "reference.tsx"), REROLL_REFERENCE_TS);
  return projectDir;
}

// "  <address>: <status> → <variantId>" — the one line reroll prints per take it registered.
type RerollJob = { address: string; status: string; variantId: string };
export const rerollJobs = (stdout: string): RerollJob[] =>
  [...stdout.matchAll(/^ {2}(\S+): (\S+) → (\S+)$/gm)].map((m) => ({
    address: m[1]!,
    status: m[2]!,
    variantId: m[3]!,
  }));
export const jobsByAddress = (stdout: string, address: string): RerollJob[] =>
  rerollJobs(stdout).filter((j) => j.address === address);

// reroll is a spend entry point, so it passes the same gate — before a variant id is reserved
// and a job written.
export const COMFY_REFERENCE_TS = `import { defineReference, asset, adapters, defineComfyAsset } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

const plateAdapter = defineComfyAsset({
  workflow: "plate.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineReference(direction, { references: () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latent = asset("latent", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  const plate = asset("plate", plateAdapter, {});
  return { character, bgm, latent, plate };
} });
`;

export async function initComfyRerollProject(name: string, comfyui: unknown): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, name));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "reference.tsx"), COMFY_REFERENCE_TS);
  await writeWorkspaceConfig(projectDir, { comfy: { comfyui } });
  return projectDir;
}

// Nothing may be reserved on the way to a refusal, whichever half of the gate refuses.
export async function expectNothingReserved(projectDir: string): Promise<void> {
  const state = JSON.parse(
    await fs.readFile(path.join(projectDir, "konte.state.json"), "utf-8"),
  ) as { assets?: Record<string, { variants?: Record<string, unknown> }> };
  expect(state.assets?.["reference:plate"]?.variants ?? {}).toEqual({});
}

// Rerolling an accepted asset draws a rival beside the accept; the accept that picks between
// them settles the other.
export async function acceptFresh(projectDir: string, address: string): Promise<string> {
  const sm = await StateManager.load(projectDir);
  const vid = sm.reserveVariantId(address);
  sm.getAssetState(address).variants![vid]!.file = `assets/${vid}.png`;
  sm.setAccepted(address, vid);
  await sm.save();
  return vid;
}
