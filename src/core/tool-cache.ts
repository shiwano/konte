import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import { workspaceRootOrNull } from "./workspace-context.js";

/**
 * Directory holding one managed runtime (`ffmpeg-<ver>`, `tsc-<ver>`, `chromium-<ver>`,
 * `hyperframes-<hash>`). Each name pins the identity of what it holds, so an upgrade lands in a
 * fresh directory instead of reusing a stale extraction.
 *
 * Inside a workspace the runtimes live under `<workspace>/.konte/tools/`, so removing the
 * workspace removes everything konte installed. `KONTE_CACHE_DIR` overrides that (CI, Nix, a
 * shared cache). Outside a workspace — `konte lsp` is launched by an editor from anywhere and
 * still needs tsc — fall back to the XDG cache.
 */
export function toolCacheDir(name: string): string {
  return path.join(toolCacheRoot(), name);
}

export function toolCacheRoot(): string {
  const override = process.env.KONTE_CACHE_DIR;
  if (override) return path.resolve(override);

  const workspace = workspaceRootOrNull();
  if (workspace) return path.join(workspace, ".konte", "tools");

  const xdg = process.env.XDG_CACHE_HOME;
  return xdg ? path.join(xdg, "konte") : path.join(os.homedir(), ".cache", "konte");
}

// Stamped into a runtime directory once everything in it has been verified and unpacked.
const READY_MARKER = ".konte-verified";

// A cold Chromium or ffmpeg fetch is a hundred-plus MB, so a waiter has to outlast a slow link.
// The holder heartbeats its lock, so a live provision is never mistaken for an abandoned one.
const PROVISION_LOCK_TIMEOUT_MS = 15 * 60_000;

/**
 * Whether `dir` holds a *finished* install of exactly the artifacts `pin` names.
 *
 * The directory name pins which version a runtime is, but not that the bytes under it were ever
 * checked or that unpacking ran to completion — an install left by an older konte that verified
 * nothing, a half-extracted archive, a gunzip killed mid-write all leave a plausible-looking
 * binary at the path a resolver would return. The marker is written last, after the download's
 * checksum passed and the files are in place, and holds the pinned digests it was built from, so a
 * directory only counts when the artifacts it was made of are still the ones konte pins today.
 *
 * `files` are what the install must still contain, relative to `dir`. The marker records what was
 * once verified into the directory, not what is in it now — something deleted underneath it must
 * not go on reading as ready.
 */
export function toolCacheReady(dir: string, pin: string, files: readonly string[]): boolean {
  try {
    if (fs.readFileSync(path.join(dir, READY_MARKER), "utf-8") !== pin) return false;
  } catch {
    return false;
  }
  return files.every((file) => fs.existsSync(path.join(dir, file)));
}

/**
 * Hold the provisioning lock for `dir` across processes while `fn` fills it.
 *
 * Two konte processes racing on a cold cache would otherwise each reset the directory out from
 * under the other's half-finished download. The lock file is a sibling of `dir`, never inside it,
 * so a reset cannot delete the lock that guards it. Re-check `toolCacheReady` inside `fn`: the
 * process that waited usually finds the work already done.
 */
export async function withToolCacheLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return withFileLock(`${dir}.lock`, fn, { timeoutMs: PROVISION_LOCK_TIMEOUT_MS });
}

/** Empty `dir` for a provision about to run, dropping any unverified leftovers it holds. */
export function resetToolCacheDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** Stamp `dir` as a finished install of `pin`. Call last, once every file is in place. */
export function markToolCacheReady(dir: string, pin: string): Promise<void> {
  return writeFileAtomic(path.join(dir, READY_MARKER), pin);
}
