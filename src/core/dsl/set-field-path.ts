// Assign a value into `target` at a dotted `field` path, creating intermediate
// objects as needed (`"audio_setting.format"` → `target.audio_setting.format`).
// A path without a dot is a plain top-level key. Used by the FAL
// adapter builders so an input can target a nested provider field; the backends'
// input preparation recurses into nested objects, so a placeholder/seed at a
// nested path is resolved the same as a top-level one.
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function setFieldPath(target: Record<string, unknown>, field: string, value: unknown): void {
  const parts = field.split(".");
  for (const part of parts) {
    // Guard against prototype pollution: a path like "__proto__.x" must never
    // reach Object.prototype.
    if (FORBIDDEN_SEGMENTS.has(part)) {
      throw new Error(`Illegal field path segment "${part}" in "${field}"`);
    }
  }
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (next === undefined) {
      cursor[part] = {};
    } else if (!isPlainObject(next)) {
      throw new Error(`Cannot set nested field "${field}": "${part}" is not a plain object`);
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}
