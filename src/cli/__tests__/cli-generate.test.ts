import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readDefinitionSnapshot } from "../../core/definition-snapshot.js";
import { ffmpegBin } from "../../core/ffmpeg-binary.js";
import { applyDirectionSectionDecisions } from "../../core/direction-acceptance.js";
import { hashFile } from "../../core/content-hash.js";
import { StateManager } from "../../core/state/manager.js";
import { loadDirectionIfPresent } from "../load-definition.js";
import {
  ctx,
  useTempWorkspace,
  writeWorkspaceConfig,
  initWithTestVideo,
  CROSS_STAGE_DIRECTION_TS,
  initWithCrossStageStemVideo,
  initWithCrossStageVideo,
  run,
  initWorkspace,
  acceptDirection,
  acceptFileAssets,
  TEST_VIDEO_TSX,
  TEST_UNCONSUMED_ANIMATIC_VIDEO_TSX,
  TEST_TIMELINE_SPEND_VIDEO_TSX,
  TEST_LOCAL_PICTURE_VIDEO_TSX,
  EMPTY_REFERENCE_TSX,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

const execFileAsync = promisify(execFile);

useTempWorkspace();

describe("CLI E2E: init → generate → status/inspect", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("reflects accepted variant in status and inspect", async () => {
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);

    sm.getAssetState(address).variants![variantId]!.file =
      `assets/video:shot.01.motion/${variantId}/output.mp4`;
    sm.setAccepted(address, variantId);
    await sm.save();

    const { stdout } = await run(["inspect", address], projectDir);
    expect(stdout).toContain(`Address: ${address}`);
    expect(stdout).toContain(`Accepted: ${variantId}`);
    expect(stdout).toMatch(new RegExp(`^ {2}${variantId}: accepted \\[.*output\\.mp4\\]`, "m"));
  });
});

// "  <address>: <action>[ (<detail>)][ [deps: …]]" — one plan line per asset the run would touch.
type PlanEntry = { address: string; action: string; detail: string };
const planEntries = (stdout: string): PlanEntry[] =>
  [...stdout.matchAll(/^ {2}(\S+): (\w+)(.*)$/gm)].map((m) => ({
    address: m[1]!,
    action: m[2]!,
    detail: m[3]!,
  }));

// `latent` is exposed (returned) but not yet consumed by any panel/composition — a
// work-in-progress building block. The reference pool is generated to be referenced later,
// so `generate reference` must still plan it.
const REFERENCE_EXPOSED_UNREFERENCED_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latent = asset("latent", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  return { character, bgm, latent };
});
`;

describe("generate reference (standalone building blocks)", () => {
  // `latent` is consumed by `key` but not returned (an intermediate); `key` is returned. Both
  // are reachable from the exposed root `key`, so both are planned.
  const REFERENCE_INTERMEDIATE_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latent = asset("latent", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  const key = asset("key", adapters.imageResize, { image: latent, width: 32, height: 32 });
  return { character, bgm, key };
});
`;

  // `orphan` is neither returned nor consumed — unused, so `generate reference` skips it,
  // mirroring an unused video/animatic asset.
  const REFERENCE_ORPHAN_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const orphan = asset("orphan", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  return { character, bgm };
});
`;

  it("plans an exposed reference asset even when nothing references it yet", async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    const projectDir = inited_refproj.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_EXPOSED_UNREFERENCED_TS);

    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const latent = planEntries(stdout).find((e) => e.address === "reference:latent");
    expect(latent).toBeDefined();
    expect(latent?.action).toBe("start");
    expect(latent?.detail).toContain("(local)");
  });

  it("plans an un-returned intermediate that an exposed asset consumes", async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    const projectDir = inited_refproj.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_INTERMEDIATE_TS);

    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const addrs = planEntries(stdout).map((e) => e.address);
    expect(addrs).toContain("reference:latent");
    expect(addrs).toContain("reference:key");
  });

  it("skips a declared reference asset that is neither returned nor consumed", async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    const projectDir = inited_refproj.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_ORPHAN_TS);

    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const addrs = planEntries(stdout).map((e) => e.address);
    expect(addrs).not.toContain("reference:orphan");
    // The exposed file assets are still present.
    expect(addrs).toContain("reference:character");
  });

  // Generating a downstream stage must auto-register the reference stage's file assets, so a
  // dependency resolves without first running `generate reference`. Regression: animatic shots
  // failed with "reference:character has no ready variant" because animatic sync never touched the
  // reference stage.
  it("auto-registers reference file assets when generating a dependent stage", async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    const projectDir = inited_refproj.video;
    // The fixture animatic declares comfy models; disable auto-install so `generate` doesn't probe
    // ComfyUI for them (this test only covers reference file-asset registration).
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await acceptDirection(projectDir);
    // The character gate runs before the sync, so the look's accept is seeded as a reviewer leaves it.
    const sm = await StateManager.load(projectDir);
    const look = sm.reserveVariantId("reference:character");
    Object.assign(sm.getAssetState("reference:character").variants![look]!, {
      file: "assets/files/character.png",
      outputHash: await hashFile(path.join(projectDir, "assets/files/character.png")),
    });
    sm.setAccepted("reference:character", look);
    await sm.save();

    await run(["generate", "animatic"], projectDir);

    const state = JSON.parse(await fs.readFile(path.join(projectDir, "konte.state.json"), "utf-8"));
    const bgm = Object.values(state.assets["reference:bgm"]?.variants ?? {}) as Array<{
      file: string;
    }>;
    expect(bgm.map((v) => v.file)).toEqual(["assets/files/bgm.mp3"]);
  });

  it("blocks animatic generation until the direction is accepted", async () => {
    const inited_gateproj = await initWorkspace(path.join(ctx.dir, "gateproj"));
    const projectDir = inited_gateproj.video;
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await acceptFileAssets(projectDir);

    // Without a recorded acceptance the spend gate refuses, pointing at the review command and
    // naming the parts that block it — "not accepted" alone would leave the author to guess.
    await expect(run(["generate", "animatic"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("DIRECTION_ACCEPTANCE_REQUIRED"),
    });

    // Acceptance is per part, so a reviewer who settled some of the page has not opened the gate:
    // the parts they never read still block it.
    const statePath = path.join(projectDir, "konte.state.json");
    const direction = await loadDirectionIfPresent(projectDir);
    const partial = JSON.parse(await fs.readFile(statePath, "utf-8"));
    partial.directionAcceptance = applyDirectionSectionDecisions(direction!, null, {
      brief: true,
      policy: true,
    });
    await fs.writeFile(statePath, JSON.stringify(partial, null, 2));
    await expect(run(["generate", "animatic"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("DIRECTION_ACCEPTANCE_REQUIRED"),
    });

    // After the reviewer accepts every section, generation proceeds.
    await acceptDirection(projectDir);
    await run(["generate", "animatic"], projectDir);
    const state = JSON.parse(await fs.readFile(statePath, "utf-8"));
    expect(state.directionAcceptance?.whole?.hash).toBeTruthy();
  });

  // The gate narrows once the piece has been signed off end to end: the shots are read as panels and
  // shots from then on, so editing one does not send the author back to a page showing the same words
  // as prose. The piece-wide agreements have no such second reading and keep blocking for good.
  it("stops blocking on a shot edited after the direction was accepted whole", async () => {
    const inited = await initWorkspace(path.join(ctx.dir, "unlockproj"));
    const projectDir = inited.video;
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);

    const statePath = path.join(projectDir, "konte.state.json");
    const accepted = JSON.parse(await fs.readFile(statePath, "utf-8"));
    const parts = accepted.directionAcceptance.parts as Record<string, { partHash: string }>;
    const shotPart = Object.keys(parts).find((a) => a.startsWith("direction:sequence.shots."))!;

    // Age the shot out exactly as rewriting it would, without touching the whole-direction verdict.
    parts[shotPart]!.partHash = "stale00000000";
    accepted.directionAcceptance.whole.hash = null;
    await fs.writeFile(statePath, JSON.stringify(accepted, null, 2));
    await run(["generate", "animatic"], projectDir);

    // The brief is the other half: no panel or shot ever shows it, so it re-blocks.
    parts["direction:brief.logline"]!.partHash = "stale11111111";
    await fs.writeFile(statePath, JSON.stringify(accepted, null, 2));
    await expect(run(["generate", "animatic"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("DIRECTION_ACCEPTANCE_REQUIRED"),
    });
  });
});

describe("generate skip decision", () => {
  // A reviewable asset — the accepted-stale hold exists to protect a human's accept, so the
  // fixture has to be something a human accepts. (`latent` below is the deterministic twin.)
  const address = "reference:plate";
  const REFERENCE_REVIEWABLE_TS = `import { defineReference, asset, adapters, defineComfyAsset } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

