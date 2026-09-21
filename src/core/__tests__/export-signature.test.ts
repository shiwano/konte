import { describe, expect, it } from "vitest";
import { computeExportPlanDigest, computeExportSignature } from "../export-signature.js";
import type { VideoDefinition } from "../types/index.js";

function makeVideo(over: Partial<VideoDefinition> = {}): VideoDefinition {
  return {
    format: { fps: 24, size: { width: 100, height: 100 } },
    shots: [{ id: "01", duration: 2, action: "i", assets: {}, shotFn: () => null }],
    ...over,
  } as unknown as VideoDefinition;
}

describe("computeExportSignature", () => {
  it("is stable for an unchanged definition", () => {
    expect(computeExportSignature(makeVideo())).toBe(computeExportSignature(makeVideo()));
  });

  it("changes when a shot render fn changes (picture or per-shot audio)", () => {
    const a = makeVideo({
      shots: [{ id: "01", duration: 2, action: "i", assets: {}, shotFn: () => null }],
    } as unknown as Partial<VideoDefinition>);
    const b = makeVideo({
      shots: [{ id: "01", duration: 2, action: "i", assets: {}, shotFn: () => "edited" }],
    } as unknown as Partial<VideoDefinition>);
    expect(computeExportSignature(a)).not.toBe(computeExportSignature(b));
  });

  it("changes when a timeline soundtrack changes", () => {
    const a = makeVideo();
    const b = makeVideo({
      timelineSoundtracks: [
        {
          __soundtrackEntry: true,
          id: "bgm",
          src: { src: "__konte:reference:bgm__" },
          options: {},
        },
      ],
    } as unknown as Partial<VideoDefinition>);
    expect(computeExportSignature(a)).not.toBe(computeExportSignature(b));
  });

  it("changes when the delivery config changes", () => {
    const a = makeVideo();
    const b = makeVideo({
      export: { delivery: { size: { width: 200, height: 200 } } },
    } as unknown as Partial<VideoDefinition>);
    expect(computeExportSignature(a)).not.toBe(computeExportSignature(b));
  });
});

describe("computeExportPlanDigest", () => {
  it("is stable for an unchanged definition and covers the signature", () => {
    expect(computeExportPlanDigest(makeVideo())).toBe(computeExportPlanDigest(makeVideo()));
    const edited = makeVideo({
      shots: [{ id: "01", duration: 2, action: "i", assets: {}, shotFn: () => "edited" }],
    } as unknown as Partial<VideoDefinition>);
    expect(computeExportPlanDigest(makeVideo())).not.toBe(computeExportPlanDigest(edited));
  });

  it("changes when the direction hands a shot a different length", () => {
    const fn = () => null;
    const a = makeVideo({
      shots: [{ id: "01", duration: 1, action: "i", assets: {}, shotFn: fn }],
    } as unknown as Partial<VideoDefinition>);
    const b = makeVideo({
      shots: [{ id: "01", duration: 1.5, action: "i", assets: {}, shotFn: fn }],
    } as unknown as Partial<VideoDefinition>);
    expect(computeExportSignature(a)).toBe(computeExportSignature(b));
    expect(computeExportPlanDigest(a)).not.toBe(computeExportPlanDigest(b));
  });
});
