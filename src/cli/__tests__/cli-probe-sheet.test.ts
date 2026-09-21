import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ensureFfmpeg } from "../../core/ffmpeg.js";
import { ffmpegBin } from "../../core/ffmpeg-binary.js";
import { StateManager } from "../../core/state/index.js";
import {
  ctx,
  useTempWorkspace,
  run,
  initWorkspace,
  initWithCrossStageStemVideo,
  acceptDirection,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("probe contact-sheet --needs-review", () => {
  const REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const studio = asset("studio", internalTestPlate, { width: 64, height: 64, color: "#eee" });
  const plateA = asset("plateA", internalTestPlate, { width: 64, height: 64, color: "#f00" });
  const clipSrc = asset("clipSrc", adapters.videoFile, { path: "assets/files/clip.mp4" });
  const clip = asset("clip", adapters.videoTrim, { source: clipSrc, start: 0, duration: 1 });
  const sfxSrc = asset("sfxSrc", adapters.audioFile, { path: "assets/files/sfx.wav" });
  const sfx = asset("sfx", adapters.audioTrim, { source: sfxSrc, start: 0, duration: 0.5 });
  return { character, studio, plateA, clipSrc, clip, sfxSrc, sfx };
});
`;

  const VIDEO_TSX = `import { Composition, defineVideo, defineDirection } from "konte";

const direction = defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
  },
  policy: {
    format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
    lang: "en",
    speech: "free",
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ id: "01", role: "ordinary", action: "test shot", setup: "front", duration: 2 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "reference stage exposes no studio plate" },
  },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => (<Composition><div /></Composition>)),
  }),
});
`;

  // A real clip, so the take path samples frames from a file ffprobe can measure.
  async function writeClip(projectDir: string): Promise<void> {
    await ensureFfmpeg();
    const ffmpeg = await ffmpegBin();
    const out = path.join(projectDir, "assets", "files", "clip.mp4");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await promisify(execFile)(ffmpeg, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:d=2:r=12",
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    await promisify(execFile)(ffmpeg, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      path.join(projectDir, "assets", "files", "sfx.wav"),
    ]);
  }

  async function initAndGenerate(): Promise<string> {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "needsreview"));
    await writeClip(projectDir);
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), VIDEO_TSX);
    await acceptDirection(projectDir);
    await run(["generate", "reference"], projectDir);
    await run(["job", "wait"], projectDir).catch(() => undefined);
    // Sign everything off here: each test below starts from "nothing outstanding" and controls what
    // it puts back.
    for (const name of ["character", "studio", "plateA", "clipSrc", "clip", "sfxSrc", "sfx"]) {
      await acceptAddress(projectDir, `reference:${name}`);
    }
    return projectDir;
  }

  async function acceptAddress(projectDir: string, address: string): Promise<void> {
    const statePath = path.join(projectDir, "konte.state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf-8"));
    for (const variant of Object.values(
      state.assets[address].variants as Record<string, Record<string, unknown>>,
    )) {
      variant.status = "accepted";
      variant.decidedAt = new Date().toISOString();
    }
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  // Put a take back to unjudged — the state a vendor generate leaves behind.
  async function unaccept(projectDir: string, ...addresses: string[]): Promise<void> {
    const statePath = path.join(projectDir, "konte.state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf-8"));
    for (const address of addresses) {
      for (const variant of Object.values(
        state.assets[address].variants as Record<string, Record<string, unknown>>,
      )) {
        variant.status = "none";
        variant.decidedAt = null;
      }
    }
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  it("reports nothing outstanding when every landed take is accepted", async () => {
    const projectDir = await initAndGenerate();
    await expect(
      run(["probe", "contact-sheet", "--needs-review", "reference"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VARIANT_NOT_FOUND") });
  });

  it("tiles a still take onto one sheet", async () => {
    const projectDir = await initAndGenerate();
    await unaccept(projectDir, "reference:plateA");

    const { stdout, stderr } = await run(
      ["probe", "contact-sheet", "--needs-review", "reference"],
      projectDir,
    );
    const sheets = stdout.trim().split("\n");
    expect(sheets).toHaveLength(1);
    expect(existsSync(sheets[0]!)).toBe(true);
    expect(stderr).toContain("1 cells, 1 sheet(s)");
    expect(stderr).not.toContain("unchanged since the last run");

    const again = await run(["probe", "contact-sheet", "--needs-review", "reference"], projectDir);
    expect(again.stdout).toBe(stdout);
    expect(again.stderr).toContain("1 of 1 sheet(s) unchanged since the last run");
  });

  it("samples a clip take into --frames-per-take cells", async () => {
    const projectDir = await initAndGenerate();
    await unaccept(projectDir, "reference:clip");

    const { stderr } = await run(
      ["probe", "contact-sheet", "--needs-review", "reference", "--frames-per-take", "3"],
      projectDir,
    );
    expect(stderr).toContain("3 cells, 1 sheet(s)");
  });

  it("leaves an audio take off without listing it", async () => {
    const projectDir = await initAndGenerate();
    await unaccept(projectDir, "reference:plateA", "reference:sfx");

    const { stderr } = await run(
      ["probe", "contact-sheet", "--needs-review", "reference"],
      projectDir,
    );
    expect(stderr).toContain("1 cells, 1 sheet(s)");
    expect(stderr).not.toContain("skipped");

    await acceptAddress(projectDir, "reference:plateA");
    await expect(
      run(["probe", "contact-sheet", "--needs-review", "reference"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("is audio") });
  });

  it("narrows to an address-scope, and says so when that scope has nothing", async () => {
    const projectDir = await initAndGenerate();
    await unaccept(projectDir, "reference:plateA");

    const { stderr } = await run(
      ["probe", "contact-sheet", "--needs-review", "reference"],
      projectDir,
    );
    expect(stderr).toContain("1 cells, 1 sheet(s)");

    await expect(
      run(["probe", "contact-sheet", "--needs-review", "animatic"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VARIANT_NOT_FOUND") });
  });

  it("requires an argument or --needs-review", async () => {
    const projectDir = await initAndGenerate();
    await expect(run(["probe", "contact-sheet"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_OPTION"),
    });
  });
});

describe("probe contact-sheet (reel scope)", () => {
  // A picture sheet is not held by a sound take: `probe` is a read surface, so the capture draws what
  // is there rather than refusing on an asset the sheet never shows. A narration reroll gets here.
  it("tiles the board while an audio take has none ready", async () => {
    const projectDir = await initWithCrossStageStemVideo();
    await acceptDirection(projectDir);
    await ensureFfmpeg();
    const files = path.join(projectDir, "assets", "files");
    await fs.mkdir(files, { recursive: true });
    const png = path.join(files, "kf.png");
    await promisify(execFile)(await ffmpegBin(), [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:size=1024x576",
      "-frames:v",
      "1",
      png,
    ]);

    const sm = await StateManager.load(projectDir);
    const keyframe = "animatic:shot.01.keyframe";
    const kfId = sm.reserveVariantId(keyframe);
    sm.getAssetState(keyframe).variants![kfId]!.file = path.relative(projectDir, png);
    sm.setAccepted(keyframe, kfId);
    // The voice mid-reroll: the take beside it decided against, the new one not landed.
    const voice = "animatic:shot.01.voice";
    const dead = sm.reserveVariantId(voice);
    sm.getAssetState(voice).variants![dead]!.status = "dismissed";
    await sm.save();

    const failure = await run(["probe", "contact-sheet", "animatic"], projectDir).catch(
      (err: { stderr?: string }) => err.stderr ?? "",
    );
    expect(String(failure)).not.toContain("COMPOSITION_BUILD_FAILED");
  }, 60000);
});
