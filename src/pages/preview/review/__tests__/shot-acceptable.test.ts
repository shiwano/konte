import { describe, expect, it } from "vitest";
import { reelAcceptUnits, shotAcceptable } from "../shot-acceptable.js";

describe("shotAcceptable", () => {
  it("takes a developed shot showing its own picture", () => {
    expect(shotAcceptable({ pending: false })).toBe(true);
    expect(shotAcceptable({ pending: false, showingStandIn: false })).toBe(true);
  });

  it("refuses an undeveloped shot", () => {
    expect(shotAcceptable({ pending: true })).toBe(false);
  });

  it("refuses a shot standing in with its board frame", () => {
    // The bulk paths — Accept all, the `A` shortcut — reach no disabled button, so this is what
    // keeps a mark off a shot whose delivered picture the reviewer never watched.
    expect(shotAcceptable({ pending: false, showingStandIn: true })).toBe(false);
  });

  it("refuses a shot whose shown half plays a not-ready track", () => {
    expect(shotAcceptable({ pending: false, notReady: true })).toBe(false);
  });
});

describe("reelAcceptUnits", () => {
  const shot = (shotId: string, o = {}) => ({ shotId, pending: false, ...o });

  it("covers the acceptable shots and leaves out the rest", () => {
    expect(reelAcceptUnits([shot("01"), shot("02", { pending: true }), shot("03")], false)).toEqual(
      [
        { kind: "shot", shotId: "01" },
        { kind: "shot", shotId: "03" },
      ],
    );
  });

  // The second bug this file's caller shipped: reading "is there anything here to accept" off the
  // shots alone left a board of undeveloped shots with a soundtrack unable to ever read done,
  // however many times Accept all was pressed. The beds are a unit, not a clause beside them.
  it("offers the beds on a board where every shot is still undeveloped", () => {
    expect(reelAcceptUnits([shot("01", { pending: true })], true)).toEqual([{ kind: "stem" }]);
    expect(reelAcceptUnits([], true)).toEqual([{ kind: "stem" }]);
    expect(reelAcceptUnits([shot("01", { pending: true })], false)).toEqual([]);
  });
});
