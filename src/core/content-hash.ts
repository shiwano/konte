import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { stableStringify } from "./stable-stringify.js";

export function sha256Hex(...parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

// The full sha256 of a value's stable JSON form.
export function stableHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

// The 12-hex prefix konte uses as a definition/content key.
export function shortHash(value: unknown, length = 12): string {
  return stableHash(value).slice(0, length);
}

export async function hashFile(absPath: string): Promise<string> {
  return sha256Hex(await fs.readFile(absPath));
}
