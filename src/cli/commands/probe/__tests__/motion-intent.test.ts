import { describe, expect, it } from "vitest";
import type { Direction } from "../../../../core/dsl/direction.js";
import { shotBoundaries } from "../motion-intent.js";

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
    });
    expect(boundaries.get("04")).toEqual({ join: "jump-forward", location: null });
    expect(boundaries.get("05")).toEqual({
      join: "jump-back",
      location: { from: "street", to: "kitchen" },
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
});
