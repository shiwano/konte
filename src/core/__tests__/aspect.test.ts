import { describe, expect, it } from "vitest";
import { ratioOf, sameAspect } from "../aspect.js";

describe("ratioOf", () => {
  it("reduces a size to its orientation-significant aspect", () => {
    expect(ratioOf({ width: 1920, height: 1080 })).toBe("16:9");
    expect(ratioOf({ width: 640, height: 360 })).toBe("16:9");
    expect(ratioOf({ width: 1080, height: 1920 })).toBe("9:16");
    expect(ratioOf({ width: 1000, height: 1000 })).toBe("1:1");
  });
});

describe("sameAspect", () => {
  it("is true only when both sizes reduce to the same ratio", () => {
    expect(sameAspect({ width: 1280, height: 720 }, { width: 1920, height: 1080 })).toBe(true);
    expect(sameAspect({ width: 1280, height: 720 }, { width: 1080, height: 1920 })).toBe(false);
    expect(sameAspect({ width: 1000, height: 1000 }, { width: 512, height: 512 })).toBe(true);
  });
});
