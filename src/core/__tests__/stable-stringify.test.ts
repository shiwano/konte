import { describe, expect, it } from "vitest";
import { stableStringify } from "../stable-stringify.js";

describe("stableStringify", () => {
  it("sorts object keys deterministically", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("omits keys whose value is undefined (JSON-compliant)", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    // The hash of an object with an undefined field equals that of the object without it.
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("produces valid JSON that round-trips", () => {
    const value = { a: 1, b: undefined, c: [1, 2], d: { e: undefined, f: "x" } };
    const s = stableStringify(value);
    expect(() => JSON.parse(s)).not.toThrow();
    expect(JSON.parse(s)).toEqual({ a: 1, c: [1, 2], d: { f: "x" } });
  });

  it("matches JSON.stringify for arrays with undefined/null elements", () => {
    expect(stableStringify([1, undefined, null, 2])).toBe(JSON.stringify([1, undefined, null, 2]));
    expect(stableStringify([undefined])).toBe("[null]");
  });

  it("renders sparse-array holes as null (valid JSON)", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 2];
    expect(stableStringify(sparse)).toBe(JSON.stringify(sparse));
    expect(stableStringify(sparse)).toBe("[1,null,2]");
    expect(() => JSON.parse(stableStringify(sparse))).not.toThrow();
  });

  it("serializes primitives and null", () => {
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("null");
  });

  it("handles nested structures with stable ordering", () => {
    const a = stableStringify({ z: { b: 2, a: 1 }, y: [3, 2, 1] });
    const b = stableStringify({ y: [3, 2, 1], z: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });
});
