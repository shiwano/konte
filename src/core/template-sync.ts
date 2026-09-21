import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  ALWAYS_OVERWRITE_TEMPLATES,
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
  // key -> sha256 of the content konte last wrote for that file (its provenance).
  files: Record<string, string>;
}

interface TemplateSyncResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
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
    if (
      parsed &&
      typeof parsed.hash === "string" &&
      parsed.files &&
      typeof parsed.files === "object"
    ) {
      return parsed as TemplateLock;
    }
  } catch {
    // fall through: corrupt lock is treated as absent
  }
  return null;
}

async function writeLock(workspaceRoot: string, files: Record<string, string>): Promise<void> {
  const lock: TemplateLock = {
    hash: TEMPLATE_HASH,
    version: pkg.version,
    updatedAt: new Date().toISOString(),
    files,
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
 * Records the current templates as the lock provenance. Called by `init` right
 * after all template files are written verbatim, so on-disk content matches.
 */
export async function writeTemplateLock(workspaceRoot: string): Promise<void> {
  const files: Record<string, string> = {};
  const contents = await loadManagedTemplateContents();
  for (const key of MANAGED_TEMPLATES) {
    const content = contents[key];
    if (content !== undefined) files[key] = sha256(content);
  }
  await writeLock(workspaceRoot, files);
  await writeVersionFile(workspaceRoot);
}

/**
 * Re-syncs konte-managed template files into an existing project when the
 * embedded templates change. Cheap fast-path: returns null when the lock hash
 * already matches the current template hash AND every always-overwrite file is
 * present (these are gitignored generated stubs required by type-checking, so
 * we restore them even on the fast path). Otherwise applies a per-file 3-way
 * decision (pristine files updated, user-edited files skipped) and rewrites the
 * lock.
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
    (await allPresent(workspaceRoot, ALWAYS_OVERWRITE_TEMPLATES))
  ) {
    return null;
  }

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const files: Record<string, string> = {};
  const contents = await loadManagedTemplateContents();

  for (const key of MANAGED_TEMPLATES) {
    const desired = contents[key];
    if (desired === undefined) continue;
    const desiredHash = sha256(desired);
    const recorded = lock?.files[key];
    const fullPath = path.join(workspaceRoot, key);
    const current = await readFileOrNull(fullPath);

    if (current === null) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, desired, "utf-8");
      created.push(key);
      files[key] = desiredHash;
      continue;
    }

    const currentHash = sha256(current);
    if (currentHash === desiredHash) {
      files[key] = desiredHash;
      continue;
    }

    const isPristine = ALWAYS_OVERWRITE_TEMPLATES.has(key) || currentHash === recorded;
    if (isPristine) {
      await fs.writeFile(fullPath, desired, "utf-8");
      updated.push(key);
      files[key] = desiredHash;
      continue;
    }

    // User-edited or unknown provenance: leave the file untouched and carry
    // forward the old provenance so it stays protected on future upgrades.
    skipped.push(key);
    if (recorded !== undefined) files[key] = recorded;
  }

  await writeLock(workspaceRoot, files);
  return { created, updated, skipped };
}
