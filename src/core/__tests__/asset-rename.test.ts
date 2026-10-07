import { describe, expect, it } from "vitest";
import { renameAddressText, renameMoves } from "../asset-rename.js";

describe("renameMoves", () => {
  it("carries the #delivery derivative of a shot or timeline asset", () => {
    expect([...renameMoves("video:shot.01.a", "video:shot.01.b")]).toEqual([
      ["video:shot.01.a", "video:shot.01.b"],
      ["video:shot.01.a#delivery", "video:shot.01.b#delivery"],
    ]);
    expect(renameMoves("video:timeline.a", "video:timeline.b").size).toBe(2);
  });

  it("adds no derivative to an address that has none", () => {
    expect([...renameMoves("animatic:plate.x", "animatic:plate.y")]).toEqual([
      ["animatic:plate.x", "animatic:plate.y"],
    ]);
    expect([...renameMoves("reference:x", "reference:y")]).toEqual([
      ["reference:x", "reference:y"],
    ]);
  });
});

describe("renameAddressText", () => {
  const moves = renameMoves("video:shot.01.a", "video:shot.01.b");

  it("renames placeholders inside strings and bare addresses, leaving longer names alone", () => {
    expect(
      renameAddressText(
        {
          html: '<video src="__konte:video:shot.01.a__"></video><img src="__konte:video:shot.01.a_x__">',
          src: "video:shot.01.a",
          other: "video:shot.01.ab",
          list: ["__konte:video:shot.01.a#delivery__"],
        },
        moves,
      ),
    ).toEqual({
      html: '<video src="__konte:video:shot.01.b__"></video><img src="__konte:video:shot.01.a_x__">',
      src: "video:shot.01.b",
      other: "video:shot.01.ab",
      list: ["__konte:video:shot.01.b#delivery__"],
    });
  });

  it("renames an object key that is a moved address", () => {
    expect(renameAddressText({ kinds: { "video:shot.01.a": "sfx", other: "x" } }, moves)).toEqual({
      kinds: { "video:shot.01.b": "sfx", other: "x" },
    });
  });
});
