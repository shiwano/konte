import { describe, expect, it } from "vitest";
import { setFieldPath } from "../dsl/set-field-path.js";

describe("setFieldPath", () => {
  it("sets a top-level key", () => {
    const target: Record<string, unknown> = {};
    setFieldPath(target, "prompt", "hi");
    expect(target).toEqual({ prompt: "hi" });
  });

  it("creates intermediate objects for a dotted path", () => {
    const target: Record<string, unknown> = {};
    setFieldPath(target, "audio_setting.format", "wav");
    expect(target).toEqual({ audio_setting: { format: "wav" } });
  });

  it("merges into an existing nested object", () => {
    const target: Record<string, unknown> = { audio_setting: { rate: 44100 } };
    setFieldPath(target, "audio_setting.format", "wav");
    expect(target).toEqual({ audio_setting: { rate: 44100, format: "wav" } });
  });

  it.each(["__proto__.polluted", "constructor.prototype.polluted", "a.prototype.x"])(
    "rejects prototype-polluting path %s",
    (field) => {
      const target: Record<string, unknown> = {};
      expect(() => setFieldPath(target, field, true)).toThrow();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it("does not pollute Object.prototype via __proto__", () => {
    const target: Record<string, unknown> = {};
    expect(() => setFieldPath(target, "__proto__", { polluted: true })).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects traversing into a non-plain-object intermediate", () => {
    const target: Record<string, unknown> = { arr: [1, 2] };
    expect(() => setFieldPath(target, "arr.0", "x")).toThrow(/not a plain object/);
  });
});
