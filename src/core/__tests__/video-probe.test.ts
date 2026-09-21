import { describe, expect, it } from "vitest";
import {
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

describe("narrow probes on an unprobeable file", () => {
  const missing = "/nonexistent/konte-probe-test.mp4";

  it("report absence rather than a value", async () => {
    expect(await probeVideoDimensions(missing)).toBeNull();
    expect(await probeMediaDuration(missing)).toBeNull();
    expect(await probeHasAudio(missing)).toBe(false);
  });
});
