import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KonteError } from "../errors.js";

vi.mock("../exec-file.js", () => ({
  execFileAsync: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue("/tmp/konte-concat-mock"),
  };
});

vi.mock("../ffmpeg-binary.js", () => ({
  ffmpegBin: vi.fn().mockResolvedValue("ffmpeg"),
  ffprobeBin: vi.fn().mockResolvedValue("ffprobe"),
}));

import * as fsPromises from "node:fs/promises";
import { ffmpegBin, ffprobeBin } from "../ffmpeg-binary.js";
import {
  concatenateShots,
  ensureFfmpeg,
  ensureFfprobe,
  tagDeliverable,
  trimVideo,
} from "../ffmpeg.js";
import { execFileAsync } from "../exec-file.js";

const execFileMock = execFileAsync as unknown as Mock;

function getFfmpegArgs(): string[] {
  const call = execFileMock.mock.calls.find((c: unknown[]) => c[0] === "ffmpeg") as
    | unknown[]
    | undefined;
  if (!call) throw new Error("ffmpeg was not called");
  return call[1] as string[];
}

function mockExecFileSuccess(): void {
  execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
}

function mockExecFileFailure(message: string): void {
  execFileMock.mockRejectedValue(new Error(message));
}

beforeEach(() => {
  vi.resetAllMocks();
  mockExecFileSuccess();
  (ffmpegBin as unknown as Mock).mockResolvedValue("ffmpeg");
  (ffprobeBin as unknown as Mock).mockResolvedValue("ffprobe");
  (fsPromises.mkdir as Mock).mockResolvedValue(undefined);
  (fsPromises.writeFile as Mock).mockResolvedValue(undefined);
  (fsPromises.rm as Mock).mockResolvedValue(undefined);
  (fsPromises.mkdtemp as Mock).mockResolvedValue("/tmp/konte-concat-mock");
});

describe("ensureFfmpeg / ensureFfprobe", () => {
  it("provisions each binary", async () => {
    await ensureFfmpeg();
    await ensureFfprobe();
    expect(ffmpegBin).toHaveBeenCalled();
    expect(ffprobeBin).toHaveBeenCalled();
  });
});

describe("trimVideo", () => {
  it("re-encodes for a frame-accurate cut instead of stream copy", async () => {
    await trimVideo({
      inputFile: "/input/video.mp4",
      outputFile: "/output/trimmed.mp4",
      start: 30,
      duration: 5,
    });

    const args = getFfmpegArgs();

    expect(args).toContain("-y");
    expect(args).toContain("-ss");
    expect(args).toContain("30");
    expect(args).toContain("-t");
    expect(args).toContain("5");
    expect(args).toContain("-i");
    expect(args).toContain("/input/video.mp4");
    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    // Stream copy would snap the cut to a keyframe — must not be used.
    expect(args).not.toContain("copy");
    expect(args).toContain("/output/trimmed.mp4");
  });

  it("places -ss before -i for input seeking", async () => {
    await trimVideo({
      inputFile: "/input/video.mp4",
      outputFile: "/output/trimmed.mp4",
      start: 10,
      duration: 3,
    });

    const args = getFfmpegArgs();
    const ssIdx = args.indexOf("-ss");
    const iIdx = args.indexOf("-i");
    expect(ssIdx).toBeLessThan(iIdx);
  });

  it("throws FFMPEG_ERROR on failure", async () => {
    mockExecFileFailure("trim failed");

    await expect(
      trimVideo({
        inputFile: "/input/video.mp4",
        outputFile: "/output/trimmed.mp4",
        start: 0,
        duration: 5,
      }),
    ).rejects.toThrow(KonteError);
    await expect(
      trimVideo({
        inputFile: "/input/video.mp4",
        outputFile: "/output/trimmed.mp4",
        start: 0,
        duration: 5,
      }),
    ).rejects.toThrow("trimVideo failed");
  });
});

describe("concatenateShots", () => {
  it("creates temp filelist and calls ffmpeg concat", async () => {
    await concatenateShots({
      inputFiles: ["/input/shot-01.mp4", "/input/shot-02.mp4"],
      outputFile: "/output/final.mp4",
    });

    expect(fsPromises.mkdtemp).toHaveBeenCalled();
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      "/tmp/konte-concat-mock/filelist.txt",
      expect.stringContaining("file '/input/shot-01.mp4'"),
      "utf-8",
    );

    const args = getFfmpegArgs();

    expect(args).toContain("-f");
    expect(args).toContain("concat");
    expect(args).toContain("-safe");
    expect(args).toContain("0");
    expect(args).toContain("-c");
    expect(args).toContain("copy");
    expect(args).toContain("/output/final.mp4");
  });

  it("re-encodes to a uniform codec when reencode is set", async () => {
    await concatenateShots({
      inputFiles: ["/input/shot-01.mp4", "/input/shot-02.mp4"],
      outputFile: "/output/final.mp4",
      reencode: true,
    });

    const args = getFfmpegArgs();

    expect(args).toContain("-f");
    expect(args).toContain("concat");
    expect(args).not.toContain("copy");
    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    expect(args).toContain("-pix_fmt");
    expect(args).toContain("yuv420p");
    expect(args).toContain("-c:a");
    expect(args).toContain("aac");
    expect(args).toContain("/output/final.mp4");
  });

  it("cleans up temp directory after completion", async () => {
    await concatenateShots({
      inputFiles: ["/input/shot-01.mp4"],
      outputFile: "/output/final.mp4",
    });

    expect(fsPromises.rm).toHaveBeenCalledWith("/tmp/konte-concat-mock", {
      recursive: true,
      force: true,
    });
  });
});

describe("tagDeliverable", () => {
  it("passes use_metadata_tags — without it the mov muxer drops a custom key silently", async () => {
    await tagDeliverable({
      file: "/out/video.mp4",
      tags: { konte_manifest: "mf-Ab12Cd34" },
    });

    const args = getFfmpegArgs();
    expect(args).toContain("use_metadata_tags+faststart");
    expect(args).toContain("konte_manifest=mf-Ab12Cd34");
    // Every stream, stream-copied: tagging must never re-encode the deliverable.
    expect(args.join(" ")).toContain("-map 0 -c copy");
  });
});
