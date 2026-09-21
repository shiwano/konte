import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "./content-hash.js";
import { STAGE_ENTRY_FILE, WORKSPACE_MARKER } from "./roots.js";

// The files a video's definitions are evaluated from: its stage entries and patch scripts, and the
// workspace's adapters. A job records this fingerprint when it is created, from the same files the
// creating process loaded; a judge that later computes a different definition hash for the job
// while this fingerprint still matches is not looking at a changed definition — its own loaded
// definitions are older than the files. That is the one case the hash check must not read as
// "definition changed": the job is right and the process is stale.
//
// A module imported from outside these roots (a shared helper beside the workspace) is not
// covered — an edit there changes the definition without moving the fingerprint, which the judge
// handles by giving a job one release before it fails it (see pending-jobs.ts).
const PATCHES_DIR = "patches";
const ADAPTERS_DIR = "adapters";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function findWorkspaceRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function listSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...(await listSources(full)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

// The absolute paths the fingerprint covers, sorted so the digest is stable across platforms.
export async function listDefinitionSources(videoRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of Object.values(STAGE_ENTRY_FILE)) {
    const file = path.resolve(videoRoot, name);
    if (existsSync(file)) files.push(file);
  }
  files.push(...(await listSources(path.resolve(videoRoot, PATCHES_DIR))));
  const workspaceRoot = findWorkspaceRoot(videoRoot);
  if (workspaceRoot) files.push(...(await listSources(path.join(workspaceRoot, ADAPTERS_DIR))));
  return files.sort();
}

export async function computeDefinitionSourceFingerprint(videoRoot: string): Promise<string> {
  const files = await listDefinitionSources(videoRoot);
  const parts: (string | Uint8Array)[] = [];
  for (const file of files) {
    parts.push(path.relative(videoRoot, file), "\0", await fs.readFile(file), "\0");
  }
  return sha256Hex(...parts).slice(0, 16);
}
