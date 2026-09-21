import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ctx,
  useTempWorkspace,
  run,
  initWorkspace,
  acceptDirection,
  acceptFileAssets,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("probe reel-audio command", () => {
  // bgm (assets/files/bgm.mp3) ships with the fixture video; `bed` covers the whole timeline and
  // `sting` overlaps it on shot 02, so the two clip together (0.3 + 0.9 = 1.2). Shot 01 carries an
  // `<Audio>` cue. No generatable assets, so `generate` only syncs the bgm file asset.
  const AUDIO_REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  // The fixture direction anchors its shots to the "studio" location, so expose it here.
  const studio = asset("studio", internalTestPlate, { width: 64, height: 64, color: "#eee" });
  return { character, bgm, studio };
});
`;

  const AUDIO_VIDEO_TSX = `import { Audio, Composition, defineVideo, soundtrack, defineDirection } from "konte";
import reference from "./reference";

const direction = defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
    detail: { name: "the detail", description: "in close on the hands", location: "studio", framing: "close", holds: ["studioMark"], within: null },
  },
  policy: {
      format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
      lang: "en",
      speech: "free",
    },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "ordinary", action: "test shot", setup: "front", duration: 3 , lineup: [] },
      { id: "02", role: "hero", action: "test shot", setup: "detail", duration: 4 , lineup: [] },
    ],
    waivers: { "location-unreferenced_studio": "reference stage exposes no studio plate" },
  },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => {
    const bgm = reference.bgm;
    return {
      soundtracks: [
        soundtrack("bed", bgm, { volume: 0.3, duck: true }),
        soundtrack("sting", bgm, { volume: 0.9, duck: false, from: { shot: "02" }, until: { shot: "02" } }),
      ],
      shots: shot("01", () => (
          <Composition>
            <Audio src={bgm} id="vo" start={0.5} duration={1.8} volume={0.9} />
          </Composition>
        )).nextShot("02", () => (
          <Composition>
            <div />
          </Composition>
        )),
    };
  },
});
`;

  async function initWithAudioVideo(): Promise<string> {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "testproject"));
    await fs.writeFile(path.join(projectDir, "reference.tsx"), AUDIO_REFERENCE_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), AUDIO_VIDEO_TSX);
    await acceptDirection(projectDir);
    return projectDir;
  }

  it("rejects an asset-level scope", async () => {
    const projectDir = await initWithAudioVideo();
    await expect(
      run(["probe", "reel-audio", "video:shot.01.motion"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("INVALID_ADDRESS") });
  });

  it("reports unresolved sources as not-generated before generate", async () => {
    const projectDir = await initWithAudioVideo();
    const { stdout } = await run(["probe", "reel-audio", "video"], projectDir);

    expect(stdout).toContain("total 7.0s");
    expect(stdout).toContain("⚠ bed: not generated yet");
    expect(stdout).toContain("LUFS unknown  gain 0.30  auto off: source unmeasured");
    expect(stdout).not.toContain("effective gain sum");
  });

  it("reconstructs the audio timeline and reports gain overlap after the source is synced", async () => {
    const projectDir = await initWithAudioVideo();
    await acceptFileAssets(projectDir);
    await run(["generate", "video"], projectDir);

    const { stdout } = await run(["probe", "reel-audio", "video"], projectDir);
    const table = stdout.slice(stdout.indexOf("Tracks:")).split("\n");
    const trackLine = (tag: string) =>
      table.find((line) => line.trim().startsWith(`${tag} `)) ?? "";
    const lufsOf = (tag: string) => Number(trackLine(tag).match(/(-?[\d.]+) LUFS/)?.[1]);

    expect(stdout).toContain("total 7.0s");

    expect(stdout).toContain("LUFS estimates use whole-source loudness + effective gain.");
    expect(stdout).toContain("They exclude trimming, fades, and final mixing");
    expect(trackLine("bed")).toMatch(/est -?[\d.]+ LUFS  gain [\d.]+  auto [+-][\d.]+ dB/);
    expect(trackLine("01 vo")).toMatch(/auto [+-][\d.]+ dB/);
    expect(trackLine("bed")).toMatch(/soundtrack\s+0\.0–7\.0s/);
    expect(trackLine("sting")).toMatch(/soundtrack\s+3\.0–7\.0s/);
    // A reported level is what the mux writes: the declared gain with the source's levelling
    // folded in. Both beds pull the same source, so the one gain scales both.
    expect(lufsOf("bed")).toBeLessThan(0);
    // Both levels are printed to one decimal, so the gap lands within a tenth of the gain.
    expect(lufsOf("sting") - lufsOf("bed")).toBeCloseTo(20 * Math.log10(3), 0);
    // No line plays over these beds (the fixture's cue carries no script), so neither ducks.
    expect(trackLine("bed")).not.toContain("ducks to");

    expect(trackLine("01 vo")).toMatch(/sound\s+0\.5–/);

    expect(stdout).toContain("effective gain sum");
    expect(stdout).toContain("clipping and limiter reduction are unmeasured");
    expect(stdout).not.toContain("⚠ effective gain sum");
    expect(stdout).not.toContain("alimiter active");
  });

  // 16-bit mono PCM: a 2s tone, then 4s of digital silence — the shape a music model that stops
  // early leaves behind.
  function toneThenSilenceWav(toneSeconds = 2): Buffer {
    const rate = 44100;
    const data = Buffer.alloc(6 * rate * 2);
    for (let i = 0; i < toneSeconds * rate; i++) {
      data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 20000), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  }

  it("flags an early-ended source per track, over the region each track plays", async () => {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "testproject"));
    await fs.writeFile(path.join(projectDir, "assets", "files", "early.wav"), toneThenSilenceWav());
    await fs.writeFile(
      path.join(projectDir, "reference.tsx"),
      AUDIO_REFERENCE_TS.replace("assets/files/bgm.mp3", "assets/files/early.wav"),
    );
    await fs.writeFile(path.join(projectDir, "video.tsx"), AUDIO_VIDEO_TSX);
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);
    await run(["generate", "video"], projectDir);

    const { stdout } = await run(["probe", "reel-audio", "video"], projectDir);
    const silence = stdout.split("\n").filter((line) => line.includes("trailing silence"));

    // `bed` loops the 6s source across the 7s timeline, so the 4s gap recurs each lap.
    // `sting` plays 3s–7s of the timeline, i.e. the source's first 4s: tone, then 2s of silence.
    // The shot-01 cue plays 1.8s of tone — its region is all audible, so it stays clean.
    expect(silence.map((line) => line.trim())).toEqual([
      "⚠ bed: trailing silence: 4.0s (audio ends at 2.0s / 6.0s) — replays every loop",
      "⚠ sting: trailing silence: 2.0s (audio ends at 2.0s / 4.0s)",
    ]);
    expect(stdout).toContain("⚠ bed: loops ×2 to fill 7.0s span (source 6.00s)");
  });

  it("keeps faded cue and bed source cuts out of warnings", async () => {
    const projectDir = await initWithAudioVideo();
    await fs.writeFile(path.join(projectDir, "assets", "files", "tone.wav"), toneThenSilenceWav(6));
    await fs.writeFile(
      path.join(projectDir, "reference.tsx"),
      AUDIO_REFERENCE_TS.replace("assets/files/bgm.mp3", "assets/files/tone.wav"),
    );
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      AUDIO_VIDEO_TSX.replace("duration={1.8}", "duration={1.8} fadeOut={0.25}").replace(
        "volume: 0.9, duck: false",
        "volume: 0.9, duck: false, fadeOut: 0.25",
      ),
    );
    await acceptFileAssets(projectDir);
    const { stdout } = await run(["probe", "reel-audio", "video"], projectDir);
    expect(stdout).toContain("Notes:");
    expect(stdout).toContain("01 vo: window cuts mid-sound");
    expect(stdout).toContain("sting: window cuts mid-sound");
    expect(stdout).toContain("fadeOut 0.25s reaches silence");
    expect(stdout).not.toContain("⚠ 01 vo: window cuts");
    expect(stdout).not.toContain("⚠ sting: window cuts");
    expect(stdout).not.toContain("raise `duration`");
  });

  it("narrows the view window to a single shot", async () => {
    const projectDir = await initWithAudioVideo();
    await acceptFileAssets(projectDir);
    await run(["generate", "video"], projectDir);

    const { stdout } = await run(["probe", "reel-audio", "video:shot.02"], projectDir);

    expect(stdout).toContain("video:shot.02   total 7.0s   2 tracks");
    // The shot-01 cue is outside the window; bed (spanning) and sting remain.
    expect(stdout).not.toContain("01 vo");
    expect(stdout).toContain("sting");
  });

  it("caches each source's amplitude and stays deterministic across runs", async () => {
    const projectDir = await initWithAudioVideo();
    await acceptFileAssets(projectDir);
    await run(["generate", "video"], projectDir);

    const first = await run(["probe", "reel-audio", "video"], projectDir);

    // The three tracks share one source (bgm), so exactly one profile is cached.
    const cached = await fs.readdir(path.join(projectDir, ".konte", "cache", "audio"), {
      recursive: true,
    });
    expect(cached.filter((f) => f.endsWith(".json"))).toHaveLength(1);

    const second = await run(["probe", "reel-audio", "video"], projectDir);
    expect(second.stdout).toEqual(first.stdout);
  });
});

describe("probe audio command", () => {
  // The fixture video ships a bgm soundtrack (assets/files/bgm.mp3) in the reference stage;
  // `generate` syncs it to a variant under reference:bgm.
  async function initAndSyncBgm(): Promise<{ projectDir: string; variantId: string }> {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "testproject"));
    // Reference file assets (bgm) are synced by generating the reference stage.
    await run(["generate", "reference"], projectDir);
    const state = JSON.parse(await fs.readFile(path.join(projectDir, "konte.state.json"), "utf-8"));
    const variantId = Object.keys(state.assets["reference:bgm"].variants)[0]!;
    return { projectDir, variantId };
  }

  it("shows a source's waveform and audio info by variant id", async () => {
    const { projectDir, variantId } = await initAndSyncBgm();
    const { stdout } = await run(["probe", "audio", variantId], projectDir);

    expect(stdout).toContain(`${variantId}   reference:bgm   [none]`);
    expect(stdout).toMatch(/ {2}duration {2}\d/);
    expect(stdout).toContain("mp3");
    expect(stdout).toContain("stereo");
  });

  it("reports where the sound sits inside the file, so a cue needs no eyeballed offset", async () => {
    const { projectDir, variantId } = await initAndSyncBgm();

    // Two decimals: a rounded 0.1s is three frames off at 30fps.
    const { stdout } = await run(["probe", "audio", variantId], projectDir);
    const onset = stdout.match(/ {2}onset {5}(\d+\.\d{2})s first audible, (\d+\.\d{2})s peak/);
    const duration = Number(stdout.match(/ {2}duration {2}([\d.]+)s/)?.[1]);

    expect(onset).not.toBeNull();
    expect(Number(onset![2])).toBeGreaterThanOrEqual(Number(onset![1]));
    expect(Number(onset![2])).toBeLessThanOrEqual(duration);
  });

  // A `line` row needs a voice adapter, which reaches a backend — out of a CLI fixture's range. This
  // covers the other half: probing by variant id now loads the stages to look the words up.
  it("claims no line for a source that carries no words", async () => {
    const { projectDir, variantId } = await initAndSyncBgm();

    const { stdout } = await run(["probe", "audio", variantId], projectDir);
    expect(stdout).not.toMatch(/ {2}line {6}/);
  });

  it("reuses the per-variant cache that `probe reel-audio` fills", async () => {
    const { projectDir, variantId } = await initAndSyncBgm();
    await run(["probe", "audio", variantId], projectDir);

    const variantCacheDir = path.join(projectDir, ".konte", "cache", "audio", variantId);
    const cached = await fs.readdir(variantCacheDir);
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatch(/\.json$/); // keyed by the variant's output hash

    const before = await fs.readdir(variantCacheDir);
    await run(["probe", "reel-audio", "video"], projectDir);
    expect(await fs.readdir(variantCacheDir)).toEqual(before); // no new decode
  });

  it("fails with VARIANT_NOT_FOUND for an unknown id", async () => {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "testproject"));
    await expect(run(["probe", "audio", "v-nope"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_FOUND"),
    });
  });

  it("sweeps an address-scope, probing each source and skipping non-audio media", async () => {
    const { projectDir } = await initAndSyncBgm();
    // The fixture reference stage carries bgm (audio) plus character/studio (images); an audio sweep
    // keeps only bgm.
    const { stdout } = await run(["probe", "audio", "reference"], projectDir);

    const probed = [...stdout.matchAll(/^v-\S+ {3}(\S+) {3}\[/gm)].map((m) => m[1]);
    expect(probed).toEqual(["reference:bgm"]);
    expect(stdout).not.toContain("no audio stream");
  });

  it("fails with VARIANT_NOT_FOUND when a scope matches no audio source", async () => {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "testproject"));
    await run(["generate", "reference"], projectDir);
    // animatic has no synced sources yet, so the audio sweep finds nothing probeable.
    await expect(run(["probe", "audio", "animatic"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_FOUND"),
    });
  });
});
