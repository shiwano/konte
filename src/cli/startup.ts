import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyCredentials } from "../core/credentials.js";
import { KonteError } from "../core/errors.js";
import { type KonteRoots, resolveRoots } from "../core/roots.js";
import { setWorkspaceRoot } from "../core/workspace-context.js";
import { requireVideoRoots, setRoots } from "./context.js";
import type { Scope } from "./scope.js";

// What every command does before its action, whether program.ts or program-worker.ts runs it.

export async function applyCwdOption(cwd: string | undefined): Promise<void> {
  if (!cwd) return;
  const target = path.resolve(cwd);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new KonteError("INVALID_CWD", `--cwd path does not exist: ${cwd}`);
  if (!stat.isDirectory()) {
    throw new KonteError("INVALID_CWD", `--cwd path is not a directory: ${cwd}`);
  }
  process.chdir(target);
}

/** Resolves and records the roots the scope needs; null for `none`. */
export async function enterScope(scope: Scope): Promise<KonteRoots | null> {
  if (scope === "none") {
    setRoots(null);
    setWorkspaceRoot(null);
    return null;
  }
  const roots = await resolveRoots(process.cwd());
  setRoots(roots);
  // Before anything can provision a managed runtime (they land in <workspace>/.konte/tools/)
  // or read process.env (the workspace's konte.credentials.json holds the backend credentials).
  setWorkspaceRoot(roots.workspace);
  await applyCredentials(roots.workspace);
  // A command that needs a video says so, and finds out here rather than halfway through.
  if (scope === "video") requireVideoRoots();
  return roots;
}
