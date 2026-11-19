import { afterEach, describe, expect, it, vi } from "vitest";
import * as loader from "../../core/loader.js";
import type { Direction } from "../../core/dsl/direction.js";
import type { AnimaticDefinition, VideoDefinition } from "../../core/types/index.js";
import { stagingStageState } from "../../core/board-analysis.js";
import { createMotionIntentLoader, formatMotionIntent } from "../commands/probe/motion-intent.js";
import type { StateManager } from "../../core/state/index.js";
import { directionDefaults } from "../../core/__tests__/helpers/direction.js";

vi.mock("../../core/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/loader.js")>()),
  loadAnimatic: vi.fn(),
  loadIfPresent: vi.fn(),
  loadVideoDefinition: vi.fn(),
}));

const board = { shots: [], topLevelAssets: {} } as unknown as AnimaticDefinition;
afterEach(() => vi.resetAllMocks());

describe("passing stage", () => {
  it("reads passers off the video only where a frame passes one", () => {
    const video = { shots: [], topLevelAssets: {} } as unknown as VideoDefinition;
    const shot = {
      id: "01",
      role: "ordinary",
      action: "a crow crosses",
      setup: "front",
      duration: 2,
      lineup: [],
    };
    const direction = {
      ...directionDefaults,
      sequence: { lens: "mini-drama", pleasure: "cute", shots: [shot] },
    } as Direction;
    const staging = (d: Direction) => stagingStageState(d, board, video);
    expect(staging(direction).videoPassers).toBeUndefined();
    direction.sequence.shots = [{ ...shot, passing: ["crow"] }];
    expect(staging(direction).videoPassers).toEqual([]);
    direction.sequence.shots = [
      { ...shot, cutin: { setup: "front", lineup: [], passing: ["crow"] } },
    ];
    expect(staging(direction).videoPassers).toEqual([]);
  });
});

describe("motion intent lanes", () => {
  it("keeps a cutin passer and its hinge apart from the main frame", async () => {
    const direction = {
      ...directionDefaults,
      characters: { crow: { name: "crow", promptDepiction: "black crow", description: "a crow" } },
      setups: {
        ...directionDefaults.setups,
        close: { ...directionDefaults.setups.front!, framing: "insert", holds: [] },
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "crow crosses the desk",
            duration: 2,
            setup: "front",
            lineup: ["crow"],
            cutin: { setup: "close", lineup: [], passing: ["crow"] },
          },
        ],
      },
    } as Direction;
    vi.mocked(loader.loadIfPresent).mockResolvedValue(direction);
    vi.mocked(loader.loadAnimatic).mockResolvedValue(board);
    const intent = await createMotionIntentLoader(
      "/tmp/first-pass",
      {} as StateManager,
    )("video:shot.01.motion");
    expect(intent?.frames).toEqual([
      {
        lane: "main",
        passing: [],
        offscreen: null,
        hinge: [{ name: "the desk", notInSet: false }],
      },
      {
        lane: "cutin",
        passing: ["crow (crow)"],
        offscreen: null,
        hinge: [{ name: "the desk", notInSet: true }],
      },
    ]);
    expect(formatMotionIntent(intent!)).toEqual([
      "  action    crow crosses the desk",
      "  hinge (main) the desk",
      "  passing (cutin) crow (crow)",
      "  hinge (cutin) the desk (not in set)",
    ]);
  });
});
