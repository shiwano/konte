import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ probeMediaInfo: vi.fn() }));
vi.mock("../video-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../video-probe.js")>()),
  probeMediaInfo: probe.probeMediaInfo,
}));

import type { VariantMedia, VariantState } from "../types/index.js";
import { ensureVariantMedia, mediaByFile, mediaDurationSec } from "../variant-media.js";
import { buildVariantMedia, probeMediaInfo } from "../video-probe.js";

const videoStream = (over: Record<string, unknown> = {}) => ({
  codec_type: "video",
  width: 1920,
  height: 1080,
  avg_frame_rate: "24/1",
  r_frame_rate: "24/1",
  ...over,
});

const audioStream = (over: Record<string, unknown> = {}) => ({
  codec_type: "audio",
  channels: 2,
  sample_rate: "48000",
  ...over,
});

describe("buildVariantMedia", () => {
  it("reads a still's dimensions off its one-frame video stream", () => {
    const raw = { streams: [videoStream({ avg_frame_rate: "0/0", r_frame_rate: "25/1" })] };
    expect(buildVariantMedia("image", raw)).toEqual({ kind: "image", width: 1920, height: 1080 });
  });

  it("keeps no fps or duration on a still, even when ffprobe reports them", () => {
    const raw = { format: { duration: "0.04" }, streams: [videoStream()] };
    expect(buildVariantMedia("image", raw)).toEqual({ kind: "image", width: 1920, height: 1080 });
  });

  it("records a video with its audio stream", () => {
    const raw = { format: { duration: "5.5" }, streams: [videoStream(), audioStream()] };
    expect(buildVariantMedia("video", raw)).toEqual({
      kind: "video",
      width: 1920,
      height: 1080,
      fps: 24,
      durationSec: 5.5,
      audio: { channels: 2, sampleRate: 48000 },
    });
  });

  it("distinguishes a silent video from an unmeasured one", () => {
    const raw = { format: { duration: "5.5" }, streams: [videoStream()] };
    expect(buildVariantMedia("video", raw)).toMatchObject({ audio: null });
  });

  it("prefers avg_frame_rate over the timebase tick rate", () => {
    const raw = {
      format: { duration: "5.5" },
      streams: [videoStream({ avg_frame_rate: "24000/1001", r_frame_rate: "48/1" })],
    };
    expect(buildVariantMedia("video", raw)).toMatchObject({ fps: 24000 / 1001 });
  });

  it("falls back to the stream's duration when the container declares none", () => {
    const raw = { streams: [audioStream({ duration: "3.25" })] };
    expect(buildVariantMedia("audio", raw)).toEqual({
      kind: "audio",
      durationSec: 3.25,
      channels: 2,
      sampleRate: 48000,
    });
  });

  it("drops the whole record when a promised field is unreadable", () => {
    const noFps = {
      format: { duration: "5.5" },
      streams: [videoStream({ avg_frame_rate: "0/0", r_frame_rate: "N/A" })],
    };
    const noDuration = { streams: [videoStream()] };
    const noDimensions = { format: { duration: "5.5" }, streams: [audioStream()] };
    const noRate = { format: { duration: "3.0" }, streams: [audioStream({ sample_rate: "N/A" })] };
    expect(buildVariantMedia("video", noFps)).toBeNull();
    expect(buildVariantMedia("video", noDuration)).toBeNull();
    expect(buildVariantMedia("video", noDimensions)).toBeNull();
    expect(buildVariantMedia("audio", noRate)).toBeNull();
    expect(buildVariantMedia("image", { streams: [] })).toBeNull();
    expect(buildVariantMedia("audio", {})).toBeNull();
  });

  it("drops a video whose audio stream is there but unreadable", () => {
    const raw = {
      format: { duration: "5.5" },
      streams: [videoStream(), audioStream({ channels: 0 })],
    };
    expect(buildVariantMedia("video", raw)).toBeNull();
  });
});

describe("probeMediaInfo", () => {
  it("spawns nothing for a path konte does not read as media", async () => {
    const { probeMediaInfo: real } =
      await vi.importActual<typeof import("../video-probe.js")>("../video-probe.js");
    await expect(real("/nowhere/notes.txt")).resolves.toBeNull();
  });
});

describe("ensureVariantMedia", () => {
  const wav: VariantMedia = { kind: "audio", durationSec: 5, channels: 1, sampleRate: 24000 };
  const variant = (over: Partial<VariantState> = {}): VariantState =>
    ({
      status: "none",
      file: "assets/vo.wav",
      definitionHash: null,
      outputHash: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      inputFingerprints: {},
      metadata: {},
      ...over,
    }) as VariantState;

  beforeEach(() => {
    probe.probeMediaInfo.mockReset().mockResolvedValue(wav);
  });

  it("serves the record without probing", async () => {
    const v = variant({ media: wav });
    await expect(ensureVariantMedia(v, "/video")).resolves.toEqual(wav);
    expect(probeMediaInfo).not.toHaveBeenCalled();
  });

  it("measures once when the record is missing, then serves it", async () => {
    const v = variant();
    await expect(ensureVariantMedia(v, "/video")).resolves.toEqual(wav);
    expect(v.media).toEqual(wav);
    await ensureVariantMedia(v, "/video");
    expect(probeMediaInfo).toHaveBeenCalledTimes(1);
    expect(probeMediaInfo).toHaveBeenCalledWith("/video/assets/vo.wav");
  });

  it("records nothing for a failed measurement, so a later read tries again", async () => {
    probe.probeMediaInfo.mockResolvedValue(null);
    const v = variant();
    await expect(ensureVariantMedia(v, "/video")).resolves.toBeNull();
    expect(v.media).toBeUndefined();
    await ensureVariantMedia(v, "/video");
    expect(probeMediaInfo).toHaveBeenCalledTimes(2);
  });

  it("has nothing to measure for a variant with no file", async () => {
    await expect(ensureVariantMedia(variant({ file: null }), "/video")).resolves.toBeNull();
    await expect(ensureVariantMedia(undefined, "/video")).resolves.toBeNull();
    expect(probeMediaInfo).not.toHaveBeenCalled();
  });
});

describe("mediaByFile", () => {
  it("keys the records by absolute file, skipping the unmeasured", async () => {
    const wav: VariantMedia = { kind: "audio", durationSec: 5, channels: 1, sampleRate: 24000 };
    const state = {
      assets: {
        "video:shot.01.vo": {
          variants: {
            "v-1": { file: "assets/vo.wav", media: wav },
            "v-2": { file: "assets/other.wav" },
            "v-3": { file: null },
          },
        },
      },
    } as unknown as Parameters<typeof mediaByFile>[0];

    const byFile = mediaByFile(state, "/video");
    expect(byFile.get("/video/assets/vo.wav")).toEqual(wav);
    expect(byFile.has("/video/assets/other.wav")).toBe(false);
    expect(mediaDurationSec(byFile.get("/video/assets/vo.wav") ?? null)).toBe(5);
  });
});
