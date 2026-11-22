import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readAssetsGitignore } from "../../../core/assets-gitignore.js";
import { errorMessage } from "../../../core/errors.js";
import { JobManager } from "../../../core/job-manager.js";
import { buildOrphanContext, listStrayVariantDirs } from "../../../core/orphans.js";
import { listPatchVariantIds } from "../../../core/patch.js";
import { StateManager } from "../../../core/state/index.js";
import { acceptedConsumers, isProtectedVariant } from "../../../core/variant-lineage.js";
import { capInline } from "../../format-list.js";
import type { CheckResult, DefinitionSet } from "./types.js";

export const STATE_CHECK_NAMES = [
  "orphaned jobs",
  "orphaned targets",
  "stray variant directories",
  "missing assets",
  "assets/.gitignore",
] as const;

export async function checkStateJson(
  videoRoot: string,
): Promise<{ check: CheckResult; manager: StateManager | null }> {
  try {
    const manager = await StateManager.load(videoRoot);
    return { check: { name: "konte.state.json", status: "PASS", message: "valid" }, manager };
  } catch (err) {
    return {
      check: { name: "konte.state.json", status: "FAIL", message: errorMessage(err) },
      manager: null,
    };
  }
}

export async function checkOrphanedJobs(
  videoRoot: string,
  manager: StateManager,
): Promise<CheckResult> {
  try {
    const state = manager.getState();
    const jobManager = new JobManager(videoRoot);
    const jobs = await jobManager.listJobs();
    const orphaned: string[] = [];

    for (const job of jobs) {
      // Only generation jobs are tied to an asset/variant — model downloads and export
      // render jobs have no address/variant, so they can never be orphaned.
      if (job.kind !== "generation") continue;
      const target = state.assets[job.address];
      if (!target) {
        orphaned.push(job.variantId);
        continue;
      }
      if (!target.variants?.[job.variantId]) {
        orphaned.push(job.variantId);
      }
    }

    if (orphaned.length === 0) {
      return { name: "orphaned jobs", status: "PASS", message: "none found" };
    }
    return {
      name: "orphaned jobs",
      status: "WARN",
      message: `${orphaned.length} orphaned job(s): ${orphaned.join(", ")} — run \`konte clean\` to remove them`,
    };
  } catch {
    return { name: "orphaned jobs", status: "PASS", message: "no jobs to check" };
  }
}

export async function checkOrphanedTargets(
  videoRoot: string,
  manager: StateManager,
  defs: DefinitionSet | null,
): Promise<CheckResult> {
  if (!defs?.video) {
    return {
      name: "orphaned targets",
      status: "PASS",
      message: "cannot load definition (skipped)",
    };
  }
  const { video, animatic, reference } = defs;
  const state = manager.getState();

  // Reuse clean's orphan definition so doctor never warns about (and suggests cleaning) a live
  // composition baseline or #delivery target that clean itself would correctly keep.
  const { isOrphan } = buildOrphanContext(
    video,
    animatic,
    reference,
    new Set(await listPatchVariantIds(videoRoot)),
    state,
  );
  const orphans = Object.keys(state.assets).filter(isOrphan);
  if (orphans.length === 0) {
    return { name: "orphaned targets", status: "PASS", message: "none found" };
  }

  const preview = capInline(orphans, { cap: 3 });
  return {
    name: "orphaned targets",
    status: "WARN",
    message:
      `${orphans.length} orphaned target(s): ${preview}` +
      " — run `konte clean` to remove them, or `konte clean <address-scope>` for some",
  };
}

export async function checkStrayVariantDirs(
  videoRoot: string,
  manager: StateManager,
): Promise<CheckResult> {
  const stray = await listStrayVariantDirs(videoRoot, manager.getRecordedState());
  if (stray.length === 0) {
    return { name: "stray variant directories", status: "PASS", message: "none found" };
  }
  const preview = capInline(stray, { cap: 3 });
  return {
    name: "stray variant directories",
    status: "WARN",
    message: `${stray.length} not in state: ${preview} — run \`konte clean\` to remove them`,
  };
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

async function readMediaHead(file: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(LFS_POINTER_PREFIX.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

// A protected variant's media is what git holds, so its absence is a FAIL. An absent variant never
// reaches this check (see `StateManager.absentVariantIds`).
export async function checkMissingAssets(
  videoRoot: string,
  manager: StateManager,
): Promise<CheckResult> {
  const state = manager.getState();

  const protectedMissing: string[] = [];
  const otherMissing: string[] = [];
  let protectedPointers = 0;
  const consumers = acceptedConsumers(state);
  for (const [address, target] of Object.entries(state.assets)) {
    for (const [variantId, variant] of Object.entries(target.variants ?? {})) {
      if (!variant.file) continue;
      const head = await readMediaHead(path.resolve(videoRoot, variant.file));
      if (head !== null && head !== LFS_POINTER_PREFIX) continue;
      const isPointer = head !== null;
      const line = `${address} ${variantId}: ${variant.file}${isPointer ? " (Git LFS pointer)" : ""}`;
      if (isProtectedVariant(state, address, variantId, consumers)) {
        protectedMissing.push(line);
        if (isPointer) protectedPointers += 1;
      } else {
        otherMissing.push(line);
      }
    }
  }

  if (protectedMissing.length > 0) {
    const fetchLfs = "Git LFS objects not fetched (run `git lfs pull`)";
    const cause =
      protectedPointers === 0
        ? "not committed"
        : protectedPointers === protectedMissing.length
          ? fetchLfs
          : `not committed, or ${fetchLfs}`;
    return {
      name: "missing assets",
      status: "FAIL",
      message: `${protectedMissing.length} accepted take(s), patch source(s) or inputs of accepted takes missing their media — ${cause}`,
      details: protectedMissing,
    };
  }
  if (otherMissing.length > 0) {
    return {
      name: "missing assets",
      status: "WARN",
      message: `${otherMissing.length} missing asset(s)`,
    };
  }
  return { name: "missing assets", status: "PASS", message: "all present" };
}

// Repaired by the next state write; a drift here is a hand edit or a save that died after writing
// the state.
export async function checkAssetsGitignore(
  videoRoot: string,
  manager: StateManager,
): Promise<CheckResult> {
  const actual = await readAssetsGitignore(videoRoot);
  if (actual === manager.renderAssetsGitignore()) {
    return { name: "assets/.gitignore", status: "PASS", message: "matches the state" };
  }
  return {
    name: "assets/.gitignore",
    status: "WARN",
    message:
      actual === null
        ? "missing — the next state write restores it, until then git tracks every take"
        : "does not match the state — the next state write regenerates it",
  };
}
