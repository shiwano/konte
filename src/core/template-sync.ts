import * as fs from "node:fs/promises";
import * as path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  linkWorkspaceBinary,
  prepareAgentSettings,
  retireMcpJson,
  writeAgentSettings,
} from "./agent-settings.js";
import {
  AGENT_SETTINGS_FILES,
  BUNDLED_ADAPTERS,
  loadManagedTemplateContents,
  loadWorkspaceTemplate,
  MANAGED_TEMPLATES,
  TEMPLATE_HASH,
} from "./generated/template-assets.js";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError } from "./errors.js";
import { WORKSPACE_MARKER } from "./roots.js";
import { compareVersions, isReleaseVersion } from "./version.js";

declare const KONTE_COMPILED: boolean | undefined;

const LOCK_FILE = ".konte/template.lock.json";
const VERSION_FILE = "konte.version";

interface TemplateLock {
  hash: string;
  version: string;
  root: string;
  updatedAt: string;
  files?: string[];
}

interface WorkspaceSyncResult {
  created: string[];
  updated: string[];
  removed: string[];
  /** A bundled adapter or guide the template dropped, left in place because a workspace file names it. */
  retained: string[];
  unwritable: string[];
  // SUNSET(0.6.0): konte:upgrade
  previousVersion: string | null;
}

function isUnwritable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EROFS";
}