const plateAdapter = defineComfyAsset({
  workflow: "plate.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latent = asset("latent", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  const plate = asset("plate", plateAdapter, {});
  return { character, bgm, latent, plate };
});
`;

  // A variant carrying a definition hash that no longer matches reference.tsx — exactly the state
  // left behind by editing an asset's prompt/params after generating it.
  async function withDefinitionStaleVariant(accepted: boolean): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, `skipproj-${accepted}`));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_REVIEWABLE_TS);
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });

    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(address);
    const variant = sm.getAssetState(address).variants![vid]!;
    variant.file = `assets/${address}/${vid}/output.png`;
    variant.definitionHash = "hash-before-the-edit";
    if (accepted) sm.setAccepted(address, vid);
    await sm.save();
    return projectDir;
  }

  // Regression (P1): generate compared only input fingerprints, so an edited definition left
  // the asset "ready" and the whole run was a silent no-op — the user had to reach for reroll.
  it("regenerates an unaccepted asset whose definition changed", async () => {
    const projectDir = await withDefinitionStaleVariant(false);
    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const latent = planEntries(stdout).find((e) => e.address === address);
    expect(latent?.action).toBe("start");
  });

  // generate fills holes; replacing an accepted take is reroll's job (it drops the accept behind
  // a confirmation). A variant generated under a standing accept would not resolve anyway.
  it("leaves an accepted asset alone when its definition changed, and points at reroll", async () => {
    const projectDir = await withDefinitionStaleVariant(true);
    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const latent = planEntries(stdout).find((e) => e.address === address);
    expect(latent?.action).toBe("skip");
    expect(latent?.detail).toContain("reroll");
  });

  // The plan gets the run's own notice, not one `skip (...)` line inside a listing of every asset
  // in the stage.
  it("names each accepted-but-stale asset on the plan too", async () => {
    const projectDir = await withDefinitionStaleVariant(true);
    const { stderr } = await run(["generate", "reference", "--plan"], projectDir);
    expect(stderr).toContain(address);
    expect(stderr).toContain("konte reroll");
  });

  it("names each accepted-but-stale asset and breaks the skip count down by reason", async () => {
    const projectDir = await withDefinitionStaleVariant(true);
    const { stdout, stderr } = await run(["generate", "reference"], projectDir);
    expect(stderr).toContain(address);
    expect(stderr).toContain("definition-stale");
    expect(stderr).toContain("konte reroll");
    expect(stdout).toContain("1 accepted but stale");
  });

  // An agent reads the last line (`generate … | tail -1`); the notice above it is cut.
  it("names the reroll on the summary line and in nextSuggestedActions", async () => {
    const projectDir = await withDefinitionStaleVariant(true);
    const { stdout } = await run(["generate", "reference"], projectDir);
    const lastLine = stdout.trim().split("\n").at(-1);
    expect(lastLine).toContain(`konte reroll ${address}`);
  });

  // The exception: a deterministic take has no other outcome to pick. Re-running the op IS the
  // correction.
  async function withDeterministicAccept(dir: string): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, dir));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_EXPOSED_UNREFERENCED_TS);

    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId("reference:latent");
    const variant = sm.getAssetState("reference:latent").variants![vid]!;
    variant.file = `assets/reference:latent/${vid}/output.png`;
    variant.definitionHash = "hash-before-the-edit";
    sm.setAccepted("reference:latent", vid);
    await sm.save();
    return projectDir;
  }

  const latentAction = async (projectDir: string) => {
    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    return planEntries(stdout).find((e) => e.address === "reference:latent");
  };

  it("re-runs a deterministic asset whose definition changed, without asking for a reroll", async () => {
    const projectDir = await withDeterministicAccept("skipproj-deterministic");
    expect((await latentAction(projectDir))?.action).toBe("start");
  });

  // A patch output sits at the SOURCE address. Generating there would make a fresh original,
  // orphaning the take the correction was built on; the refresh is the patch pass, which this same
  // run does.
  it("does not generate a fresh original under an accepted patch output gone stale", async () => {
    const projectDir = await withDefinitionStaleVariant(false);
    const sm = await StateManager.load(projectDir);
    const source = Object.keys(sm.getAssetState(address).variants ?? {})[0]!;
    const fix = sm.reserveVariantId(address);
    const variant = sm.getAssetState(address).variants![fix]!;
    variant.file = `assets/${address}/${fix}/output.png`;
    variant.definitionHash = "hash-before-the-edit";
    variant.derivedFrom = source;
    sm.setAccepted(address, fix);
    await sm.save();

    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const latent = planEntries(stdout).find((e) => e.address === address);
    expect(latent?.action).toBe("skip");
  });
});

// The animatic spend gate. Everything here is offline: `local` ffmpeg ops stand in for the TTS take
// and the motion model, so the whole gate cycle runs without a backend.
describe("inspect command (cross-stage dependencies)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithCrossStageVideo();
  });

  it("lists the video shot among the animatic keyframe's dependents", async () => {
    const { stdout } = await run(["inspect", "animatic:shot.01.keyframe"], projectDir);
    expect(stdout).toMatch(/^ {2}video:shot\.01\.motion \(accepted: -\)$/m);
  });

  it("lists the animatic keyframe among the video shot's dependencies", async () => {
    const { stdout } = await run(["inspect", "video:shot.01.motion"], projectDir);
    expect(stdout).toMatch(/^Dependencies:\n {2}animatic:shot\.01\.keyframe /m);
    expect(stdout).not.toMatch(/^Dependencies:\n(?: {2}.*\n){2}/m);
  });
});

describe("animatic standalone loading", () => {
  it("surfaces a broken animatic.tsx instead of silently treating it as absent", async () => {
    const projectDir = await initWithCrossStageVideo();
    // An animatic whose default export fails validation must propagate, not be swallowed to
    // null (which would drop its assets and let `status` falsely report nothing matching).
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), "export default 42;\n");
    await expect(run(["status"], projectDir)).rejects.toThrow();
  });
});

describe("animatic acceptance gate", () => {
  it("blocks a video spend until every board it consumes is accepted", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await acceptDirection(projectDir);

    // Nothing generated on the animatic yet: the gate names the board and points at generating.
    await expect(run(["generate", "video", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ANIMATIC_ACCEPTANCE_REQUIRED"),
    });

    // A generated-but-unreviewed board still blocks — the human accept is the gate, not the file.
    const address = "animatic:shot.01.keyframe";
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = "assets/kf.png";
    await sm.save();
    await expect(run(["generate", "video", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("konte preview animatic"),
    });

    // reroll is the same spend, so it hits the same gate.
    await expect(run(["reroll", "video:shot.01.motion"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ANIMATIC_ACCEPTANCE_REQUIRED"),
    });

    // Accepting the board opens the gate.
    const sm2 = await StateManager.load(projectDir);
    sm2.setAccepted(address, variantId);
    await sm2.save();
    const { stdout } = await run(["generate", "video", "--plan"], projectDir);
    const addrs = planEntries(stdout).map((e) => e.address);
    expect(addrs).toContain("video:shot.01.motion");
  });
});

describe("animatic wiring gate", () => {
  it("refuses a video spend on a shot that consumes no board", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_UNCONSUMED_ANIMATIC_VIDEO_TSX);
    await acceptDirection(projectDir);

    await expect(run(["generate", "video", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ANIMATIC_UNCONSUMED"),
    });

    // reroll and export spend on the same wiring, so both refuse it too.
    await expect(run(["reroll", "video:shot.01.motion"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ANIMATIC_UNCONSUMED"),
    });
    await expect(run(["export", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ANIMATIC_UNCONSUMED"),
    });
  });

  // A timeline asset belongs to no one shot, so a reroll of it names no shot to scope by — and the
  // scoped form would skip the gate entirely.
  it("refuses a reroll of a timeline asset the boardless shot draws", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_TIMELINE_SPEND_VIDEO_TSX);
    await acceptDirection(projectDir);

    await expect(run(["reroll", "video:timeline.bed"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ANIMATIC_UNCONSUMED"),
    });
  });

  // The spend a patch makes is its own steps'. A shot the definition calls no spender — its picture
  // is a local take — is one a comfy step still spends on.
  it("refuses a patch whose step spends on a shot that draws no board", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_LOCAL_PICTURE_VIDEO_TSX);
    await acceptDirection(projectDir);

    // The local picture is not a vendor spend, so the gate lets this through.
    await run(["generate", "video"], projectDir);
    await run(["job", "wait"], projectDir).catch(() => undefined);
    const sm = await StateManager.load(projectDir);
    const variants = sm.getState().assets["video:shot.01.still"]?.variants ?? {};
    const takeId = Object.entries(variants).find(([, v]) => v.file)?.[0];
    expect(takeId).toBeDefined();

    await run(["patch", "new", takeId!], projectDir);
    await fs.writeFile(
      path.join(projectDir, "patches", `${takeId}.ts`),
      `import { asset, definePatch, defineComfyAsset } from "konte";

