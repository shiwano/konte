import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { downloadFile } from "./download.js";
import { endProgress, progressReporter } from "./download-progress.js";
import { type KonteErrorCode, KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { withFileLock } from "./file-lock.js";
import { workspaceRootOrNull } from "./workspace-context.js";

/**
 * Directory holding one managed runtime (`ffmpeg-<ver>`, `tsc-<ver>`, `chromium-<ver>`,
 * `hyperframes-<hash>`). Each name pins the identity of what it holds, so an upgrade lands in a
 * fresh directory instead of reusing a stale extraction.
 *
 * Inside a workspace the runtimes live under `<workspace>/.konte/tools/`, so removing the
 * workspace removes everything konte installed. `KONTE_CACHE_DIR` overrides that (CI, Nix, a
 * shared cache).
 */
export function toolCacheDir(name: string): string {
  return path.join(toolCacheRoot(), name);
}

function toolCacheRoot(): string {
  const override = process.env.KONTE_CACHE_DIR;
  if (override) return path.resolve(override);

  const workspace = workspaceRootOrNull();
  if (!workspace) throw new Error("The tool cache needs a workspace root");
  return path.join(workspace, ".konte", "tools");
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

interface ToolCacheProvision {
  dir: string;
  pin: string;
  files: readonly string[];
  /** Names the runtime in the provisioning notice and the failure message (`tsc 7.0.2`). */
  label: string;
  errorCode: KonteErrorCode;
  /** Appended to the failure message. */
  hint?: string;
  /** Fills the emptied `dir`; the readiness marker is written after it returns. */
  fill: () => Promise<void>;
}

const provisioning = new Map<string, Promise<void>>();

/**
 * Provision `dir` unless it is ready, once per process and under the cross-process lock. A failure
 * that is not already a `KonteError` surfaces as `errorCode`, and a failed provision is retried on
 * the next call.
 */
export async function provisionOnce(spec: ToolCacheProvision): Promise<void> {
  const { dir, pin, files } = spec;
  if (toolCacheReady(dir, pin, files)) return;
  let running = provisioning.get(dir);
  if (!running) {
    running = withToolCacheLock(dir, async () => {
      if (toolCacheReady(dir, pin, files)) return;
      resetToolCacheDir(dir);
      console.error(`konte: provisioning ${spec.label} → ${dir}`);
      await spec.fill();
      await markToolCacheReady(dir, pin);
    }).catch((err) => {
      provisioning.delete(dir);
      if (err instanceof KonteError) throw err;
      const hint = spec.hint ? `. ${spec.hint}` : "";
      throw new KonteError(
        spec.errorCode,
        `${spec.label} setup failed: ${errorMessage(err)}${hint}`,
      );
    });
    provisioning.set(dir, running);
  }
  await running;
}

/**
 * Download the tarball at `url` and move the contents of its root into `dest`: `inner` when given
 * (a path inside the archive), else the archive's one top-level directory.
 */
export async function unpackTarballInto(
  url: string,
  dest: string,
  progressLabel: string,
  inner?: string,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(dest, ".dl-"));
  try {
    const archive = path.join(tmp, path.basename(new URL(url).pathname));
    await downloadFile(url, archive, progressReporter(progressLabel));
    endProgress();
    const out = path.join(tmp, "out");
    fs.mkdirSync(out);
    await execFileAsync("tar", ["xf", archive, "-C", out]);
    const [top] = fs.readdirSync(out);
    const root = inner ? path.join(out, inner) : top ? path.join(out, top) : out;
    for (const entry of fs.readdirSync(root)) {
      fs.renameSync(path.join(root, entry), path.join(dest, entry));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Move the file called `name`, found anywhere under `dir`, to `dest`. */
export function moveFoundBinary(dir: string, name: string, dest: string): void {
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === name) {
        fs.rmSync(dest, { force: true });
        try {
          fs.renameSync(full, dest);
        } catch {
          fs.copyFileSync(full, dest);
        }
        return;
      }
    }
  }
  throw new Error(`"${name}" not found in the downloaded archive`);
}
