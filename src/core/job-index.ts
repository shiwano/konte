import type { GenerationJob, JobRecord } from "./types/index.js";

function isActiveGeneration(job: JobRecord): job is GenerationJob {
  return (
    job.kind === "generation" &&
    (job.status === "running" || job.status === "queued" || job.status === "pending")
  );
}

/**
 * Lookup index over a set of job records: by id, plus a per-address count of active
 * (pending/queued/running) generation jobs. The `allJobs.find` / `allJobs.some` linear scans
 * made every per-job evaluation O(jobs) — quadratic across a cascade pass or a status sweep.
 * Built from one `listJobs()` snapshot; `add` keeps a long-lived index in step with jobs a
 * run creates. Records are treated as immutable snapshots — a status that changed on disk is
 * picked up by rebuilding from a fresh listing, exactly as the array snapshot was.
 */
export class JobIndex {
  private readonly list: JobRecord[] = [];
  private readonly byId = new Map<string, JobRecord>();
  private readonly activeGenerationByAddress = new Map<string, number>();

  constructor(jobs: readonly JobRecord[] = []) {
    for (const job of jobs) this.add(job);
  }

  get jobs(): readonly JobRecord[] {
    return this.list;
  }

  get(id: string): JobRecord | undefined {
    return this.byId.get(id);
  }

  add(job: JobRecord): void {
    if (this.byId.has(job.id)) return;
    this.list.push(job);
    this.byId.set(job.id, job);
    if (isActiveGeneration(job)) {
      const count = this.activeGenerationByAddress.get(job.address) ?? 0;
      this.activeGenerationByAddress.set(job.address, count + 1);
    }
  }

  // Replace a record with a fresher read of the same job — for a long-lived index whose
  // snapshot ages while jobs settle concurrently (e.g. a prereq completing mid-run).
  update(job: JobRecord): void {
    const prev = this.byId.get(job.id);
    if (!prev) {
      this.add(job);
      return;
    }
    this.byId.set(job.id, job);
    const i = this.list.indexOf(prev);
    if (i >= 0) this.list[i] = job;
    const wasActive = isActiveGeneration(prev);
    const nowActive = isActiveGeneration(job);
    if (wasActive !== nowActive && job.kind === "generation") {
      const count = this.activeGenerationByAddress.get(job.address) ?? 0;
      this.activeGenerationByAddress.set(job.address, count + (nowActive ? 1 : -1));
    }
  }

  // Whether some generation job is currently producing `address`. A downstream job must
  // wait for it even when a prior (stale) variant of that upstream already has a file —
  // otherwise regenerating a cross-shot chain submits every downstream at once, each
  // consuming the old upstream instead of the fresh one it was queued to build on.
  hasActiveJobFor(address: string): boolean {
    return (this.activeGenerationByAddress.get(address) ?? 0) > 0;
  }
}
