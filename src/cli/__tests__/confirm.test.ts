import { describe, expect, it } from "vitest";
import { rerunWithYes, shellQuote } from "../confirm.js";

describe("shellQuote", () => {
  it("leaves a word of safe characters bare", () => {
    expect(shellQuote("video:shot.01#stem")).toBe("video:shot.01#stem");
    expect(shellQuote("--cwd=./videos/a")).toBe("--cwd=./videos/a");
  });

  it("single-quotes an argument with spaces or quotes", () => {
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
  });
});

describe("rerunWithYes", () => {
  it("repeats the invocation with --yes appended", () => {
    expect(rerunWithYes(["dismiss", "v-abc", "v-def"])).toBe("konte dismiss v-abc v-def --yes");
    expect(rerunWithYes(["feedback", "delete", "a b"])).toBe("konte feedback delete 'a b' --yes");
  });
});
