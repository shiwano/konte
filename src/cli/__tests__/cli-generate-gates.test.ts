import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readDefinitionSnapshot } from "../../core/definition-snapshot.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import { getAssetEntry } from "../../core/address.js";
import {
  ffmpegBin,
  SINGLE_FRAME_INPUT_ARGS,
  SINGLE_FRAME_OUTPUT_ARGS,
} from "../../core/ffmpeg-binary.js";
import { StateManager } from "../../core/state/manager.js";
import { loadStageDefinitions } from "../../core/stage-definitions.js";
import {
  ctx,
  useTempWorkspace,
  writeWorkspaceConfig,
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
import { planEntries } from "./generate-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

const execFileAsync = promisify(execFile);

useTempWorkspace();

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
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await acceptDirection(projectDir);

    // Nothing generated on the animatic yet: the gate names the board and points at generating.
    await expect(run(["generate", "video", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("SPEND_HELD"),
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
      stderr: expect.stringContaining("SPEND_HELD"),
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
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_UNCONSUMED_ANIMATIC_VIDEO_TSX);
    await acceptDirection(projectDir);

    await expect(run(["generate", "video", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("animatic-unconsumed"),
    });

    // reroll and export spend on the same wiring, so both refuse it too.
    await expect(run(["reroll", "video:shot.01.motion"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("animatic-unconsumed"),
    });
    await expect(run(["export", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("animatic-unconsumed"),
    });
  });

  // A timeline asset belongs to no one shot, so a reroll of it names no shot to scope by — and the
  // scoped form would skip the gate entirely.
  it("refuses a reroll of a timeline asset the boardless shot draws", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_TIMELINE_SPEND_VIDEO_TSX);
    await acceptDirection(projectDir);

    await expect(run(["reroll", "video:timeline.bed"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("animatic-unconsumed"),
    });
  });

  // The spend a patch makes is its own steps'. A shot the definition calls no spender — its picture
  // is a local take — is one a comfy step still spends on.
  it("refuses a patch whose step spends on a shot that draws no board", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_LOCAL_PICTURE_VIDEO_TSX);
    await acceptDirection(projectDir);

    // The local picture is not a vendor spend, so the gate lets this through.
    await run(["generate", "video"], projectDir);
    await run(["job", "run"], projectDir).catch(() => undefined);
    const sm = await StateManager.load(projectDir);
    const variants = sm.getState().assets["video:shot.01.still"]?.variants ?? {};
    const variantId = Object.entries(variants).find(([, v]) => v.file)?.[0];
    expect(variantId).toBeDefined();

    await run(["patch", "new", variantId!], projectDir);
    await fs.writeFile(
      path.join(projectDir, "patches", `${variantId}.ts`),
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
      stderr: expect.stringContaining("animatic-unconsumed"),
    });
  });

  it("refuses a patch whose step spends on a timeline asset a boardless shot draws", async () => {
    const projectDir = await initWithCrossStageVideo();
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_LOCAL_PICTURE_VIDEO_TSX.replace(
        '  timeline: ({ shot }) => ({\n    shots: shot("01", () => {\n      const still = asset("still", internalTestImage, { width: 64, height: 64 });\n      return <Composition><Image src={still} /></Composition>;\n    }),\n  }),',
        '  timeline: ({ shot }) => {\n    const still = asset("still", internalTestImage, { width: 64, height: 64 });\n    return { shots: shot("01", () => <Composition><Image src={still} /></Composition>) };\n  },',
      ),
    );
    await acceptDirection(projectDir);

    // The local picture is not a vendor spend, so the gate lets this through.
    await run(["generate", "video"], projectDir);
    await run(["job", "run"], projectDir).catch(() => undefined);
    const sm = await StateManager.load(projectDir);
    const variants = sm.getState().assets["video:timeline.still"]?.variants ?? {};
    const variantId = Object.entries(variants).find(([, v]) => v.file)?.[0];
    expect(variantId).toBeDefined();

    await run(["patch", "new", variantId!], projectDir);
    await fs.writeFile(
      path.join(projectDir, "patches", `${variantId}.ts`),
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
      stderr: expect.stringContaining("animatic-unconsumed"),
    });
  });
});