// A rename would replace a symlink, ignore a read-only file and drop its mode.
async function writeWorkspaceFile(filePath: string, data: string): Promise<void> {
  const target = await fs.realpath(filePath).catch(() => null);
  if (target === null) return writeFileAtomic(filePath, data);
  await fs.access(target, fs.constants.W_OK);
  const { mode } = await fs.stat(target);
  await writeFileAtomic(target, data, { mode: mode & 0o7777 });
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

async function writeLock(workspaceRoot: string, files: string[]): Promise<void> {
  const lock: TemplateLock = {
    hash: TEMPLATE_HASH,
    version: pkg.version,
    root: workspaceRoot,
    updatedAt: new Date().toISOString(),
    files: [...files].sort(),
  };
  await writeFileAtomic(path.join(workspaceRoot, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
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
  await writeFileAtomic(path.join(workspaceRoot, VERSION_FILE), `${pkg.version}\n`);
}

function isNewer(version: string, than: string): boolean {
  return isReleaseVersion(version) && isReleaseVersion(than) && compareVersions(version, than) > 0;
}

/** Whether a bundled adapter missing from the workspace shipped after the konte that last synced it. */
function shippedSince(introducedIn: string | null, previous: string | null): boolean {
  if (previous === null || !isReleaseVersion(previous)) return false;
  if (introducedIn === null || !isReleaseVersion(introducedIn)) return true;
  return isNewer(introducedIn, previous);
}

const RETIRABLE_AGENT_PREFIXES = [
  ".agents/skills/",
  ".claude/skills/",
  ".claude/agents/",
  ".codex/agents/",
];
const RETIRABLE_PREFIXES = ["adapters/", ".konte/guides/", ...RETIRABLE_AGENT_PREFIXES];

function isRetirable(key: string): boolean {
  return path.posix.normalize(key) === key && RETIRABLE_PREFIXES.some((p) => key.startsWith(p));
}
async function listSourceFiles(workspaceRoot: string, dir = ""): Promise<string[]> {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(path.join(workspaceRoot, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dirent of dirents) {
    const key = dir === "" ? dirent.name : `${dir}/${dirent.name}`;
    if (dirent.isDirectory()) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      files.push(...(await listSourceFiles(workspaceRoot, key)));
    } else if (/\.tsx?$/.test(dirent.name)) {
      files.push(key);
    }
  }
  return files;
}

function referenceNeedles(key: string): string[] {
  if (RETIRABLE_AGENT_PREFIXES.some((p) => key.startsWith(p))) return [];
  if (key.startsWith(".konte/guides/"))
    return [`konte/guides/${key.slice(".konte/guides/".length)}`];
  const base = path.posix.basename(key).replace(/\.[^.]+$/, "");
  if (key.endsWith(".json")) return [`${base}.json`, `"${base}"`];
  return [".js", ".ts", ".jsx", ".tsx", '"', "'"].map((end) => `/${base}${end}`);
}

// The directories a retired skill leaves empty, up to its retirable root.
async function removeEmptyParents(workspaceRoot: string, key: string): Promise<void> {
  const prefix = RETIRABLE_AGENT_PREFIXES.find((p) => key.startsWith(p));
  if (!prefix) return;
  for (let dir = path.posix.dirname(key); `${dir}/` !== prefix; dir = path.posix.dirname(dir)) {
    try {
      await fs.rmdir(path.join(workspaceRoot, dir));
    } catch {
      return;
    }
  }
}

/** A name inside another unused retired file does not count. */
async function partitionRetired(
  workspaceRoot: string,
  retired: string[],
): Promise<{ unused: string[]; used: string[] }> {
  if (retired.length === 0) return { unused: [], used: [] };
  const sources = new Map<string, string>();
  const keys = [WORKSPACE_MARKER, ...(await listSourceFiles(workspaceRoot))];
  for (const key of keys) {
    const content = await readFileOrNull(path.join(workspaceRoot, key));
    if (content !== null) sources.set(key, content);
  }

  const unused = new Set(retired);
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of unused) {
      const needles = referenceNeedles(key);
      for (const [source, content] of sources) {
        if (unused.has(source) || !needles.some((n) => content.includes(n))) continue;
        unused.delete(key);
        changed = true;
        break;
      }
    }
  }
  return { unused: [...unused], used: retired.filter((key) => !unused.has(key)) };
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
  await writeWorkspaceFile(
    ignorePath,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
}

/** Refuses a konte older than the one `konte.version` names. */
export async function assertKonteCurrent(workspaceRoot: string): Promise<void> {
  const recorded = await readVersionFile(workspaceRoot);
  if (recorded === null || !isNewer(recorded, pkg.version)) return;
  throw new KonteError(
    "KONTE_OUTDATED",
    `${workspaceRoot} was set up by konte v${recorded}, newer than this v${pkg.version}; install v${recorded} with the konte-upgrade skill`,
  );
}

/** Refuses a command in a workspace whose managed files this konte did not write. Writes nothing. */
export async function assertWorkspaceSynced(workspaceRoot: string): Promise<void> {
  await assertKonteCurrent(workspaceRoot);
  const lock = await readLock(workspaceRoot);
  if (
    lock?.hash === TEMPLATE_HASH &&
    lock.root === workspaceRoot &&
    (await allPresent(workspaceRoot, [...MANAGED_TEMPLATES, ...AGENT_SETTINGS_FILES])) &&
    (await binaryLinkLive(workspaceRoot))
  ) {
    return;
  }
  throw new KonteError(
    "WORKSPACE_SETUP_REQUIRED",
    `The managed files in ${workspaceRoot} do not match konte v${pkg.version}; run \`konte workspace setup\` there, then the command again`,
  );
}

/**
 * Brings a workspace up to this konte and this location: overwrites the managed template files
 * and the bundled adapters it holds, adds a bundled adapter shipped after the konte that last
 * synced it (`konte.version`), deletes a bundled adapter or guide the template dropped that the
 * lock records an earlier sync leaving and no workspace file names, renders the agent settings
 * for the workspace root, takes an earlier konte's MCP server out of them, appends missing
 * `.gitignore` lines and links `.konte/bin/konte`.
 *
 * A managed file the OS refuses to write is left as it is and listed in `unwritable`;
 * the lock and `konte.version` then stay unwritten, so the next run tries again.
 */
export async function syncWorkspace(workspaceRoot: string): Promise<WorkspaceSyncResult> {
  const previousVersion = await readVersionFile(workspaceRoot);
  const lock = await readLock(workspaceRoot);

  // Ahead of any write: settings it cannot merge refuse the whole sync.
  const settings = await prepareAgentSettings(workspaceRoot);
  const created: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const unwritable: string[] = [];
  const placed: string[] = [];
  const contents = await loadManagedTemplateContents();
  const template = await loadWorkspaceTemplate();
  for (const key of Object.keys(BUNDLED_ADAPTERS)) contents[key] = template[key]!;

  for (const [key, desired] of Object.entries(contents)) {
    const fullPath = path.join(workspaceRoot, key);
    const current = await readFileOrNull(fullPath);
    if (current !== null) placed.push(key);
    if (current === desired) continue;
    if (
      current === null &&
      key in BUNDLED_ADAPTERS &&
      !shippedSince(BUNDLED_ADAPTERS[key] ?? null, previousVersion)
    ) {
      continue;
    }

    try {
      await writeWorkspaceFile(fullPath, desired);
    } catch (err) {
      if (!isUnwritable(err)) throw err;
      unwritable.push(key);
      continue;
    }
    if (current === null) {
      created.push(key);
      placed.push(key);
    } else {
      updated.push(key);
    }
  }

  const retiredCandidates: string[] = [];
  for (const key of lock?.files ?? []) {
    if (key in contents || !isRetirable(key)) continue;
    if ((await readFileOrNull(path.join(workspaceRoot, key))) !== null) retiredCandidates.push(key);
  }
  const { unused, used: retained } = await partitionRetired(workspaceRoot, retiredCandidates);
  placed.push(...retained);
  for (const key of unused) {
    try {
      await fs.rm(path.join(workspaceRoot, key));
    } catch (err) {
      if (!isUnwritable(err)) throw err;
      unwritable.push(key);
      continue;
    }
    removed.push(key);
    await removeEmptyParents(workspaceRoot, key);
  }

  await appendMissingIgnores(workspaceRoot, template[".gitignore"]!);
  await writeAgentSettings(workspaceRoot, settings);
  // SUNSET(0.6.0): konte MCP server
  const mcpJson = await retireMcpJson(workspaceRoot);
  if (mcpJson) (mcpJson === "removed" ? removed : updated).push(".mcp.json");
  if (linksBinary()) await linkWorkspaceBinary(workspaceRoot, process.execPath);

  if (unwritable.length === 0) {
    await writeLock(workspaceRoot, placed.filter(isRetirable));
    await writeVersionFile(workspaceRoot, previousVersion);
  }
  return { created, updated, removed, retained, unwritable, previousVersion };
}
