import { describe, expect, it } from "vitest";
import { panelMoveHashes } from "../panel-move-hash.js";
import type { AnimaticDefinition } from "../types/animatic.js";

function board(
  panels: Array<{ assetPath: string; blocking?: string; camera?: string }>,
): AnimaticDefinition {
  return {
    stage: "animatic" as const,
    typography: { lang: "en" as const },
    format: { size: { width: 1280, height: 720 }, fps: 30 },
    shots: [
      {
        id: "01",
        duration: 5,
        action: "a shot",
        assets: {},
        panels: panels.map((p) => ({ assetName: "first", start: 0, duration: 1, ...p })),
      },
    ],
  };
}

const FIRST = "animatic:shot.01.first";

describe("panelMoveHashes", () => {
  it("hashes the declared movement, and only it", () => {
    const a = panelMoveHashes(board([{ assetPath: FIRST, blocking: "rises", camera: "fixed" }]));
    const same = panelMoveHashes(board([{ assetPath: FIRST, blocking: "rises", camera: "fixed" }]));
    const rewritten = panelMoveHashes(
      board([{ assetPath: FIRST, blocking: "rises and turns", camera: "fixed" }]),
    );

    expect(a.get(FIRST)).toBe(same.get(FIRST));
    expect(a.get(FIRST)).not.toBe(rewritten.get(FIRST));
  });

  it("gives a movement-less panel a hash of its own that never changes", () => {
    const landing = panelMoveHashes(board([{ assetPath: FIRST }]));
    expect(landing.get(FIRST)).toBe(panelMoveHashes(board([{ assetPath: FIRST }])).get(FIRST));
    expect(landing.get(FIRST)).not.toBe(
      panelMoveHashes(board([{ assetPath: FIRST, blocking: "rises" }])).get(FIRST),
    );
  });

  it("folds every panel resolving to one address into that address's hash", () => {
    const shared = "animatic:timeline.logo";
    const one = panelMoveHashes(board([{ assetPath: shared, blocking: "holds" }]));
    const two = panelMoveHashes(
      board([
        { assetPath: shared, blocking: "holds" },
        { assetPath: shared, blocking: "drifts" },
      ]),
    );
    expect(one.get(shared)).not.toBe(two.get(shared));
  });
});
