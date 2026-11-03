import * as fs from "node:fs/promises";
import * as path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { linkWorkspaceBinary, prepareAgentSettings, writeAgentSettings } from "./agent-settings.js";
import {
  AGENT_SETTINGS_FILES,
  BUNDLED_ADAPTERS,
  loadManagedTemplateContents,
  loadWorkspaceTemplate,
  MANAGED_TEMPLATES,
  TEMPLATE_HASH,
} from "./generated/template-assets.js";

declare const KONTE_COMPILED: boolean | undefined;

const LOCK_FILE = ".konte/template.lock.json";
const VERSION_FILE = "konte.version";

interface TemplateLock {
  hash: string;
  version: string;
  root: string;
  updatedAt: string;
}

interface WorkspaceSyncResult {
  created: string[];
  updated: string[];
  unwritable: string[];
  /** What a coding agent reads only at its startup: agent settings and the `.konte/bin` link. */
  relaunch: string[];
}

function isUnwritable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EROFS";
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
    root: workspaceRoot,
    updatedAt: new Date().toISOString(),
  };
  const lockPath = path.join(workspaceRoot, LOCK_FILE);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const tmpPath = `${lockPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, lockPath);
}

/**
 * The committed version marker: the lock carries the same version, but `.konte/` is
 * gitignored, so nothing in a project's history says which konte wrote the managed files
 * it has under version control.
 */
async function readVersionFile(workspaceRoot: string): Promise<string | null> {
  return (await readFileOrNull(path.join(workspaceRoot, VERSION_FILE)))?.trim() || null;
}

async function writeVersionFile(workspaceRoot: string, previous: string | null): Promise<void> {
  if (previous === pkg.version) return;
  await fs.writeFile(path.join(workspaceRoot, VERSION_FILE), `${pkg.version}\n`, "utf-8");
}

function parseVersion(version: string): number[] | null {
  const parts = version.split(".").map(Number);
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
}

/** Whether a bundled adapter missing from the workspace shipped after the konte that last synced it. */
function shippedSince(introducedIn: string | null, previous: string | null): boolean {
  const last = previous === null ? null : parseVersion(previous);
  if (last === null) return false;
  const shipped = introducedIn === null ? null : parseVersion(introducedIn);
  if (shipped === null) return true;
  for (let i = 0; i < 3; i++) {
    if (shipped[i] !== last[i]) return shipped[i]! > last[i]!;
  }
  return false;
}

function linksBinary(): boolean {
  return typeof KONTE_COMPILED !== "undefined" && KONTE_COMPILED && process.platform !== "win32";
}

async function binaryLinkLive(workspaceRoot: string): Promise<boolean> {
  if (!linksBinary()) return true;
  try {
    await fs.stat(path.join(workspaceRoot, ".konte", "bin", "konte"));
    return true;
  } catch {
    return false;
  }
}

async function appendMissingIgnores(workspaceRoot: string, template: string): Promise<void> {
  const ignorePath = path.join(workspaceRoot, ".gitignore");
  const current = (await readFileOrNull(ignorePath)) ?? "";
  const lines = new Set(current.split(/\r?\n/));
  const missing = template.split("\n").filter((line) => line && !lines.has(line));
  if (missing.length === 0) return;
  await fs.writeFile(
    ignorePath,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
}

/**
 * Brings a workspace up to this konte and this location: overwrites the managed template files
 * and the bundled adapters it holds, adds a bundled adapter shipped after the konte that last
 * synced it (`konte.version`), renders the agent settings for the workspace root, appends
 * missing `.gitignore` lines and links `.konte/bin/konte`. Cheap fast-path: returns null when the lock names the current
 * template hash and this root, every managed file and agent setting is present, and the
 * `.konte/bin` link resolves.
 *
 * A managed file the OS refuses to write is left as it is and listed in `unwritable`;
 * the lock and `konte.version` then stay unwritten, so the next run tries again.
 */
export async function syncWorkspace(
  workspaceRoot: string,
  options: { force?: boolean } = {},
): Promise<WorkspaceSyncResult | null> {
  const previousVersion = await readVersionFile(workspaceRoot);
  const lock = await readLock(workspaceRoot);
  if (
    !options.force &&
    lock?.hash === TEMPLATE_HASH &&
    lock.root === workspaceRoot &&
    (await allPresent(workspaceRoot, [...MANAGED_TEMPLATES, ...AGENT_SETTINGS_FILES])) &&
    (await binaryLinkLive(workspaceRoot))
  ) {
    await writeVersionFile(workspaceRoot, previousVersion);
    return null;
  }

  // Ahead of any write: settings it cannot merge refuse the whole sync.
  const settings = await prepareAgentSettings(workspaceRoot);
  const created: string[] = [];
  const updated: string[] = [];
  const unwritable: string[] = [];
  const contents = await loadManagedTemplateContents();
  const template = await loadWorkspaceTemplate();
  for (const key of Object.keys(BUNDLED_ADAPTERS)) contents[key] = template[key]!;

  for (const [key, desired] of Object.entries(contents)) {
    const fullPath = path.join(workspaceRoot, key);
    const current = await readFileOrNull(fullPath);
    if (current === desired) continue;
    if (
      current === null &&
      key in BUNDLED_ADAPTERS &&
      !shippedSince(BUNDLED_ADAPTERS[key] ?? null, previousVersion)
    ) {
      continue;
    }

    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, desired, "utf-8");
    } catch (err) {
      if (!isUnwritable(err)) throw err;
      unwritable.push(key);
      continue;
    }
    (current === null ? created : updated).push(key);
  }

  await appendMissingIgnores(workspaceRoot, template[".gitignore"]!);
  const relaunch = await writeAgentSettings(workspaceRoot, settings);
  if (linksBinary() && (await linkWorkspaceBinary(workspaceRoot, process.execPath))) {
    relaunch.push(".konte/bin/konte");
  }

  if (unwritable.length === 0) {
    await writeLock(workspaceRoot);
    await writeVersionFile(workspaceRoot, previousVersion);
  }
  return { created, updated, unwritable, relaunch };
}
