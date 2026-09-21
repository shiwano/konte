import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { GenerationRequest } from "../../core/backend.js";
import { ffmpegBin, ffprobeBin } from "../../core/ffmpeg-binary.js";
import type { AssetDefinition, LocalAssetDefinition } from "../../core/types/index.js";
import { captureHtmlToImage } from "../../core/still-capture.js";
import { LocalBackend } from "../backend.js";

// No test in this suite launches a browser (see vitest.setup.ts), and what the backend owns is the
// rewrite it hands the capture — stub the capture and leave it an output file to find.
vi.mock("../../core/still-capture.js", () => ({
  captureHtmlToImage: vi.fn(async ({ outputFile }: { outputFile: string }) => {
    await (await import("node:fs/promises")).writeFile(outputFile, "png");
  }),
}));

const captureHtmlToImageMock = captureHtmlToImage as unknown as Mock;

const execFileAsync = promisify(execFile);

let videoRoot: string;
let outputDir: string;

function localDef(
  operation: LocalAssetDefinition["operation"],
  mediaType: LocalAssetDefinition["mediaType"],
  inputs: Record<string, unknown>,
): LocalAssetDefinition {
  return { kind: "local", operation, mediaType, inputs };
}

function request(
  assetDefinition: AssetDefinition,
  resolvedDependencies: Record<string, string> = {},
): GenerationRequest {
  return {
    address: "video:shot.01.pic",
    assetDefinition,
    variantId: "v-local001",
    outputDir,
    resolvedDependencies,
  };
}

// The only thing worth asserting about the ffmpeg args konte builds is what ffmpeg actually
// produced from them, so read the result back with ffprobe.
async function probe(file: string): Promise<{ width: number; height: number; codec: string }> {
  const { stdout } = await execFileAsync(await ffprobeBin(), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,codec_name",
    "-of",
    "json",
    file,
  ]);
  const stream = JSON.parse(stdout).streams[0];
  return { width: stream.width, height: stream.height, codec: stream.codec_name };
}

async function audioDuration(file: string): Promise<number> {
  const { stdout } = await execFileAsync(await ffprobeBin(), [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=duration",
    "-of",
    "json",
    file,
  ]);
  return Number(JSON.parse(stdout).streams[0].duration);
}

async function generate(
  assetDefinition: AssetDefinition,
  resolvedDependencies: Record<string, string> = {},
): Promise<string> {
  const backend = new LocalBackend(videoRoot);
  await backend.submit(request(assetDefinition, resolvedDependencies));
  const result = await backend.waitForCompletion("local-v-local001", outputDir);
  if (result.kind !== "done") throw new Error("expected the local op to complete");
  return result.result.files[0]!;
}

