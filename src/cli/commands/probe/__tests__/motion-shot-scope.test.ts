import { describe, expect, it } from "vitest";
import type { StateManager } from "../../../../core/state/index.js";
import type { AnimaticDefinition, VideoDefinition } from "../../../../core/types/index.js";
import { shotScopeComposition } from "../motion.js";

const shotFn = () => null;

const stages = {
  video: { stage: "video", shots: [{ id: "01", shotFn }] } as unknown as VideoDefinition,
  animatic: {
    stage: "animatic",
    shots: [
      { id: "03", shotFn },
      { id: "04", aside: true },
    ],
  } as unknown as AnimaticDefinition,
};

function manager(assets: Record<string, string>): StateManager {
  return {
    getState: () => ({ assets: Object.fromEntries(Object.keys(assets).map((a) => [a, {}])) }),
    resolveReference: (address: string) =>
      assets[address] ? { variantId: `v-${address}`, file: assets[address] } : null,
    stalenessView: () => ({ readyUndecided: () => [] }),
  } as unknown as StateManager;
}

describe("shotScopeComposition", () => {
  it("reads a shot scope with no video take as that shot's composition", () => {
    const m = manager({ "animatic:shot.03.first": "a.png" });
    expect(shotScopeComposition(stages, m, "animatic:shot.03")).toBe(
      "animatic:shot.03#composition",
    );
  });

  it("keeps a shot scope that sweeps a video take", () => {
    const m = manager({ "video:shot.01.motion": "m.mp4" });
    expect(shotScopeComposition(stages, m, "video:shot.01")).toBeNull();
  });

  it("keeps a shot with no composition to draw", () => {
    expect(shotScopeComposition(stages, manager({}), "animatic:shot.04")).toBeNull();
  });

  it("leaves stage scopes, addresses and variant ids alone", () => {
    const m = manager({});
    for (const target of ["animatic", "animatic:shot.03.first", "v-abc"]) {
      expect(shotScopeComposition(stages, m, target)).toBeNull();
    }
  });
});
