// Readers over the HTML konte's own renderer emits: every attribute double-quoted, one opening tag
// per element.

const OPEN_TAG = /<([a-z][a-z0-9-]*)\b[^>]*>/gi;

export function attrOf(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

// A number from a prop: a finite parse, else null.
export function toNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value !== "") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// An attribute read as a number the way the runtime reads it (`Number`); null when absent, empty or
// not finite.
export function numAttr(tag: string, name: string): number | null {
  const value = attrOf(tag, name);
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The tag with `name` set to `value`: replaced where it stands, else added at the tag's end.
export function setAttr(tag: string, name: string, value: string | number): string {
  const set = ` ${name}="${value}"`;
  const existing = new RegExp(`\\s${name}="[^"]*"`);
  return existing.test(tag) ? tag.replace(existing, set) : tag.replace(/\s*(\/?)>$/, `${set}$1>`);
}

export interface TimedElement {
  tag: string;
  index: number;
  start: number;
  // Null when the element names no window end.
  duration: number | null;
}

// Every opening tag with a numeric `data-start`, of element `name` when given, in document order.
export function timedElements(html: string, name?: string): TimedElement[] {
  const out: TimedElement[] = [];
  for (const m of html.matchAll(OPEN_TAG)) {
    if (name !== undefined && m[1]!.toLowerCase() !== name) continue;
    const start = numAttr(m[0], "data-start");
    if (start === null) continue;
    out.push({ tag: m[0], index: m.index, start, duration: numAttr(m[0], "data-duration") });
  }
  return out;
}

// `html` with every opening tag carrying a numeric `data-start` passed through `fn`.
export function replaceTimedElements(html: string, fn: (el: TimedElement) => string): string {
  return html.replace(OPEN_TAG, (tag: string, _name: string, index: number) => {
    const start = numAttr(tag, "data-start");
    if (start === null) return tag;
    return fn({ tag, index, start, duration: numAttr(tag, "data-duration") });
  });
}