const editComfy = defineComfyAsset({
  workflow: "edit.json",
  description: "test adapter",
  inputs: { image: { nodeId: "1", field: "image", type: "image" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default definePatch<"image">(({ source }) => asset("patched", editComfy, { image: source }));
`,
    );

    await expect(run(["patch", "apply"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ANIMATIC_UNCONSUMED"),
    });
  });
});

describe("animatic stem gate", () => {
  it("closes again when the mix goes stale under a re-picked take", async () => {
    const projectDir = await initWithCrossStageStemVideo();
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await acceptDirection(projectDir);

    const keyframe = "animatic:shot.01.keyframe";
    const voice = "animatic:shot.01.voice";
    const stem = "animatic:shot.01#stem";

    // A board settled end to end: both takes accepted, and the mix baked over the voice that is
    // resolving now. The mix is deterministic, so its accept is a human's — konte stamps nothing.
    const sm = await StateManager.load(projectDir);
    const kfId = sm.reserveVariantId(keyframe);
    sm.getAssetState(keyframe).variants![kfId]!.file = "assets/kf.png";
    sm.getAssetState(keyframe).variants![kfId]!.outputHash = "kf-hash";
    const voiceId = sm.reserveVariantId(voice);
    sm.getAssetState(voice).variants![voiceId]!.file = "assets/voice.wav";
    sm.getAssetState(voice).variants![voiceId]!.outputHash = "voice-take-1";
    const stemId = sm.reserveVariantId(stem);
    const stemVariant = sm.getAssetState(stem).variants![stemId]!;
    stemVariant.file = "assets/stem.wav";
    stemVariant.outputHash = "stem-hash";
    stemVariant.inputFingerprints = { [voice]: "voice-take-1" };
    sm.setAccepted(keyframe, kfId);
    sm.setAccepted(voice, voiceId);
    sm.setAccepted(stem, stemId);
    await sm.save();

    const { stdout } = await run(["generate", "video", "--plan"], projectDir);
    expect(planEntries(stdout).map((e) => e.address)).toContain("video:shot.01.motion");

    // The reviewer re-picks the line. The mix still carries its own accept, but it was mixed from
    // the take that lost — spending motion on it would burn the voice nobody chose.
    const sm2 = await StateManager.load(projectDir);
    const voiceId2 = sm2.reserveVariantId(voice);
    sm2.getAssetState(voice).variants![voiceId2]!.file = "assets/voice-2.wav";
    sm2.getAssetState(voice).variants![voiceId2]!.outputHash = "voice-take-2";
    sm2.setAccepted(voice, voiceId2);
    await sm2.save();

    await expect(run(["generate", "video", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ANIMATIC_ACCEPTANCE_REQUIRED"),
    });

    // Re-baking the mix over the chosen take, and re-accepting it, opens the gate again.
    const sm3 = await StateManager.load(projectDir);
    const stemId2 = sm3.reserveVariantId(stem);
    const stem2 = sm3.getAssetState(stem).variants![stemId2]!;
    stem2.file = "assets/stem-2.wav";
    stem2.outputHash = "stem-hash-2";
    stem2.inputFingerprints = { [voice]: "voice-take-2" };
    sm3.setAccepted(stem, stemId2);
    await sm3.save();

    const { stdout: after } = await run(["generate", "video", "--plan"], projectDir);
    expect(planEntries(after).map((e) => e.address)).toContain("video:shot.01.motion");
  });
});

// The same shapes one stage up: a sheet a board conditions on. Comfy, not `local` — a deterministic
// asset is konte's own accept, so it could never hold the gate.
const SHEET_REFERENCE_TS = `import { defineComfyAsset, defineReference, asset } from "konte";
import direction from "./direction";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineReference(direction, () => {
  const plate = asset("plate", imageComfy, { prompt: "a plain studio" });
  return { plate };
});
`;

const SHEET_ANIMATIC_TS = `import { defineComfyAsset, defineAnimatic, asset, Composition, Panel } from "konte";
import direction from "./direction";
import reference from "./reference";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
    image1: { nodeId: "4", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineAnimatic(direction, {
  timeline: ({ shot }) =>
    ({ shots: shot("01", () => <Composition>
<Panel src={asset("keyframe", imageComfy, { prompt: "a cat", image1: reference.plate })} blocking="the cat rises to sit" camera="fixed" />
</Composition>) }),
});
`;

// A video asset that conditions on a sheet directly, not only through the board — the edge the
// design doc's animatic-only wording would have left open.
const SHEET_VIDEO_TSX = `import { Composition, Video, defineComfyAsset, defineVideo, asset } from "konte";
import direction from "./direction";
import reference from "./reference";
import animatic from "./animatic";

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    identity: { nodeId: "2", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, {
        image: animatic.shot("01").image("keyframe"),
        identity: reference.plate,
      });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});
`;

describe("reference acceptance gate", () => {
  it("blocks an animatic spend until every sheet it conditions on is accepted", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "reference.tsx"), SHEET_REFERENCE_TS);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), SHEET_ANIMATIC_TS);
    await acceptDirection(projectDir);

    // Nothing generated on the reference stage yet: the gate names the sheet and points at
    // generating it.
    await expect(run(["generate", "animatic", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("REFERENCE_ACCEPTANCE_REQUIRED"),
    });

    // A generated-but-unreviewed sheet still blocks — the human accept is the gate, not the file.
    const address = "reference:plate";
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = "assets/plate.png";
    await sm.save();
    await expect(run(["generate", "animatic", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("konte preview reference"),
    });

    // reroll is the same spend, so it hits the same gate.
    await expect(run(["reroll", "animatic:shot.01.keyframe"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("REFERENCE_ACCEPTANCE_REQUIRED"),
    });

    // The reference stage itself is where the sheet is made, so it is never held by its own gate.
    const { stdout: refPlan } = await run(["generate", "reference", "--plan"], projectDir);
    expect(planEntries(refPlan).map((e) => e.address)).toContain(address);

    // Accepting the sheet opens the gate.
    const sm2 = await StateManager.load(projectDir);
    sm2.setAccepted(address, variantId);
    await sm2.save();
    const { stdout } = await run(["generate", "animatic", "--plan"], projectDir);
    const addrs = planEntries(stdout).map((e) => e.address);
    expect(addrs).toContain("animatic:shot.01.keyframe");

    // The walk stops at an accepted board: the sheet under it was reviewed as part of it, so
    // un-accepting the sheet must not re-open a video spend that only reaches it through the board.
    const board = "animatic:shot.01.keyframe";
    const sm3 = await StateManager.load(projectDir);
    const boardVariant = sm3.reserveVariantId(board);
    sm3.getAssetState(board).variants![boardVariant]!.file = "assets/kf.png";
    sm3.setAccepted(board, boardVariant);
    sm3.setUnaccepted(address, variantId);
    await sm3.save();
    const { stdout: videoPlan } = await run(["generate", "video", "--plan"], projectDir);
    expect(planEntries(videoPlan).map((e) => e.address)).toContain("video:shot.01.motion");
  });

  it("blocks a video spend on a sheet it consumes directly, past an accepted board", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "reference.tsx"), SHEET_REFERENCE_TS);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), SHEET_ANIMATIC_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), SHEET_VIDEO_TSX);
    await acceptDirection(projectDir);

    // Board and sheet both settled: the video spend has nothing left to wait on.
    const sheet = "reference:plate";
    const board = "animatic:shot.01.keyframe";
    const sm = await StateManager.load(projectDir);
    const acceptedVariants: Record<string, string> = {};
    for (const [address, file] of [
      [sheet, "assets/plate.png"],
      [board, "assets/kf.png"],
    ] as const) {
      const variantId = sm.reserveVariantId(address);
      sm.getAssetState(address).variants![variantId]!.file = file;
      sm.setAccepted(address, variantId);
      acceptedVariants[address] = variantId;
    }
    await sm.save();
    const { stdout } = await run(["generate", "video", "--plan"], projectDir);
    expect(planEntries(stdout).map((e) => e.address)).toContain("video:shot.01.motion");

    // Drop the sheet's accept. The board above it stays accepted, so the walk would stop there —
    // but this video asset conditions on the sheet itself, and that edge is gated on its own.
    const sm2 = await StateManager.load(projectDir);
    sm2.setUnaccepted(sheet, acceptedVariants[sheet]!);
    await sm2.save();
    await expect(run(["generate", "video", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("REFERENCE_ACCEPTANCE_REQUIRED"),
    });
  });
});

// Two shots, each with its own board, and a video-to-video chain on shot 01
// (keyframe → motion → refined) — the shapes the gate has to get right: per-shot isolation and a
// animatic ancestor reached through another video asset. All `local` adapters, so no backend.
const TWO_SHOT_DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
    detail: { name: "the detail", description: "in close on the hands", location: "studio", framing: "close", holds: ["studioMark"], within: null },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "ordinary", action: "shot one", setup: "front", duration: 3 , lineup: [] },
      { id: "02", role: "hero", action: "shot two", setup: "detail", duration: 3 , lineup: [] },
    ],
    waivers: {
      "location-unreferenced_studio": "fixture has no reference stage exposing it",
      "setup-unconsumed_front": "fixture board is anchored on nothing",
      "setup-unconsumed_detail": "fixture board is anchored on nothing",
      "missing-beat_disruption": "two-shot fixture",
      "missing-beat_pressure": "two-shot fixture",
      "beat-overweight_ordinary": "two-shot fixture",
    },
  },
});
`;

const TWO_SHOT_ANIMATIC_TS = `import { defineAnimatic, asset, Composition, Panel } from "konte";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";
import direction from "./direction";

export default defineAnimatic(direction, {
  timeline: ({ shot }) =>
    ({ shots: shot("01", () => {
      const kf = asset("keyframe", internalTestImage, { width: 64, height: 64 });
      return <Composition>
<Panel src={kf} blocking="the subject rises" camera="fixed" />
</Composition>;
    }).nextShot("02", () => {
      const kf = asset("keyframe", internalTestImage, { width: 48, height: 48 });
      return <Composition>
<Panel src={kf} blocking="the subject turns" camera="fixed" />
</Composition>;
    }) }),
});
`;

const TWO_SHOT_VIDEO_TSX = `import { defineVideo, Composition, Video, asset } from "konte";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";
import direction from "./direction";
import animatic from "./animatic";

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", internalTestImage, {
        image: animatic.shot("01").image("keyframe"),
        width: 48,
        height: 48,
      });
      const refined = asset("refined", internalTestImage, { image: motion, width: 32, height: 32 });
      return <Composition><Video src={refined} /></Composition>;
    }).nextShot("02", () => {
      const motion = asset("motion", internalTestImage, {
        image: animatic.shot("02").image("keyframe"),
        width: 48,
        height: 48,
      });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});
`;

describe("animatic acceptance gate (multi-shot)", () => {
  async function initTwoShotProject(name: string): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, name));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "direction.ts"), TWO_SHOT_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TWO_SHOT_ANIMATIC_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TWO_SHOT_VIDEO_TSX);
    await fs.writeFile(path.join(projectDir, "reference.tsx"), EMPTY_REFERENCE_TSX);
    await acceptDirection(projectDir);
    return projectDir;
  }

  // Give `address` a variant with an output, accepted or not. `size` ("96x64") writes a real image
  // there, for the paths that read the take's own pixels; without it the file is a bare state entry.
  async function seedVariant(
    projectDir: string,
    address: string,
    opts: { accept: boolean; size?: string; ext?: string },
  ): Promise<string> {
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);
    const file = `assets/${variantId}.${opts.ext ?? "png"}`;
    sm.getAssetState(address).variants![variantId]!.file = file;
    if (opts.accept) sm.setAccepted(address, variantId);
    await sm.save();
    if (opts.size) {
      const absFile = path.join(projectDir, file);
      await fs.mkdir(path.dirname(absFile), { recursive: true });
      // A take that landed through the pipeline carries what one ffprobe measured (`waitForJob`), so
      // a seeded one does too. Left off when konte cannot type the file — no record, as in reality.
      const [width = 0, height = 0] = opts.size.split("x").map(Number);
      if (!opts.ext) {
        const sm2 = await StateManager.load(projectDir);
        sm2.getAssetState(address).variants![variantId]!.media = { kind: "image", width, height };
        await sm2.save();
      }
      await execFileAsync(await ffmpegBin(), [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=red:s=${opts.size}`,
        "-frames:v",
        "1",
        "-c:v",
        "png",
        "-f",
        "image2",
        absFile,
      ]);
    }
    return variantId;
  }

  it("blocks a reroll whose board is reached through another video asset", async () => {
    const projectDir = await initTwoShotProject("chainproj");
    // `refined` depends on `motion`, which depends on the board — a direct-dependency-only gate
    // would wave this through.
    await expect(run(["reroll", "video:shot.01.refined"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("animatic:shot.01.keyframe"),
    });
  });

  it("lets a shot with an accepted board through while another shot's board is in review", async () => {
    const projectDir = await initTwoShotProject("isolationproj");
    // Shot 01 is finished work the run would skip anyway; its board has since gone back to
    // unaccepted. Shot 02's board is signed off and its motion is still to make.
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: false });
    await seedVariant(projectDir, "video:shot.01.motion", { accept: true });
    await seedVariant(projectDir, "video:shot.01.refined", { accept: true });
    await seedVariant(projectDir, "animatic:shot.02.keyframe", { accept: true });

    const { stdout } = await run(["generate", "video", "--plan"], projectDir);
    const submitted = planEntries(stdout)
      .filter((e) => e.action !== "skip")
      .map((e) => e.address);
    expect(submitted).toContain("video:shot.02.motion");
    expect(submitted).not.toContain("video:shot.01.motion");
  });

  // A take whose deps are already generated goes through the pending-job path — the watcher
  // submits it the moment the job file lands. That is under way, so the run must report it the
  // same as one it submitted itself; the old wording flipped between the two per stage topology.
  it("counts a take with met deps as started and only an unmet-dep take as waiting", async () => {
    const projectDir = await initTwoShotProject("summaryproj");
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: true });
    await seedVariant(projectDir, "animatic:shot.02.keyframe", { accept: true });

    // The plan answers the same question ahead of the spend, so it must classify the same graph
    // the same way — the two drifted apart when the plan asked "has deps?" instead of "has an
    // unmet dep?". Run it first: the real run below fills state with jobs of its own.
    const { stdout: planOut } = await run(["generate", "video", "--plan"], projectDir);
    expect(planOut).toContain("Plan: 2 to start, 1 waiting");

    const { stdout } = await run(["generate", "video"], projectDir);
    // Both motions have their board; `refined` waits on shot 01's motion, made by this run.
    expect(stdout).toContain("2 started, 1 waiting, 0 synced, 0 failed");
    expect(stdout).toMatch(/^Waiting on:\n {2}video:shot\.01\.refined /m);
  });

  it("names what each waiting take is blocked on in the text output", async () => {
    const projectDir = await initTwoShotProject("waitingproj");
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: true });
    await seedVariant(projectDir, "animatic:shot.02.keyframe", { accept: true });

    const { stdout } = await run(["generate", "video"], projectDir);
    expect(stdout).toContain("Waiting on:");
    expect(stdout).toContain("video:shot.01.refined  video:shot.01.motion");
    // The outcome and the step share the LAST line: a caller piping through `tail -1` keeps both.
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "2 started, 1 waiting, 0 synced, 0 failed, 0 skipped — run `konte job wait`",
    );
  });

  it("blocks a patch that pulls in an unaccepted board of its own", async () => {
    const projectDir = await initTwoShotProject("patchrefproj");
    // Shot 01 — the take being patched — is fully signed off, so only the board the patch script
    // itself reaches for can block. A patch's refs carry no graph node, hence the separate path.
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: true });
    await seedVariant(projectDir, "animatic:shot.02.keyframe", { accept: false });
    const sourceId = await seedVariant(projectDir, "video:shot.01.motion", { accept: true });

    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.mkdir(path.join(projectDir, "patches"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "patches", `${sourceId}.ts`),
      `import { asset, definePatch, defineComfyAsset } from "konte";
import animatic from "../animatic";

const blend = defineComfyAsset({
  workflow: "blend.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    ref: { nodeId: "2", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default definePatch<"image">(({ source }) =>
  asset("patched", blend, { image: source, ref: animatic.shot("02").image("keyframe") }),
);
`,
    );

    await expect(run(["patch", "apply", sourceId], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("animatic:shot.02.keyframe"),
    });
  });

  // Applies a comfy patch whose every format-derived input is left to the build format, and returns
  // the step definition it snapshotted. A declared, uninstallable model keeps the step on the
  // pending path, so the definition is built and snapshotted without any ComfyUI round-trip.
  async function applyFormatPatch(projectDir: string, sourceId: string) {
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await fs.mkdir(path.join(projectDir, "patches"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "patches", `${sourceId}.ts`),
      `import { asset, definePatch, defineComfyAsset } from "konte";

const edit = defineComfyAsset({
  workflow: "edit.json",
  description: "test adapter",
  models: [{ filename: "m.safetensors", type: "checkpoint", url: "https://example.invalid/m" }],
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    width: { nodeId: "2", field: "width", type: "width", default: 64 },
    height: { nodeId: "2", field: "height", type: "height", default: 64 },
    fps: { nodeId: "3", field: "fps", type: "fps", default: 1 },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default definePatch<"video">(({ source }) => asset("patched", edit, { image: source }));
`,
    );

    // The step's variant (and its definition snapshot) is reserved before the backend is reached,
    // so this asserts on the built definition whether or not the submit itself gets anywhere —
    // there is no ComfyUI here to submit to.
    const { stdout } = await run(["patch", "apply", sourceId], projectDir).catch(
      (e: { stdout: string }) => e,
    );
    const [, address, variantId] = stdout.match(/^ {2}(\S+): \S+ → (\S+) \(patch of /m)!;
    return readDefinitionSnapshot(projectDir, address!, variantId!);
  }

  // A patch replaces the take at its source's address, so a correction that comes back at other
  // dimensions is a replacement rather than a fix. The canvas is only a proxy for the take's size —
  // and one that breaks on a reference take, whose stage builds with no format at all.
  it("sizes a comfy step from the take it corrects", async () => {
    const projectDir = await initTwoShotProject("patchsizeproj");
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: true });
    const sourceId = await seedVariant(projectDir, "video:shot.01.motion", {
      accept: true,
      size: "96x64",
    });

    // fps stays the direction's: unlike pixel size it is the timeline's normative value.
    expect(await applyFormatPatch(projectDir, sourceId)).toMatchObject({
      inputs: { "2.width": 96, "2.height": 64, "3.fps": 30 },
    });
  });

  // A take konte cannot even type by extension carries no record — the same case as a take it could
  // not measure — so the correction is sized from the direction's canvas, never from a live probe.
  it("sizes a comfy step from the canvas when the take carries no media record", async () => {
    const projectDir = await initTwoShotProject("patchsizerawproj");
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: true });
    const sourceId = await seedVariant(projectDir, "video:shot.01.motion", {
      accept: true,
      size: "96x64",
      ext: "dat",
    });

    expect(await applyFormatPatch(projectDir, sourceId)).toMatchObject({
      inputs: { "2.width": 1024, "2.height": 576 },
    });
  });

  // A patch build runs outside any stage discovery, so without a format of its own a comfy step's
  // width/height/fps fall back to the adapter's static defaults — which is how a portrait project
  // got landscape corrections. An unprobeable take (audio, a missing file) falls back to the
  // direction canvas, the same one a stage asset resolves against.
  it("falls back to the direction canvas for a take it cannot probe", async () => {
    const projectDir = await initTwoShotProject("patchformatproj");
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: true });
    const sourceId = await seedVariant(projectDir, "video:shot.01.motion", { accept: true });

    expect(await applyFormatPatch(projectDir, sourceId)).toMatchObject({
      inputs: { "2.width": 1024, "2.height": 576, "3.fps": 30 },
    });
  });

  it("still blocks the shot whose board is unaccepted once it has work to do", async () => {
    const projectDir = await initTwoShotProject("blockedproj");
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: false });
    await seedVariant(projectDir, "animatic:shot.02.keyframe", { accept: true });

    // Shot 01's motion is ungenerated now, so the run would spend on it — the gate must refuse.
    await expect(run(["generate", "video", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("animatic:shot.01.keyframe"),
    });
  });
});

// The prompt gate's twin over wiring: a pinned image that the picture never shows.
describe("pin gate", () => {
  // The realistic fixture pins both ends to the board it develops. Re-pointing the first frame at a
  // character sheet is the mistake the gate exists for.
  // The board the video develops, accepted for it — leaving the pin gate the only thing these
  // tests can trip over.
  async function acceptBoard(projectDir: string): Promise<void> {
    const sm = await StateManager.load(projectDir);
    for (const id of ["01", "02", "03"]) {
      for (const name of ["first", "last"]) {
        const panel = `animatic:shot.${id}.${name}`;
        const variantId = sm.reserveVariantId(panel);
        sm.getAssetState(panel).variants![variantId]!.file = "/tmp/panel.png";
        sm.setAccepted(panel, variantId);
      }
    }
    await sm.save();
  }

  async function project(videoTsx: (source: string) => string): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, `pingate-${Math.random()}`));
    const file = path.join(inited.video, "video.tsx");
    await fs.writeFile(file, videoTsx(await fs.readFile(file, "utf8")));
    await acceptDirection(inited.video);
    await acceptFileAssets(inited.video);
    await acceptBoard(inited.video);
    return inited.video;
  }

  const pinSheet = (source: string) =>
    source.replace(
      'startImage: animatic.shot(id).image("first"),',
      "startImage: reference.character,",
    );

  it("refuses a spend that pins a reference sheet", async () => {
    const projectDir = await project(pinSheet);
    await expect(run(["generate", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(/PIN_CHECK_FAILED[\s\S]*reference:character/),
    });
  });

  it("reports the finding and its key in status, and holds back the generate step", async () => {
    const projectDir = await project(pinSheet);
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("Pin findings: 1");
    expect(stdout).toMatch(/^ {2}\[pin-unanchored:[0-9a-f]{8}\] \(video\.tsx\) /m);
    expect(stdout).toContain("reference:character");
    expect(stdout).toContain("video:shot.01.motion.startImage");
    expect(stdout).not.toContain("konte generate video");
  });

  it("lets the spend through once the stage waives the source", async () => {
    const withFinding = await project(pinSheet);
    const { stdout } = await run(["status"], withFinding);
    const key = stdout.match(/\[(pin-unanchored:[0-9a-f]{8})\]/)![1]!;

    const projectDir = await project((source) =>
      pinSheet(source).replace(
        "export default defineVideo(direction, {",
        `export default defineVideo(direction, {\n  waivers: { "${key}": "the shot opens on the sheet by design" },`,
      ),
    );
    const { stdout: statusOut } = await run(["status"], projectDir);
    expect(statusOut).not.toContain("Pin findings:");
  });

  it("leaves the fixture's own board pins alone", async () => {
    const projectDir = await project((source) => source);
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain("Pin findings:");
  });
});

// The prompt gate stands beside the direction gate at every spend.
describe("prompt gate", () => {
  // The shot spends, so it has to build on the board it develops — `project()` accepts that panel
  // for it, leaving the prompt gate the only thing these tests can trip over.
  const onBoard = (video: string) =>
    video
      .replace(`import { Composition, Video, Audio,`, `import { Composition, Image, Video, Audio,`)
      .replace(`} from "konte";`, `} from "konte";\nimport animatic from "./animatic";`)
      .replace(
        `<Audio src={voice} /></Composition>`,
        `<Audio src={voice} /><Image src={animatic.shot("01").image("first")} /></Composition>`,
      );

  const NEGATED_VIDEO_TSX = onBoard(TEST_VIDEO_TSX)
    .replace(
      `inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },`,
      `inputs: { prompt: { nodeId: "3", field: "text", type: "prompt" } },`,
    )
    .replace(`{ prompt: "test" }`, `{ prompt: "a lit desk, no outlines" }`);

  async function project(video: string): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, `promptgate-${Math.random()}`));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "video.tsx"), video);
    await writeWorkspaceConfig(projectDir, {
      comfyui: { url: "http://127.0.0.1:8188", autoInstallModels: false, autoInstallNodes: false },
    });
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);

    const sm = await StateManager.load(projectDir);
    const panel = "animatic:shot.01.first";
    const variantId = sm.reserveVariantId(panel);
    sm.getAssetState(panel).variants![variantId]!.file = "/tmp/panel.png";
    sm.setAccepted(panel, variantId);
    await sm.save();
    return projectDir;
  }

  it("refuses a spend on a prompt that names what to leave out", async () => {
    const projectDir = await project(NEGATED_VIDEO_TSX);
    await expect(run(["generate", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(/PROMPT_CHECK_FAILED[\s\S]*no outlines/),
    });
  });

  it("reports the finding and its key in status, and holds back the generate step", async () => {
    const projectDir = await project(NEGATED_VIDEO_TSX);
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("Prompt findings: 1");
    expect(stdout).toMatch(/^ {2}\[prompt-negation:[0-9a-f]{8}\] \(video\.tsx\) .*no outlines/m);
    expect(stdout).not.toContain("konte generate video");
  });

  it("lets the spend through once the stage waives the phrase", async () => {
    const withFinding = await project(NEGATED_VIDEO_TSX);
    const { stdout } = await run(["status"], withFinding);
    const key = stdout.match(/\[(prompt-negation:[0-9a-f]{8})\]/)![1]!;

    const projectDir = await project(
      NEGATED_VIDEO_TSX.replace(
        `defineVideo(direction, {`,
        `defineVideo(direction, {\n  waivers: { "${key}": "the model's own style vocabulary" },`,
      ),
    );
    const { stdout: planOut } = await run(["generate", "video", "--plan"], projectDir);
    expect(planOut).toContain("Plan:");
  });

  it("holds back the spend on a waiver key that can never cancel anything", async () => {
    const projectDir = await project(
      TEST_VIDEO_TSX.replace(
        `defineVideo(direction, {`,
        `defineVideo(direction, {\n  waivers: { "prompt-negation": "no hash" },`,
      ),
    );
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("Stale prompt waivers: 1");
    expect(stdout).toContain("[prompt-negation] (video.tsx) unknown key");
    expect(stdout).not.toContain("konte generate video");

    await expect(run(["generate", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("PROMPT_CHECK_FAILED"),
    });
  });
});
