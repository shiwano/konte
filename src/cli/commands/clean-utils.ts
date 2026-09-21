import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAssetPath } from "../../core/address.js";
import type { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/index.js";
import type { GenerationJob, JobRecord } from "../../core/types/index.js";

const KONTE_DIR = ".konte";
const LOGS_DIR = "logs";

export async function removePathSafely(p: string): Promise<boolean> {
  try {
    await fs.rm(p, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function getPathSize(p: string): Promise<number> {
  try {
    const stat = await fs.stat(p);
    if (stat.isFile()) return stat.size;
    if (stat.isDirectory()) {
      let total = 0;
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const entry of entries) {
        total += await getPathSize(path.join(p, entry.name));
      }
      return total;
    }
    return 0;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export type CascadeFailedJob = {
  address: string;
  variantId: string;
  status: string;
  deletedPaths: string[];
};

// Marks pending jobs as failed when the dependency they wait on was removed and
// no other active job can still produce it. Shared by `clean` and `prune`.
export async function cascadeFailPendingJobs(
  videoRoot: string,
  removedAddresses: string[],
  allJobs: JobRecord[],
  jobManager: JobManager,
  opts: { dryRun?: boolean },
): Promise<CascadeFailedJob[]> {
  const cascadeFailed: CascadeFailedJob[] = [];
  if (removedAddresses.length === 0) return cascadeFailed;

  // Feedback-only targets (bare shot-level addresses, no asset name) can't be a job dependency
  // and don't parse as asset paths — drop them rather than treat them as a dependency.
  const cleanedAssetPaths = new Set(
    removedAddresses.flatMap((a) => {
      try {
        parseAssetPath(a);
        return [a];
      } catch {
        return [];
      }
    }),
  );
  const affectedPending = allJobs.filter(
    (j): j is GenerationJob =>
      j.kind === "generation" &&
      j.status === "pending" &&
      j.dependsOnAssets.some((dep) => cleanedAssetPaths.has(dep)),
  );
  if (affectedPending.length === 0) return cascadeFailed;

  const freshState = (await StateManager.load(videoRoot)).getState();

  for (const job of affectedPending) {
    const depDead = job.dependsOnAssets.some((depAddress) => {
      const target = freshState.assets[depAddress];
      const hasFile = target ? Object.values(target.variants ?? {}).some((v) => v.file) : false;
      if (hasFile) return false;
      const hasActiveJob = allJobs.some(
        (j) =>
          j.kind === "generation" &&
          j.address === depAddress &&
          j.variantId !== job.variantId &&
          (j.status === "running" || j.status === "queued" || j.status === "pending"),
      );
      return !hasActiveJob;
    });

    if (!depDead) continue;

    const paths = [path.join(videoRoot, KONTE_DIR, LOGS_DIR, `${job.variantId}.log`)];

    if (!opts.dryRun) {
      // Compare-and-set on the status this job was selected under: the list was snapshotted
      // before the confirmation prompt, so while the user read it the watcher may have submitted
      // this job (now "running", holding a live backend job) or completed it. Only a job still
      // waiting on the cleaned dependency may be failed — anything else keeps its state and its
      // job/log files.
      const committed = await jobManager.updateIfStatus(job.variantId, ["pending"], {
        status: "failed",
        error: "Dependency cleaned",
        completedAt: new Date().toISOString(),
      });
      if (!committed) continue;

      await StateManager.withLock(videoRoot, async (mgr) => {
        const target = mgr.getState().assets[job.address];
        const variant = target?.variants?.[job.variantId];
        if (variant) {
          variant.metadata = { error: "Dependency cleaned" };
        }
      });
      for (const p of paths) {
        await removePathSafely(p);
      }
      await jobManager.deleteJob(job.variantId);
    }

    cascadeFailed.push({
      address: job.address,
      variantId: job.variantId,
      status: "pending → failed",
      deletedPaths: paths,
    });
  }

  return cascadeFailed;
}
