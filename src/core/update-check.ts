import * as fs from "node:fs/promises";
import { workspaceRootOrNull } from "./workspace-context.js";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

/**
 * Is a newer konte release out? Asked by `konte doctor` only — `status` and every other
 * command stay off the network.
 *
 * `KONTE_UPDATE_CHECK=0` turns the check off.
 *
 * The latest tag is read from where GitHub's "Latest release" link redirects — no API token, no
 * rate limit, prereleases excluded.
 */

const RELEASES_LATEST_URL = "https://github.com/shiwano/konte/releases/latest";
const CACHE_FILE = "update-check.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3_000;

export type UpdateCheck =
  | { kind: "current"; current: string; latest: string }
  | { kind: "outdated"; current: string; latest: string }
  | { kind: "unknown"; current: string; reason: string }
  | { kind: "disabled"; current: string };

interface CacheEntry {
  checkedAt: string;
  latest: string;
}

export interface UpdateCheckOptions {
  now?: () => Date;
  fetchLatestTag?: () => Promise<string>;
  cacheDir?: string;
}

export function updateCheckCacheDir(): string {
  return path.join(workspaceRootOrNull() ?? process.cwd(), ".konte");
}

export function updateCheckEnabled(): boolean {
  return process.env.KONTE_UPDATE_CHECK !== "0";
}

export async function checkForUpdate(
  currentVersion: string,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheck> {
  const current = normalizeVersion(currentVersion);
  if (!updateCheckEnabled()) return { kind: "disabled", current };

  const now = options.now ?? (() => new Date());
  const cacheDir = options.cacheDir ?? updateCheckCacheDir();
  const cachePath = path.join(cacheDir, CACHE_FILE);

  let latest = await readFreshCache(cachePath, now());
  if (!latest) {
    try {
      latest = normalizeVersion(await (options.fetchLatestTag ?? fetchLatestReleaseTag)());
    } catch (err) {
      return {
        kind: "unknown",
        current,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    const entry: CacheEntry = { checkedAt: now().toISOString(), latest };
    await writeFileAtomic(cachePath, JSON.stringify(entry, null, 2) + "\n").catch(() => {});
  }

  return compareVersions(latest, current) > 0
    ? { kind: "outdated", current, latest }
    : { kind: "current", current, latest };
}

async function readFreshCache(cachePath: string, now: Date): Promise<string | null> {
  try {
    const entry = JSON.parse(await fs.readFile(cachePath, "utf8")) as Partial<CacheEntry>;
    if (typeof entry.latest !== "string" || typeof entry.checkedAt !== "string") return null;
    const age = now.getTime() - Date.parse(entry.checkedAt);
    if (!Number.isFinite(age) || age < 0 || age > CACHE_TTL_MS) return null;
    return normalizeVersion(entry.latest);
  } catch {
    return null;
  }
}

async function fetchLatestReleaseTag(): Promise<string> {
  const response = await fetch(RELEASES_LATEST_URL, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const location = response.headers.get("location");
  if (!location)
    throw new Error(`no redirect from ${RELEASES_LATEST_URL} (HTTP ${response.status})`);
  const tag = location.split("/").filter(Boolean).at(-1);
  if (!tag || tag === "releases" || tag === "latest") throw new Error(`no release found`);
  return tag;
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

/** Positive when `a` is newer than `b`; dotted numeric parts, a pre-release suffix ranks below its release. */
export function compareVersions(a: string, b: string): number {
  const [aMain, aPre] = splitPre(normalizeVersion(a));
  const [bMain, bPre] = splitPre(normalizeVersion(b));
  const aParts = aMain.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bParts = bMain.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === bPre) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  return aPre < bPre ? -1 : 1;
}

function splitPre(version: string): [string, string | null] {
  const i = version.indexOf("-");
  return i === -1 ? [version, null] : [version.slice(0, i), version.slice(i + 1)];
}
