import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { WORKSPACE_MARKER } from "../core/roots.js";

// Bun caches its transpile of every source file over ~50KB — in a konte workspace, the definition
// entries — keyed by the file's CONTENT ALONE, never its location. A definition reaches an adapter
// through `konte/workspace/…`, which loader.ts resolves to an ABSOLUTE path, and that path is baked
// into the cached output. So a workspace that moves keeps hitting a cache pointing at where it used
// to be, and every definition fails to load, naming a directory that is gone.
//
// Bun reads the cache location from the real environment at process start, before any JS runs:
// assigning `process.env` in the entry is too late, and so are `--define`, `--env=inline` and .env
// autoload. The entry therefore re-execs itself once with the variable set — see index.ts.
export const TRANSPILER_CACHE_ENV = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";

// Bun's own spelling for "do not cache at all".
export const TRANSPILER_CACHE_DISABLED = "0";

const CACHE_BASE = path.join(".konte", "transpiler-cache");

// Written inside each generation so the opaque directory name can be traced back by hand.
const ROOT_MARKER = ".root";

// The `--cwd <path>` the program option would apply, read before commander exists. Either spelling,
// in any position, and — like commander — the last one wins, the value is consumed, an option where
// the value belongs reads as missing, and nothing past `--` counts.
function cwdFromArgs(args: readonly string[]): string {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "--cwd") {
      const value = args[++i];
      if (value !== undefined && !value.startsWith("-")) found = value;
    } else if (arg.startsWith("--cwd=")) found = arg.slice("--cwd=".length);
  }
  return found ?? process.cwd();
}

function findWorkspaceRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The generation a given root's piles belong to. A move lands on a new one, and the generation it
// left is never read again. Nothing prunes it: konte would be recursively deleting a path it does
// not control, at startup, to reclaim disk inside a directory that is already ignored. Deleting
// `.konte/transpiler-cache` by hand is the way to reclaim it.
function generation(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

// True when `dir` would be created inside the workspace, resolving the nearest ancestor that
// already exists — `.konte` or the cache base may be a symlink, and following one would put a
// workspace's piles somewhere konte does not own. Refusing costs a cache; it never deletes
// anything, so a false negative is free.
function insideWorkspace(root: string, dir: string): boolean {
  try {
    const realRoot = realpathSync(root);
    let probe = dir;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
    // Compared as a relative path: a filesystem or drive root already ends in a separator, which a
    // prefix test would double.
    const rel = path.relative(realRoot, realpathSync(probe));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

// The cache directory this workspace owns at its current location; move a workspace back and its
// own generation is still there. Returns Bun's disable value when there is no workspace to own a
// cache, or when the directory cannot be written — never the machine-wide cache under `~/.bun`.
export function resolveTranspilerCachePath(args: readonly string[]): string {
  const root = findWorkspaceRoot(cwdFromArgs(args));
  if (!root) return TRANSPILER_CACHE_DISABLED;

  const dir = path.join(root, CACHE_BASE, generation(root));
  if (!insideWorkspace(root, dir)) return TRANSPILER_CACHE_DISABLED;
  try {
    mkdirSync(dir, { recursive: true });
    // An existing directory satisfies mkdir whatever its mode, so ask separately.
    accessSync(dir, constants.W_OK);
    const marker = path.join(dir, ROOT_MARKER);
    if (!existsSync(marker)) writeFileSync(marker, root);
  } catch {
    return TRANSPILER_CACHE_DISABLED;
  }
  return dir;
}