describe("animatic stem gate", () => {
  it("closes again when the mix goes stale under a re-picked take", async () => {
    const projectDir = await initWithCrossStageStemVideo();
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
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
      stderr: expect.stringContaining("SPEND_HELD"),
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

  it("points an unmaterialized stem at its accept, not at a generate that has no job for it", async () => {
    const projectDir = await initWithCrossStageStemVideo();
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await acceptDirection(projectDir);

    const keyframe = "animatic:shot.01.keyframe";
    const voice = "animatic:shot.01.voice";
    const sm = await StateManager.load(projectDir);
    const kfId = sm.reserveVariantId(keyframe);
    sm.getAssetState(keyframe).variants![kfId]!.file = "assets/kf.png";
    sm.getAssetState(keyframe).variants![kfId]!.outputHash = "kf-hash";
    const voiceId = sm.reserveVariantId(voice);
    sm.getAssetState(voice).variants![voiceId]!.file = "assets/voice.wav";
    sm.getAssetState(voice).variants![voiceId]!.outputHash = "voice-take-1";
    sm.setAccepted(keyframe, kfId);
    sm.setAccepted(voice, voiceId);
    await sm.save();

    const err = await run(["generate", "video", "--plan"], projectDir).catch((e) => e);
    expect(err.stderr).toContain("SPEND_HELD");
    expect(err.stderr).toContain("run `konte accept animatic:shot.01#stem`");
    expect(err.stderr).not.toContain("konte generate animatic");
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

export default defineReference(direction, { references: () => {
  const plate = asset("plate", imageComfy, { prompt: "a plain studio" });
  return { plate };
} });
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
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "reference.tsx"), SHEET_REFERENCE_TS);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), SHEET_ANIMATIC_TS);
    await acceptDirection(projectDir);

    // Nothing generated on the reference stage yet: the gate names the sheet and points at
    // generating it.
    await expect(run(["generate", "animatic", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("SPEND_HELD"),
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
      stderr: expect.stringContaining("SPEND_HELD"),
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
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
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
      stderr: expect.stringContaining("SPEND_HELD"),
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
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } }, views: { front: { holds: ["studioMark"] } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", view: "front", holds: ["studioMark"] },
    detail: { name: "the detail", description: "in close on the hands", location: "studio", framing: "close", view: "front", holds: ["studioMark"], within: null },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en" },
  waivers: {
    "location-unreferenced_studio": "fixture has no reference stage exposing it",
    "setup-unconsumed_front": "fixture board is anchored on nothing",
    "setup-unconsumed_detail": "fixture board is anchored on nothing",
    "missing-role_disruption": "two-shot fixture",
    "missing-role_pressure": "two-shot fixture",
    "role-overweight_ordinary": "two-shot fixture",
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "ordinary", action: "shot one", setup: "front", duration: 3 , lineup: [] },
      { id: "02", role: "hero", action: "shot two", setup: "detail", duration: 3 , lineup: [] },
    ],
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
        ...SINGLE_FRAME_INPUT_ARGS,
        "-f",
        "lavfi",
        "-i",
        `color=c=red:s=${opts.size}`,
        "-frames:v",
        "1",
        ...SINGLE_FRAME_OUTPUT_ARGS,
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
      "2 started, 1 waiting, 0 synced, 0 failed, 0 skipped — run `konte job run`",
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
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
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
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
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

  it("holds the shot whose board is unaccepted and spends on the rest", async () => {
    const projectDir = await initTwoShotProject("blockedproj");
    await seedVariant(projectDir, "animatic:shot.01.keyframe", { accept: false });
    await seedVariant(projectDir, "animatic:shot.02.keyframe", { accept: true });

    // The run would spend on shot 02, so status still offers it.
    const { stdout: statusOut } = await run(["status"], projectDir);
    expect(statusOut).toContain("konte generate video");

    // Shot 01's motion and the take built on it reach the unaccepted board; shot 02's does not.
    const { stdout: planOut } = await run(["generate", "video", "--plan"], projectDir);
    const planned = planEntries(planOut).map((e) => e.address);
    expect(planned).toContain("video:shot.02.motion");
    expect(planned).not.toContain("video:shot.01.motion");
    expect(planned).not.toContain("video:shot.01.refined");
    expect(planOut).toContain(
      "Held: 2 asset(s) build on upstream work not yet accepted — accept it, then run `konte generate video` again:\n" +
        "  animatic:shot.01.keyframe — review and accept it in `konte preview animatic`",
    );

    const { stdout } = await run(["generate", "video"], projectDir);
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "1 started, 0 waiting, 0 synced, 0 failed, 0 skipped, 2 held — run `konte job run`",
    );

    // A named reroll asked for the held shot, so it refuses.
    await expect(run(["reroll", "video:shot.01.motion"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("SPEND_HELD"),
    });
  });

  it("holds the shot whose board has a take undecided beside its accept", async () => {
    const projectDir = await initTwoShotProject("undecidedboardproj");
    const acceptedId = await seedVariant(projectDir, "animatic:shot.01.keyframe", {
      accept: true,
    });
    const undecidedId = await seedVariant(projectDir, "animatic:shot.01.keyframe", {
      accept: false,
    });
    await seedVariant(projectDir, "animatic:shot.02.keyframe", { accept: true });

    const { stdout: planOut } = await run(["generate", "video", "--plan"], projectDir);
    const planned = planEntries(planOut).map((e) => e.address);
    expect(planned).toContain("video:shot.02.motion");
    expect(planned).not.toContain("video:shot.01.motion");
    expect(planOut).toContain(
      `  animatic:shot.01.keyframe — ${undecidedId} is undecided beside accepted ${acceptedId} — ` +
        "review it in `konte preview animatic`",
    );

    await expect(run(["reroll", "video:shot.01.motion"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("SPEND_HELD"),
    });

    // Redone as several takes, the board has no one take to pin the motion to.
    await expect(
      run(
        ["reroll", "animatic:shot.01.keyframe", "video:shot.01.motion", "--count", "2"],
        projectDir,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("SPEND_HELD"),
    });

    // Redone in the same run, the board's fresh take is what the motion builds on.
    const { stdout } = await run(
      ["reroll", "animatic:shot.01.keyframe", "video:shot.01.motion"],
      projectDir,
    ).catch((e: { stdout: string }) => e);
    expect(stdout).not.toContain("SPEND_HELD");
    expect(stdout).toMatch(/video:shot\.01\.motion: \S+ → v-/);
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
      stderr: expect.stringMatching(
        /SPEND_HELD[\s\S]*pin-unanchored — [\s\S]*reference:character — a reference sheet/,
      ),
    });
  });

  it("reports the finding under its file in status, and holds back the generate step", async () => {
    const projectDir = await project(pinSheet);
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toMatch(
      /^Findings: 1\n {2}video\.tsx\n {4}pin-unanchored — .*\n {6}reference:character — a reference sheet, pinned at /m,
    );
    expect(stdout).toContain("reference:character");
    expect(stdout).toContain("video:shot.01.motion.startImage");
    expect(stdout).not.toContain("konte generate video");
  });

  it("leaves the fixture's own board pins alone", async () => {
    const projectDir = await project((source) => source);
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain("pin-unanchored");
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
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
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

  it("holds the asset whose prompt names what to leave out, and plans the rest", async () => {
    const projectDir = await project(NEGATED_VIDEO_TSX);
    const { stdout } = await run(["generate", "video", "--plan"], projectDir);
    expect(stdout).toMatch(/Held: 1 asset\(s\)/);
    expect(stdout).toMatch(/\[prompt-negation\] "no outlines" — video:shot\.01\.motion/);
  });

  it("puts a reroll's refusal, its findings included, on one line", async () => {
    const projectDir = await project(NEGATED_VIDEO_TSX);
    const err: { stderr: string } = await run(["reroll", "video:shot.01.motion"], projectDir).then(
      () => expect.fail("reroll should refuse"),
      (e) => e,
    );
    expect(err.stderr.trimEnd().split("\n").at(-1)).toMatch(
      /^Error \[SPEND_HELD\]: Cannot reroll video — it is held: .*: video\.tsx: prompt-negation — describe what occupies the space .*; "no outlines" — video:shot\.01\.motion;/,
    );
  });

  it("reports the finding under its file in status", async () => {
    const projectDir = await project(NEGATED_VIDEO_TSX);
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toMatch(
      /^Findings: 1\n {2}video\.tsx\n {4}prompt-negation — .*\n {6}"no outlines" — video:shot\.01\.motion$/m,
    );
  });

  describe("on an address whose accepted take was drawn from the prompt", () => {
    async function accepted(): Promise<string> {
      const projectDir = await project(NEGATED_VIDEO_TSX);
      const { video } = await loadStageDefinitions(projectDir);
      const address = "video:shot.01.motion";
      const sm = await StateManager.load(projectDir);
      const variantId = sm.reserveVariantId(address);
      const variant = sm.getAssetState(address).variants![variantId]!;
      variant.file = "/tmp/motion.mp4";
      variant.definitionHash = computeDefinitionHash(getAssetEntry(video!, address));
      sm.setAccepted(address, variantId);
      await sm.save();
      return projectDir;
    }

    it("reports no finding in status", async () => {
      const { stdout } = await run(["status"], await accepted());
      expect(stdout).not.toContain("prompt-negation");
    });

    it("still refuses a reroll of it", async () => {
      await expect(run(["reroll", "video:shot.01.motion"], await accepted())).rejects.toMatchObject(
        {
          stderr: expect.stringMatching(
            /SPEND_HELD[\s\S]*\[prompt-negation\] "no outlines" — video:shot\.01\.motion — accepted as drawn/,
          ),
        },
      );
    });
  });
});

// A shot replaced by one still undeveloped: what is built on it waits, the rest of the stage spends
// — so a reference is never pointed at some other shot to get past a refusal.
describe("a reference into a pendingShot", () => {
  async function project(): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, `pendingref-${Math.random()}`));
    const projectDir = inited.video;
    const file = path.join(projectDir, "animatic.tsx");
    const source = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      source
        .replace("timeline: ({ format, shot }) => {", "timeline: ({ format, pendingShot }) => {")
        .replace(
          "const shotFn = (id: string, first: string, next: string) => () => {",
          "const shotFn = (id: string, first: string, next: string, from?: () => unknown) => () => {",
        )
        .replace("image1: latent,", "image1: (from?.() ?? latent) as typeof latent,")
        .replace(
          /shots: shot\("01", shotFn\("01", ("[^"]*"), ("[^"]*")\)\)\n\s*\.nextShot\("02", shotFn\("02", ("[^"]*"), ("[^"]*")\)\)/,
          'shots: pendingShot("01")\n        .nextShot("02", ({ shot }) => shotFn("02", $3, $4, () => shot("01").image("first"))())',
        ),
    );
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);
    return projectDir;
  }

  it("holds what is built on the pending shot and plans the rest", async () => {
    const projectDir = await project();
    const { stdout } = await run(["generate", "animatic", "--plan"], projectDir);
    expect(stdout).toMatch(/Held: 2 asset\(s\)/);
    expect(stdout).toContain("[pending-reference] animatic:shot.02.first");
    expect(stdout).toContain("animatic:shot.03.first");
  });

  it("reports it under the file writing the reference", async () => {
    const projectDir = await project();
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toMatch(
      /^ {2}animatic\.tsx\n(?: {4}.*\n)* {4}pending-reference — .*\n {6}animatic:shot\.02\.first — built on animatic:shot\.01\.first/m,
    );
  });

  it("refuses a reroll of what it holds", async () => {
    const projectDir = await project();
    await expect(run(["reroll", "animatic:shot.02.first"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /SPEND_HELD[\s\S]*\[pending-reference\] animatic:shot\.02\.first/,
      ),
    });
  });
});
