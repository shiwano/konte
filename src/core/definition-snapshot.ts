import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stableStringify } from "./stable-stringify.js";
import { NON_GENERATIVE_KEYS } from "./types/definition.js";
import type { AssetDefinition } from "./types/index.js";
import { variantDir } from "./variant-dir.js";

const DEFINITION_SNAPSHOT_FILE = "definition.json";

// The definition a variant was generated from, persisted beside its output so a later
// definition-stale diff can show which definition fields changed. State keeps only the hash;
// the full definition lives here (a variant sidecar) so state.json stays lean and the
// snapshot is cleaned together with the variant. Holds unresolved `${VAR}` placeholders
// (the same object that is hashed), so no resolved secret is ever written.
export function writeDefinitionSnapshot(
  videoRoot: string,
  address: string,
  variantId: string,
  def: AssetDefinition,
): void {
  const dir = variantDir(videoRoot, address, variantId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, DEFINITION_SNAPSHOT_FILE), `${JSON.stringify(def, null, 2)}\n`);
}

export function readDefinitionSnapshot(
  videoRoot: string,
  address: string,
  variantId: string,
): AssetDefinition | null {
  const file = path.join(variantDir(videoRoot, address, variantId), DEFINITION_SNAPSHOT_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as AssetDefinition;
  } catch {
    return null;
  }
}

type DefinitionChange = { path: string; old: unknown; new: unknown };

// Field-level diff of two definitions, scoped to what the definition hash sees: both sides
// are JSON-normalized first (functions/undefined dropped, mirroring stableStringify, and every
// non-generative field cut), then walked. Objects recurse key-by-key; arrays and leaves compare
// whole (positional array diffing is noisy and the hash treats them atomically anyway).
//
// The only caller prints this to explain a definition-stale take, so a snapshot predating a
// non-generative field must not report it as a change and bury the real cause.
export function diffDefinitions(oldDef: unknown, newDef: unknown): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  walk("", normalize(oldDef), normalize(newDef), changes);
  return changes;
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  const json: unknown = JSON.parse(JSON.stringify(value));
  if (isPlainObject(json)) {
    for (const key of NON_GENERATIVE_KEYS) delete json[key];
  }
  return json;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(prefix: string, a: unknown, b: unknown, out: DefinitionChange[]): void {
  if (stableStringify(a) === stableStringify(b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      walk(prefix ? `${prefix}.${key}` : key, a[key], b[key], out);
    }
    return;
  }
  out.push({ path: prefix, old: a, new: b });
}

export function formatDefinitionValue(value: unknown, maxLen = 60): string {
  if (value === undefined) return "(absent)";
  const s = typeof value === "string" ? JSON.stringify(value) : stableStringify(value);
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}
