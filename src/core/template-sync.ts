import * as fs from "node:fs/promises";
import * as path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  loadManagedTemplateContents,
  MANAGED_TEMPLATES,
  TEMPLATE_HASH,
} from "./generated/template-assets.js";

const LOCK_FILE = ".konte/template.lock.json";
const VERSION_FILE = "konte.version";

interface TemplateLock {
  hash: string;
  version: string;
  updatedAt: string;
}

interface TemplateSyncResult {
  created: string[];
  updated: string[];
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function allPresent(workspaceRoot: string, keys: Iterable<string>): Promise<boolean> {
  for (const key of keys) {
    try {
      await fs.access(path.join(workspaceRoot, key));
    } catch {
      return false;
    }
  }
  return true;
}

async function readLock(workspaceRoot: string): Promise<TemplateLock | null> {
  const raw = await readFileOrNull(path.join(workspaceRoot, LOCK_FILE));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.hash === "string") {
      return parsed as TemplateLock;
    }
  } catch {
    // fall through: corrupt lock is treated as absent
  }
  return null;
}

async function writeLock(workspaceRoot: string): Promise<void> {
  const lock: TemplateLock = {
    hash: TEMPLATE_HASH,
    version: pkg.version,
    updatedAt: new Date().toISOString(),
  };
  const lockPath = path.join(workspaceRoot, LOCK_FILE);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const tmpPath = `${lockPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, lockPath);
}

/**
 * Writes the committed version marker: the lock carries the same version, but
 * `.konte/` is gitignored, so nothing in a project's history says which konte
 * wrote the managed files it has under version control.
 */
async function writeVersionFile(workspaceRoot: string): Promise<void> {
  const filePath = path.join(workspaceRoot, VERSION_FILE);
  const desired = `${pkg.version}\n`;
  if ((await readFileOrNull(filePath)) === desired) return;
  await fs.writeFile(filePath, desired, "utf-8");
}

/**
 * Records the current templates as synced. Called by `init` right after all
 * template files are written verbatim.
 */
export async function writeTemplateLock(workspaceRoot: string): Promise<void> {
  await writeLock(workspaceRoot);
  await writeVersionFile(workspaceRoot);
}

/**
 * Overwrites konte-managed template files in an existing project when the
 * embedded templates change. Cheap fast-path: returns null when the lock hash
 * already matches the current template hash AND every managed file is present
 * (some are gitignored generated stubs required by type-checking, so they are
 * restored even on the fast path).
 */
export async function syncManagedTemplates(
  workspaceRoot: string,
  options: { force?: boolean } = {},
): Promise<TemplateSyncResult | null> {
  // Ahead of the fast path: a release that leaves the templates untouched still
  // moves the version.
  await writeVersionFile(workspaceRoot);

  const lock = await readLock(workspaceRoot);
  if (
    !options.force &&
    lock?.hash === TEMPLATE_HASH &&
    (await allPresent(workspaceRoot, MANAGED_TEMPLATES))
  ) {
    return null;
  }

  const created: string[] = [];
  const updated: string[] = [];
  const contents = await loadManagedTemplateContents();

  for (const key of MANAGED_TEMPLATES) {
    const desired = contents[key];
    if (desired === undefined) continue;
    const fullPath = path.join(workspaceRoot, key);
    const current = await readFileOrNull(fullPath);
    if (current === desired) continue;

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, desired, "utf-8");
    (current === null ? created : updated).push(key);
  }

  await writeLock(workspaceRoot);
  return { created, updated };
}
