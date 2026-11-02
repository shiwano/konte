import { describe, expect, it } from "vitest";
import { ratioOf } from "../aspect.js";

describe("ratioOf", () => {
  it("reduces a size to its orientation-significant aspect", () => {
    expect(ratioOf({ width: 1920, height: 1080 })).toBe("16:9");
    expect(ratioOf({ width: 640, height: 360 })).toBe("16:9");
    expect(ratioOf({ width: 1080, height: 1920 })).toBe("9:16");
    expect(ratioOf({ width: 1000, height: 1000 })).toBe("1:1");
  });
});
