import { describe, expect, it } from "vitest";
import { parseRect, resolveRect } from "../crop.js";

const size = { width: 1280, height: 2770 };

describe("probe crop --rect", () => {
  it("takes source pixels as given", () => {
    expect(resolveRect(parseRect("0,480,1760,440", 0), size)).toEqual({
      label: "1",
      x: 0,
      y: 480,
      width: 1760,
      height: 440,
    });
  });

  it("reads a percent off the width for x and width, the height for y and height", () => {
    expect(resolveRect(parseRect("4%,23.6%,92%,9%", 1), size)).toEqual({
      label: "2",
      x: 51,
      y: 654,
      width: 1178,
      height: 249,
      percent: "4%,23.6%,92%,9%",
    });
  });

  it("refuses a fractional pixel, a missing component and a window with no area", () => {
    expect(() => parseRect("0,0.5,10,10", 0)).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" }),
    );
    expect(() => parseRect("0,0,10", 0)).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" }),
    );
    expect(() => resolveRect(parseRect("0,0,0.01%,10", 0), size)).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" }),
    );
  });
});
