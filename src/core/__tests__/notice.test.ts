import { describe, expect, it } from "vitest";
import { formatNotice } from "../notice.js";

describe("formatNotice", () => {
  it("renders a NOTICE header with indented detail lines", () => {
    expect(formatNotice("something will happen:", ["first", "second"])).toBe(
      "NOTICE: something will happen:\n  first\n  second",
    );
  });

  it("renders just the header when there are no detail lines", () => {
    expect(formatNotice("nothing else", [])).toBe("NOTICE: nothing else");
  });
});
