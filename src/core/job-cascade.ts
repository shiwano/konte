import * as fs from "node:fs/promises";
import { parseAddress } from "./address.js";
import { isJobTerminal, type JobManager, jobLogPath } from "./job-manager.js";
import { StateManager } from "./state/index.js";
import type { GenerationJob, JobRecord } from "./types/index.js";

export type CascadeFailedJob = {
  address: string;
  variantId: string;
  status: string;
  deletedPaths: string[];
};

// Marks pending jobs as failed when the dependency they wait on was removed and
// no other active job can still produce it. Shared by `clean`.
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
  // and don't parse as addresses — drop them rather than treat them as a dependency.
  const cleanedAddresses = new Set(
    removedAddresses.flatMap((a) => {
      try {
        parseAddress(a);
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
      j.dependsOnAssets.some((dep) => cleanedAddresses.has(dep)),
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
          !isJobTerminal(j.status),
      );
      return !hasActiveJob;
    });

    if (!depDead) continue;

    const paths = [jobLogPath(videoRoot, job.variantId)];

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
        await fs.rm(p, { recursive: true, force: true });
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
