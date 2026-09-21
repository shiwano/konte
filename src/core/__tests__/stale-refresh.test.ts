import { describe, expect, it } from "vitest";
import { plateFork } from "../stale-refresh.js";

describe("plateFork", () => {
  const cascadeOf = (...paths: string[]) => paths.map((assetPath) => ({ assetPath }));

  it("names the setup and every shot standing on the plate", () => {
    expect(
      plateFork(
        "animatic:plate.deckLow",
        cascadeOf("animatic:shot.06.first", "animatic:shot.22.first", "animatic:shot.06.last"),
      ),
    ).toEqual({ setupId: "deckLow", shotIds: ["06", "22"] });
  });

  it("is null for a plate one shot alone stands on — nothing is shared", () => {
    expect(plateFork("animatic:plate.deckLow", cascadeOf("animatic:shot.06.first"))).toBeNull();
  });

  // An intermediate is filed under no setup, so there is none to fork.
  it("is null for an intermediate the plates are built from", () => {
    expect(
      plateFork(
        "animatic:plate.master",
        cascadeOf("animatic:shot.06.first", "animatic:shot.07.first"),
        { shots: [], plates: {}, exposedPlateIds: ["deckLow"] },
      ),
    ).toBeNull();
  });

  it("is null for an address that is not a plate", () => {
    expect(
      plateFork(
        "animatic:shot.06.first",
        cascadeOf("animatic:shot.06.last", "video:shot.06.motion"),
      ),
    ).toBeNull();
  });
});