// A real 4x4 PNG for the ops that consume an upstream image.
async function makeSourceImage(relPath: string): Promise<string> {
  const absolute = path.join(videoRoot, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await generate(localDef("blank", "image", { width: 4, height: 4, color: "#ff0000" }));
  await fs.rename(path.join(outputDir, "output.png"), absolute);
  return absolute;
}

// A 8x4 still whose left half is red and right half blue, so a crop identifies its half.
async function makeTwoToneImage(relPath: string): Promise<string> {
  const absolute = path.join(videoRoot, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await execFileAsync(await ffmpegBin(), [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=4x4:d=0.04",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=4x4:d=0.04",
    "-filter_complex",
    "hstack",
    "-frames:v",
    "1",
    absolute,
  ]);
  return absolute;
}

// The frame op's whole substance is *which* frame it landed on.
async function pixelColor(file: string): Promise<[number, number, number]> {
  const { stdout } = await execFileAsync(
    await ffmpegBin(),
    ["-v", "error", "-i", file, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer" },
  );
  const bytes = stdout as unknown as Buffer;
  return [bytes[0]!, bytes[1]!, bytes[2]!];
}

// A 2s clip whose first second is red and second second is blue, so a frame identifies its half.
async function makeTwoToneClip(relPath: string): Promise<string> {
  const absolute = path.join(videoRoot, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await execFileAsync(await ffmpegBin(), [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32:d=1:r=10",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x32:d=1:r=10",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1[out]",
    "-map",
    "[out]",
    "-pix_fmt",
    "yuv420p",
    absolute,
  ]);
  return absolute;
}

beforeEach(async () => {
  videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "konte-local-test-"));
  outputDir = path.join(videoRoot, "out");
  captureHtmlToImageMock.mockClear();
});

afterEach(async () => {
  await fs.rm(videoRoot, { recursive: true, force: true });
});

describe("LocalBackend blank", () => {
  it("renders a blank image at the requested size", async () => {
    const file = await generate(
      localDef("blank", "image", { width: 320, height: 180, color: "#112233" }),
    );

    expect(path.basename(file)).toBe("output.png");
    expect(await probe(file)).toMatchObject({ width: 320, height: 180 });
  });

  it("expands a shorthand hex colour to ffmpeg's 0xRRGGBB form, alpha preserved", async () => {
    const file = await generate(
      localDef("blank", "image", { width: 8, height: 8, color: "#f0f8" }),
    );

    // #RGBA → 0xRRGGBBAA through the rgba filtergraph, so the output keeps an alpha channel.
    expect(await probe(file)).toMatchObject({ width: 8, height: 8, codec: "png" });
  });

  it("defaults to black when no colour is given", async () => {
    const file = await generate(localDef("blank", "image", { width: 16, height: 16 }));
    expect(await probe(file)).toMatchObject({ width: 16, height: 16 });
  });
});

describe("LocalBackend resize", () => {
  it("resolves an input placeholder through resolvedDependencies and scales that file", async () => {
    const source = await makeSourceImage("assets/source.png");
    const placeholder = "__konte:animatic:shot.01.first__";

    const file = await generate(
      localDef("resize", "image", { image: placeholder, width: 64, height: 32 }),
      { "animatic:shot.01.first": source },
    );

    expect(await probe(file)).toMatchObject({ width: 64, height: 32 });
  });

  it("resolves a project-relative dependency path against the project root", async () => {
    await makeSourceImage("assets/source.png");
    const placeholder = "__konte:reference:bg__";

    const file = await generate(
      localDef("resize", "image", { image: placeholder, width: 20, height: 10 }),
      { "reference:bg": "assets/source.png" },
    );

    expect(await probe(file)).toMatchObject({ width: 20, height: 10 });
  });

  it("fails with FFMPEG_ERROR when ffmpeg cannot read the input", async () => {
    const notAnImage = path.join(videoRoot, "broken.png");
    await fs.writeFile(notAnImage, "not a png");

    await expect(
      generate(localDef("resize", "image", { image: notAnImage, width: 10, height: 10 })),
    ).rejects.toMatchObject({ code: "FFMPEG_ERROR" });
  });
});

describe("LocalBackend crop", () => {
  it("cuts the declared window and scales it to the out size", async () => {
    const source = await makeTwoToneImage("assets/two-tone.png");

    const file = await generate(
      localDef("crop", "image", {
        image: "__konte:reference:room__",
        x: 4,
        y: 0,
        width: 4,
        height: 4,
        outWidth: 32,
        outHeight: 32,
      }),
      { "reference:room": source },
    );

    expect(await probe(file)).toMatchObject({ width: 32, height: 32 });
    const [r, , b] = await pixelColor(file);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(50);
  });

  it("fails with FFMPEG_ERROR when the window runs past the source", async () => {
    const source = await makeSourceImage("assets/small.png");

    await expect(
      generate(
        localDef("crop", "image", {
          image: source,
          x: 0,
          y: 0,
          width: 999,
          height: 999,
          outWidth: 10,
          outHeight: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: "FFMPEG_ERROR" });
  });
});

describe("LocalBackend output extension", () => {
  it("takes a trim's extension from its source file, not its media type", async () => {
    const clip = path.join(videoRoot, "clip.mkv");
    await execFileAsync(await ffmpegBin(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=32x32:d=1",
      clip,
    ]);

    const file = await generate(
      localDef("trim", "video", { source: clip, start: 0, duration: 0.5 }),
    );

    expect(path.basename(file)).toBe("output.mkv");
  });
});

describe("LocalBackend retime", () => {
  const tone = async (name: string, seconds: number): Promise<string> => {
    const file = path.join(videoRoot, name);
    await execFileAsync(await ffmpegBin(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      file,
    ]);
    return file;
  };

  it("lands the take on the requested duration", async () => {
    const source = await tone("line.wav", 2.1);

    const file = await generate(
      localDef("retime", "audio", { source: "__konte:animatic:shot.01.line__", duration: 2 }),
      { "animatic:shot.01.line": source },
    );

    expect(path.basename(file)).toBe("output.wav");
    expect(await audioDuration(file)).toBeCloseTo(2, 1);
  });

  it("refuses a rate past the ceiling when no waiver stands", async () => {
    const source = await tone("long.wav", 3);

    await expect(
      generate(
        localDef("retime", "audio", { source: "__konte:animatic:shot.01.line__", duration: 2 }),
        { "animatic:shot.01.line": source },
      ),
    ).rejects.toMatchObject({ code: "RETIME_RATE_EXCEEDED" });
  });

  it("runs the same rate with a waiver declared", async () => {
    const source = await tone("long.wav", 3);

    const file = await generate(
      localDef("retime", "audio", {
        source: "__konte:animatic:shot.01.line__",
        duration: 2,
        waiver: "the narrator's read is deliberately unhurried; the shot is fixed",
      }),
      { "animatic:shot.01.line": source },
    );

    expect(await audioDuration(file)).toBeCloseTo(2, 1);
  });
});

describe("LocalBackend frame", () => {
  it("takes the frame at `at`, resolving the source through resolvedDependencies", async () => {
    const clip = await makeTwoToneClip("assets/clip.mp4");
    const placeholder = "__konte:video:shot.01.motion__";

    const early = await generate(localDef("frame", "image", { source: placeholder, at: 0.3 }), {
      "video:shot.01.motion": clip,
    });
    expect(path.basename(early)).toBe("output.png");
    const [r, , b] = await pixelColor(early);
    expect(r).toBeGreaterThan(b);
  });

  it('lands on the clip\'s own last frame for `at: "last"`, not past its end', async () => {
    const clip = await makeTwoToneClip("assets/clip.mp4");

    const file = await generate(localDef("frame", "image", { source: clip, at: "last" }));

    const [r, , b] = await pixelColor(file);
    expect(b).toBeGreaterThan(r);
  });

  it("stays inside the picture when a longer audio track overstates the container", async () => {
    const clip = path.join(videoRoot, "with-audio.mp4");
    await execFileAsync(await ffmpegBin(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=32x32:d=1:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=32x32:d=1:r=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1[out]",
      "-map",
      "[out]",
      "-map",
      "2:a",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);

    // The container runs 4s, the picture 2s. Seeking on the container's duration lands past the
    // last frame and comes back empty; the stream's own duration lands on the blue tail.
    const file = await generate(localDef("frame", "image", { source: clip, at: "last" }));
    const [r, , b] = await pixelColor(file);
    expect(b).toBeGreaterThan(r);
  });

  it("refuses `last` on a clip ffprobe reports no duration for, over handing back its first frame", async () => {
    // A raw Annex-B stream carries no duration in either the container or the stream, which used to
    // resolve to a seek at 0 — the first frame, returned as if it were the last.
    const raw = path.join(videoRoot, "raw.h264");
    await execFileAsync(await ffmpegBin(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=32x32:d=1:r=10",
      "-c:v",
      "libx264",
      "-f",
      "h264",
      raw,
    ]);

    await expect(
      generate(localDef("frame", "image", { source: raw, at: "last" })),
    ).rejects.toMatchObject({ code: "FFPROBE_ERROR" });
  });

  it("fails with FFMPEG_ERROR when `at` seeks past the end of the clip", async () => {
    const clip = await makeTwoToneClip("assets/clip.mp4");

    await expect(
      generate(localDef("frame", "image", { source: clip, at: 30 })),
    ).rejects.toMatchObject({ code: "FFMPEG_ERROR" });
  });
});

describe("LocalBackend render", () => {
  const html =
    '<div class="konte-clip"></div><img class="konte-clip" src="__konte:reference:plate__">';

  function renderDef(refs: string[]) {
    return localDef("render", "image", { html, width: 32, height: 24, refs });
  }

  it("hands the capture the declared size and a .png to write", async () => {
    const file = await generate(renderDef([]));

    expect(path.basename(file)).toBe("output.png");
    expect(captureHtmlToImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFile: file,
        size: { width: 32, height: 24 },
        format: "png",
      }),
    );
  });

  it("rewrites each ref to a workspace name and hands over the file behind it", async () => {
    const source = await makeSourceImage("assets/plate.png");

    await generate(renderDef(["__konte:reference:plate__"]), { "reference:plate": source });

    const call = captureHtmlToImageMock.mock.calls[0]![0];
    expect(call.html).toBe(
      '<div class="konte-clip"></div><img class="konte-clip" src="asset-0.png">',
    );
    expect(call.assetFiles).toEqual({ "asset-0.png": source });
  });

  // An asset name may contain underscores, so one placeholder can be a prefix of another.
  it("substitutes a placeholder that another one is a prefix of", async () => {
    const short = await makeSourceImage("assets/short.png");
    const long = await makeSourceImage("assets/long.png");
    const overlapping = '<img src="__konte:reference:a__"><img src="__konte:reference:a__b__">';

    await generate(
      localDef("render", "image", {
        html: overlapping,
        width: 32,
        height: 24,
        refs: ["__konte:reference:a__", "__konte:reference:a__b__"],
      }),
      { "reference:a": short, "reference:a__b": long },
    );

    const call = captureHtmlToImageMock.mock.calls[0]![0];
    expect(call.html).not.toContain("__konte:");
    const [shortName, longName] = [
      Object.entries(call.assetFiles).find(([, f]) => f === short)![0],
      Object.entries(call.assetFiles).find(([, f]) => f === long)![0],
    ];
    expect(call.html).toBe(`<img src="${shortName}"><img src="${longName}">`);
  });

  it("refuses a ref resolving outside the video root", async () => {
    const outside = path.join(os.tmpdir(), `konte-outside-${process.pid}.png`);
    await fs.writeFile(outside, "not a png");

    await expect(
      generate(renderDef(["__konte:reference:plate__"]), { "reference:plate": outside }),
    ).rejects.toThrow();
    expect(captureHtmlToImageMock).not.toHaveBeenCalled();

    await fs.rm(outside, { force: true });
  });
});

describe("LocalBackend contract", () => {
  it("rejects an asset that is not a local op", async () => {
    const backend = new LocalBackend(videoRoot);
    const comfyDef = {
      kind: "comfy",
      workflow: {},
      inputs: {},
      outputs: {},
    } as unknown as AssetDefinition;

    await expect(backend.submit(request(comfyDef))).rejects.toMatchObject({
      code: "INVALID_ASSET_TYPE",
    });
  });

  it("fails the wait when the op left no output file", async () => {
    await fs.mkdir(outputDir, { recursive: true });
    const backend = new LocalBackend(videoRoot);

    await expect(backend.waitForCompletion("local-v-none", outputDir)).rejects.toMatchObject({
      code: "GENERATION_FAILED",
    });
  });
});
