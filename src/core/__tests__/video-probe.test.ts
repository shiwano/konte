import { describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import {
  parseVideoProbe,
  pickVideoFps,
  probeHasAudio,
  probeMediaDuration,
  probeVideoDimensions,
} from "../video-probe.js";

describe("pickVideoFps", () => {
  it("reports the average rate, not the timebase tick rate", () => {
    expect(pickVideoFps({ avg_frame_rate: "2384/100", r_frame_rate: "48/1" })).toBeCloseTo(23.84);
  });

  it("reduces a rational average", () => {
    expect(pickVideoFps({ avg_frame_rate: "24000/1001", r_frame_rate: "24000/1001" })).toBeCloseTo(
      23.976,
      3,
    );
  });

  it("falls back to the tick rate when the average is unknown", () => {
    expect(pickVideoFps({ avg_frame_rate: "0/0", r_frame_rate: "24/1" })).toBe(24);
    expect(pickVideoFps({ r_frame_rate: "24/1" })).toBe(24);
  });

  it("returns null when neither rate is usable", () => {
    expect(pickVideoFps({ avg_frame_rate: "0/0", r_frame_rate: "0/0" })).toBeNull();
    expect(pickVideoFps({ avg_frame_rate: "N/A" })).toBeNull();
    expect(pickVideoFps({})).toBeNull();
  });
});

describe("parseVideoProbe", () => {
  it("parses video stream metadata", () => {
    const output = {
      streams: [
        {
          codec_type: "video",
          width: 1920,
          height: 1080,
          r_frame_rate: "30/1",
          duration: "5.0",
        },
      ],
      format: {
        duration: "5.0",
      },
    };

    const result = parseVideoProbe(output);
    expect(result).toEqual({
      duration: 5.0,
      videoDuration: 5.0,
      width: 1920,
      height: 1080,
      fps: 30,
      pixFmt: null,
      bitsPerRawSample: null,
    });
  });

  it("reports the video stream's own duration separately from the container's", () => {
    const output = {
      streams: [
        {
          codec_type: "video",
          width: 768,
          height: 1344,
          r_frame_rate: "24/1",
          duration: "3.041667",
        },
        { codec_type: "audio", duration: "3.042" },
      ],
      format: { duration: "3.042" },
    };

    const result = parseVideoProbe(output);
    expect(result.duration).toBe(3.042);
    expect(result.videoDuration).toBe(3.041667);
  });

  it("falls back to the container duration when the video stream declares none", () => {
    const output = {
      streams: [{ codec_type: "video", width: 640, height: 480, r_frame_rate: "25/1" }],
      format: { duration: "4.5" },
    };

    expect(parseVideoProbe(output).videoDuration).toBe(4.5);
  });

  it("reads an unknown duration as 0 rather than NaN", () => {
    const output = {
      streams: [
        { codec_type: "video", width: 640, height: 480, r_frame_rate: "25/1", duration: "N/A" },
      ],
      format: { duration: "N/A" },
    };

    const result = parseVideoProbe(output);
    expect(result.duration).toBe(0);
    expect(result.videoDuration).toBe(0);
  });

  it("handles fractional fps", () => {
    const output = {
      streams: [
        {
          codec_type: "video",
          width: 1280,
          height: 720,
          r_frame_rate: "24000/1001",
        },
      ],
      format: { duration: "10.5" },
    };

    const result = parseVideoProbe(output);
    expect(result.fps).toBeCloseTo(23.976, 2);
  });

  it("uses format duration over stream duration", () => {
    const output = {
      streams: [
        {
          codec_type: "video",
          width: 640,
          height: 480,
          r_frame_rate: "25/1",
          duration: "3.0",
        },
      ],
      format: { duration: "4.5" },
    };

    const result = parseVideoProbe(output);
    expect(result.duration).toBe(4.5);
  });

  it("falls back to stream duration when format duration is missing", () => {
    const output = {
      streams: [
        {
          codec_type: "video",
          width: 640,
          height: 480,
          r_frame_rate: "25/1",
          duration: "3.0",
        },
      ],
      format: {},
    };

    const result = parseVideoProbe(output);
    expect(result.duration).toBe(3.0);
  });

  it("throws when no video stream is found", () => {
    const output = {
      streams: [{ codec_type: "audio" }],
      format: { duration: "5.0" },
    };

    expect(() => parseVideoProbe(output)).toThrow(KonteError);
  });

  it("reads the average rate over the timebase tick rate", () => {
    const output = {
      streams: [
        {
          codec_type: "video",
          width: 1280,
          height: 720,
          avg_frame_rate: "24/1",
          r_frame_rate: "48/1",
        },
      ],
      format: { duration: "2.0" },
    };

    expect(parseVideoProbe(output).fps).toBe(24);
  });

  it("falls back to the stream duration when the container's is N/A", () => {
    const output = {
      streams: [{ codec_type: "video", width: 640, height: 480, duration: "3.0" }],
      format: { duration: "N/A" },
    };

    expect(parseVideoProbe(output).duration).toBe(3.0);
  });

  it("reads the pixel format for the keyframe normalizer", () => {
    const output = {
      streams: [
        {
          codec_type: "video",
          width: 640,
          height: 480,
          pix_fmt: "YUV420P10LE",
          bits_per_raw_sample: "10",
        },
      ],
      format: { duration: "1.0" },
    };

    expect(parseVideoProbe(output)).toMatchObject({ pixFmt: "yuv420p10le", bitsPerRawSample: 10 });
  });

  it("handles missing r_frame_rate gracefully", () => {
    const output = {
      streams: [
        {
          codec_type: "video",
          width: 1920,
          height: 1080,
        },
      ],
      format: { duration: "2.0" },
    };

    const result = parseVideoProbe(output);
    expect(result.fps).toBe(30);
  });
});

describe("narrow probes on an unprobeable file", () => {
  const missing = "/nonexistent/konte-probe-test.mp4";

  it("report absence rather than a value", async () => {
    expect(await probeVideoDimensions(missing)).toBeNull();
    expect(await probeMediaDuration(missing)).toBeNull();
    expect(await probeHasAudio(missing)).toBe(false);
  });
});
