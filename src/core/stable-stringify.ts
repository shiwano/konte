export function stableStringify(value: unknown): string {
  // `JSON.stringify(undefined)` returns the value `undefined`, not a string; guard
  // it so a bare/array `undefined` never leaks the literal token "undefined".
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Array holes and `undefined` elements serialize as `null`, matching JSON.stringify.
    // `Array.from` visits every index 0..length-1 (holes surface as `undefined`), whereas
    // `.map` would skip holes and leave an invalid `[1,,2]`.
    return `[${Array.from(value, (v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries: string[] = [];
  for (const k of keys) {
    // Match JSON.stringify: a key whose value is `undefined` is omitted, so the
    // hash of `{a: 1, b: undefined}` equals that of `{a: 1}` and stays valid JSON.
    if (record[k] === undefined) continue;
    entries.push(`${JSON.stringify(k)}:${stableStringify(record[k])}`);
  }
  return `{${entries.join(",")}}`;
}
