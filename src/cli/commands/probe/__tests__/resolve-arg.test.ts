import { describe, expect, it, vi } from "vitest";
import { KonteError } from "../../../../core/errors.js";
import type { StateManager } from "../../../../core/state/index.js";
import { resolveProbeTargets } from "../resolve-arg.js";

function fakeManager(overrides: Partial<StateManager>): StateManager {
  return overrides as unknown as StateManager;
}

describe("resolveProbeTargets", () => {
  it("passes a bare variant id through as a single, unfiltered target", () => {
    const resolveReference = vi.fn();
    const getState = vi.fn();
    const result = resolveProbeTargets(fakeManager({ resolveReference, getState }), ["v-abc123"], {
      mediaKinds: ["video"],
    });
    expect(result).toEqual({ variantIds: ["v-abc123"], multi: false });
    expect(resolveReference).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  it("resolves a full address to its canonical variant as a single target", () => {
    const resolveReference = vi
      .fn()
      .mockReturnValue({ variantId: "v-canon", file: "/x.mp4", isAccepted: true });
    const manager = fakeManager({ resolveReference });
    const result = resolveProbeTargets(manager, ["video:shot.01.motion"], {
      mediaKinds: ["video"],
    });
    expect(result).toEqual({ variantIds: ["v-canon"], multi: false });
    expect(resolveReference).toHaveBeenCalledWith("video:shot.01.motion", { includeStale: true });
  });

  it("throws VARIANT_NOT_FOUND when a full address has no ready variant", () => {
    const manager = fakeManager({ resolveReference: vi.fn().mockReturnValue(null) });
    expect(() =>
      resolveProbeTargets(manager, ["video:shot.01.motion"], { mediaKinds: ["video"] }),
    ).toThrow(KonteError);
  });

  it("rejects a malformed scope before resolving", () => {
    const resolveReference = vi.fn();
    expect(() =>
      resolveProbeTargets(fakeManager({ resolveReference }), ["video:"], { mediaKinds: ["video"] }),
    ).toThrow(KonteError);
    expect(resolveReference).not.toHaveBeenCalled();
  });

  it("sweeps a bare-stage scope, keeping only media the probe can read", () => {
    const getState = vi.fn().mockReturnValue({
      assets: {
        "video:shot.01.motion": {},
        "video:shot.01.first": {},
        "video:timeline.bgm": {},
        "animatic:shot.01.panel": {},
      },
    });
    const files: Record<string, string> = {
      "video:shot.01.motion": "/a.mp4",
      "video:shot.01.first": "/b.png",
      "video:timeline.bgm": "/c.wav",
    };
    const resolveReference = vi.fn((address: string) => {
      const file = files[address];
      return file ? { variantId: `v-${address}`, file, outputHash: null, isAccepted: true } : null;
    });
    const result = resolveProbeTargets(fakeManager({ getState, resolveReference }), ["video"], {
      mediaKinds: ["video"],
    });
    expect(result).toEqual({ variantIds: ["v-video:shot.01.motion"], multi: true });
  });

  it("narrows a bare-shot scope and admits multiple media kinds", () => {
    const getState = vi.fn().mockReturnValue({
      assets: {
        "video:shot.01.motion": {},
        "video:shot.01.first": {},
        "video:shot.02.motion": {},
      },
    });
    const files: Record<string, string> = {
      "video:shot.01.motion": "/a.mp4",
      "video:shot.01.first": "/b.png",
      "video:shot.02.motion": "/c.mp4",
    };
    const resolveReference = vi.fn((address: string) => {
      const file = files[address];
      return file ? { variantId: `v-${address}`, file, outputHash: null, isAccepted: true } : null;
    });
    const result = resolveProbeTargets(
      fakeManager({ getState, resolveReference }),
      ["video:shot.01"],
      { mediaKinds: ["video", "image"] },
    );
    expect(result).toEqual({
      variantIds: ["v-video:shot.01.first", "v-video:shot.01.motion"],
      multi: true,
    });
  });

  it("leaves patch steps out of an ordinary sweep", () => {
    const getState = vi.fn().mockReturnValue({
      assets: {
        "animatic:shot.01.first": {},
        "animatic:patch.v-src0001.flattened": {},
        "animatic:patch.v-src0001.squared": {},
      },
    });
    const resolveReference = vi.fn((address: string) => ({
      variantId: `v-${address}`,
      file: "/a.png",
      outputHash: null,
      isAccepted: true,
    }));
    const result = resolveProbeTargets(fakeManager({ getState, resolveReference }), ["animatic"], {
      mediaKinds: ["image"],
    });
    expect(result).toEqual({ variantIds: ["v-animatic:shot.01.first"], multi: true });
  });

  it("sweeps patch steps when the scope names the patch axis", () => {
    const getState = vi.fn().mockReturnValue({
      assets: {
        "animatic:shot.01.first": {},
        "animatic:patch.v-src0001.flattened": {},
        "animatic:patch.v-src0002.cropped": {},
      },
    });
    const resolveReference = vi.fn((address: string) => ({
      variantId: `v-${address}`,
      file: "/a.png",
      outputHash: null,
      isAccepted: true,
    }));
    const manager = fakeManager({ getState, resolveReference });
    expect(resolveProbeTargets(manager, ["animatic:patch"], { mediaKinds: ["image"] })).toEqual({
      variantIds: ["v-animatic:patch.v-src0001.flattened", "v-animatic:patch.v-src0002.cropped"],
      multi: true,
    });
    expect(
      resolveProbeTargets(manager, ["animatic:patch.v-src0001"], { mediaKinds: ["image"] }),
    ).toEqual({
      variantIds: ["v-animatic:patch.v-src0001.flattened"],
      multi: true,
    });
  });

  it("drops an unrecognized-extension source from a sweep", () => {
    const getState = vi.fn().mockReturnValue({
      assets: { "video:shot.01.motion": {}, "video:shot.01.blob": {} },
    });
    const files: Record<string, string> = {
      "video:shot.01.motion": "/a.mp4",
      "video:shot.01.blob": "/b.xyz",
    };
    const resolveReference = vi.fn((address: string) => {
      const file = files[address];
      return file ? { variantId: `v-${address}`, file, outputHash: null, isAccepted: true } : null;
    });
    const result = resolveProbeTargets(fakeManager({ getState, resolveReference }), ["video"], {
      mediaKinds: ["video"],
    });
    expect(result).toEqual({ variantIds: ["v-video:shot.01.motion"], multi: true });
  });

  it("concatenates several arguments in argument order and marks them multi", () => {
    const resolveReference = vi.fn((address: string) => ({
      variantId: `v-${address}`,
      file: "/a.wav",
      outputHash: null,
      isAccepted: true,
    }));
    const result = resolveProbeTargets(
      fakeManager({ resolveReference }),
      ["reference:rain", "reference:bgm"],
      { mediaKinds: ["audio"] },
    );
    expect(result).toEqual({
      variantIds: ["v-reference:rain", "v-reference:bgm"],
      multi: true,
    });
  });

  it("probes an overlapping variant once", () => {
    const getState = vi.fn().mockReturnValue({
      assets: { "reference:bgm": {}, "reference:rain": {} },
    });
    const resolveReference = vi.fn((address: string) => ({
      variantId: `v-${address}`,
      file: "/a.wav",
      outputHash: null,
      isAccepted: true,
    }));
    const result = resolveProbeTargets(
      fakeManager({ getState, resolveReference }),
      ["reference", "reference:bgm"],
      { mediaKinds: ["audio"] },
    );
    expect(result).toEqual({
      variantIds: ["v-reference:bgm", "v-reference:rain"],
      multi: true,
    });
  });

  it("fails the whole call when one of several arguments resolves to nothing", () => {
    const resolveReference = vi.fn((address: string) =>
      address === "reference:bgm"
        ? { variantId: "v-bgm", file: "/a.wav", outputHash: null, isAccepted: true }
        : null,
    );
    expect(() =>
      resolveProbeTargets(fakeManager({ resolveReference }), ["reference:bgm", "reference:rain"], {
        mediaKinds: ["audio"],
      }),
    ).toThrow(KonteError);
  });

  it("throws VARIANT_NOT_FOUND when a scope matches nothing probeable", () => {
    const getState = vi.fn().mockReturnValue({ assets: { "video:shot.01.first": {} } });
    const resolveReference = vi
      .fn()
      .mockReturnValue({ variantId: "v-1", file: "/b.png", isAccepted: true });
    expect(() =>
      resolveProbeTargets(fakeManager({ getState, resolveReference }), ["video"], {
        mediaKinds: ["video"],
      }),
    ).toThrow(KonteError);
  });
});
