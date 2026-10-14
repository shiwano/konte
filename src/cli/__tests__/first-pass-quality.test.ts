import { afterEach, describe, expect, it, vi } from "vitest";
import * as loader from "../../core/loader.js";
import type { Direction } from "../../core/dsl/direction.js";
import type { AnimaticDefinition, VideoDefinition } from "../../core/types/index.js";
import { loadStagingStageState } from "../load-definition.js";
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

describe("passing stage loading", () => {
  it("loads video only for passers or continuous seams", async () => {
    vi.mocked(loader.loadAnimatic).mockResolvedValue(board);
    const loadVideo = vi
      .mocked(loader.loadVideoDefinition)
      .mockResolvedValue({ shots: [], topLevelAssets: {} } as unknown as VideoDefinition);
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
    await loadStagingStageState("/tmp/first-pass", direction);
    expect(loadVideo).not.toHaveBeenCalled();
    direction.sequence.shots = [{ ...shot, passing: ["crow"] }];
    expect((await loadStagingStageState("/tmp/first-pass", direction))?.videoPassers).toEqual([]);
    expect(loadVideo).toHaveBeenCalledOnce();
    loadVideo.mockClear();
    direction.sequence.shots = [
      { ...shot, cutin: { setup: "front", lineup: [], passing: ["crow"] } },
    ];
    await loadStagingStageState("/tmp/first-pass", direction);
    expect(loadVideo).toHaveBeenCalledOnce();
    loadVideo.mockClear();
    direction.sequence.shots = [{ ...shot, join: "continuous" }];
    await loadStagingStageState("/tmp/first-pass", direction);
    expect(loadVideo).toHaveBeenCalledOnce();
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
      { lane: "main", passing: [], hinge: [{ name: "the desk", notInSet: false }] },
      { lane: "cutin", passing: ["crow (crow)"], hinge: [{ name: "the desk", notInSet: true }] },
    ]);
    expect(formatMotionIntent(intent!)).toEqual([
      "  action    crow crosses the desk",
      "  hinge (main) the desk",
      "  passing (cutin) crow (crow)",
      "  hinge (cutin) the desk (not in set)",
    ]);
  });
});
