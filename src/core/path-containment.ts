import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { KonteError } from "./errors.js";

/** Does `target` sit at or under `root`? Lexical only — a symlink out of `root` still passes. */
export function isWithinRoot(target: string, root: string): boolean {
  const resolvedRoot = path.resolve(root) + path.sep;
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot.slice(0, -1) || resolvedTarget.startsWith(resolvedRoot);
}

// A path that is lexically inside `root` can still be a symlink pointing out of it, so anything
// that reads or ships the file's *contents* must judge the link target, not the link. A target
// that does not exist has no link to follow, and is left to its caller to report as missing.
function containedAfterLinks(root: string, real: string | null): boolean {
  return real === null || isWithinRoot(real, root);
}

/** Symlink-aware containment, for the preview server's synchronous request handlers. */
export function isWithinRootReal(target: string, root: string): boolean {
  if (!isWithinRoot(target, root)) return false;
  const realRoot = tryRealpathSync(root) ?? path.resolve(root);
  return containedAfterLinks(realRoot, tryRealpathSync(target));
}

/** Symlink-aware containment for an already-absolute path, awaitable. */
export async function isWithinRootRealAsync(target: string, root: string): Promise<boolean> {
  if (!isWithinRoot(target, root)) return false;
  return containedAfterLinksAsync(target, root);
}

function tryRealpathSync(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Absolute path of a root-relative file, or null when it lands outside `root`.
 *
 * Rejects an absolute path, a `..` escape, and a symlink whose target leaves the root. This is the
 * gate on a `file` asset's declared path: konte hashes that file into state and uploads it to
 * whichever cloud backend consumes it, so a path that escapes the video is an exfiltration route
 * out of the workspace (`../../konte.credentials.json`) that no deny rule on that file can see.
 */
export async function resolveWithinRoot(root: string, filePath: string): Promise<string | null> {
  if (path.isAbsolute(filePath)) return null;

  const abs = path.resolve(root, filePath);
  if (!isWithinRoot(abs, root)) return null;
  return (await containedAfterLinksAsync(abs, root)) ? abs : null;
}

async function containedAfterLinksAsync(abs: string, root: string): Promise<boolean> {
  const realRoot = (await fsp.realpath(root).catch(() => null)) ?? path.resolve(root);
  const real = await fsp.realpath(abs).catch(() => null);
  return containedAfterLinks(realRoot, real);
}

/**
 * Absolute path of a file a backend is about to read or ship, or a thrown error when it leaves
 * the video.
 *
 * `syncFileAssets` already gates a file asset's path — but it stores that path and the backend
 * re-resolves it much later, so a symlink swapped in between the two would be followed here. This
 * is the boundary that actually sends the bytes to a cloud vendor, so it re-checks rather than
 * trusting what state recorded.
 */
export async function requireFileWithinRoot(root: string, filePath: string): Promise<string> {
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  if (!isWithinRoot(abs, root) || !(await containedAfterLinksAsync(abs, root))) {
    throw new KonteError(
      "INVALID_REFERENCE",
      `Refusing to read "${filePath}": it resolves outside the video directory.`,
    );
  }
  return abs;
}
