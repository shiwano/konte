import { describe, expect, it } from "vitest";
import type { Direction } from "../../../../core/dsl/direction.js";
import { formatMotionIntent, shotBoundaries } from "../motion-intent.js";

const shot = (id: string, setup: string, extra: Record<string, unknown> = {}) => ({
  id,
  role: "ordinary",
  action: `shot ${id}`,
  duration: 2,
  setup,
  lineup: [],
  ...extra,
});

const direction = (shots: unknown[]): Direction =>
  ({
    setups: {
      wide: { name: "wide", location: "kitchen", framing: "wide" },
      close: { name: "close", location: "kitchen", framing: "close-up" },
      street: { name: "street", location: "street", framing: "wide" },
    },
    sequence: { shots },
  }) as unknown as Direction;

describe("shotBoundaries", () => {
  it("names a declared join and a change of location, and nothing for an ordinary boundary", () => {
    const boundaries = shotBoundaries(
      direction([
        shot("01", "wide"),
        shot("02", "close"),
        shot("03", "street"),
        shot("04", "street", { join: "jump-forward" }),
        shot("05", "wide", { join: "jump-back" }),
      ]),
    );

    expect([...boundaries.keys()]).toEqual(["03", "04", "05"]);
    expect(boundaries.get("03")).toEqual({
      join: null,
      location: { from: "kitchen", to: "street" },
      returns: null,
    });
    expect(boundaries.get("04")).toEqual({
      join: "jump-forward",
      location: null,
      returns: null,
    });
    expect(boundaries.get("05")).toEqual({
      join: "jump-back",
      location: { from: "street", to: "kitchen" },
      returns: null,
    });
  });

  it("compares a place only against the shot just before, and a graphic shot stands nowhere", () => {
    const boundaries = shotBoundaries(
      direction([
        shot("01", "wide"),
        { kind: "graphic", id: "02", role: "ordinary", action: "a card", duration: 2 },
        shot("03", "street"),
      ]),
    );

    expect(boundaries.size).toBe(0);
  });

  it("names the shot a frame cuts back to across a cutaway, and the seconds since", () => {
    const boundaries = shotBoundaries({
      ...direction([
        shot("01", "wide", { lineup: ["ann"] }),
        shot("02", "close", { lineup: ["bo"] }),
        shot("03", "wide", { lineup: ["ann"] }),
      ]),
      policy: { format: { fps: 24 } },
    } as unknown as Direction);

    expect(boundaries.get("03")).toEqual({
      join: null,
      location: null,
      returns: { from: "01", setup: "wide", gap: 2 },
    });
  });
});

describe("formatMotionIntent", () => {
  it("prints hinges with set membership, passers and who stands out of frame beside the action", () => {
    expect(
      formatMotionIntent({
        shotId: "01",
        action: "cross a gap",
        boundary: null,
        moves: [],
        frames: [
          {
            lane: "main",
            hinge: [
              { name: "gap", notInSet: true },
              { name: "bun", notInSet: false },
            ],
            passing: ["crow (crow)"],
            offscreen: "fox (fox) screen left",
          },
        ],
      }),
    ).toEqual([
      "  action    cross a gap",
      "  passing   crow (crow)",
      "  offscreen fox (fox) screen left",
      "  hinge     gap (not in set) | bun",
    ]);
  });

  it("prints the shot a frame returns to", () => {
    expect(
      formatMotionIntent({
        shotId: "60",
        action: null,
        boundary: {
          join: null,
          location: null,
          returns: { from: "56", setup: "watsonMedium", gap: 8.42 },
        },
        moves: [],
      }),
    ).toEqual(["  returns   from 56 (watsonMedium, 8.4s ago)"]);
  });

  it("marks a coverage shot, whose picture cuts by design", () => {
    expect(
      formatMotionIntent({
        shotId: "01",
        action: "they trade blows",
        boundary: null,
        coverage: true,
        moves: [],
      }),
    ).toEqual([
      "  action    they trade blows",
      "  coverage  one take the model cuts inside from the opening panel",
    ]);
  });
});
