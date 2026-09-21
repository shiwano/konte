import { ADAPTER_KEY_METADATA_KEY } from "./adapter-key.js";
import type { BackendKind, JobRecord } from "./types/index.js";

// Nearest-rank percentile over an ascending-sorted array (p in [0, 100]).
// Empty input yields 0. p50 is the median, p90 the 90th percentile.
export function percentile(sortedAscMs: number[], p: number): number {
  if (sortedAscMs.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAscMs.length);
  const index = Math.min(sortedAscMs.length - 1, Math.max(0, rank - 1));
  return sortedAscMs[index]!;
}

// A mode's median only means something once it has a handful of samples; below this a "split"
// would just be re-listing raw points, so both sides of a split must clear it.
const MIN_MODE_SAMPLES = 5;

// The slow group must sit at least this far above the fast one (gap as a fraction of the fast
// median) to count as a separate mode. Guards the degenerate case where both groups have ~zero
// internal spread — there the IQR gate alone would split on a trivially small gap.
const MIN_SEPARATION_RATIO = 0.25;

type Sample = { ms: number; completedAt: string };

type JobStatMode = {
  label: "fast" | "slow";
  count: number;
  p50Ms: number;
  p90Ms: number;
  meanMs: number;
  lastRunAt: string;
};

export type JobStatBucket = {
  backendKind: BackendKind;
  adapterKey: string;
  count: number;
  p50Ms: number;
  p90Ms: number;
  meanMs: number;
  lastRunAt: string;
  // Present (exactly two entries — fast then slow) when the bucket's durations split cleanly
  // into two well-separated groups — an adapter run under two distinct runtime regimes, whose
  // blended p50/p90 would describe neither. Null when the durations read as one cluster, or when
  // there are too few to tell two apart. The aggregate fields above always span every sample
  // regardless, so a consumer that ignores modes still sees the whole bucket.
  modes: [JobStatMode, JobStatMode] | null;
};

// Stable identity for a (backendKind, adapterKey) bucket, shared by the aggregator
// and any per-bucket lookups.
export function bucketKey(backendKind: BackendKind, adapterKey: string): string {
  return `${backendKind}|${adapterKey}`;
}

// The buckets keyed for per-job lookup, aggregated once — so a listing that judges every row
// against its own adapter doesn't re-aggregate the whole history per row.
export function indexJobStats(jobs: readonly JobRecord[]): Map<string, JobStatBucket> {
  return new Map(computeJobStats(jobs).map((b) => [bucketKey(b.backendKind, b.adapterKey), b]));
}

// A job's own adapter bucket, so its timing reads against the runs it should resemble rather
// than against a bare number. Null for a kind that carries no adapter, or one with no completed
// runs to average yet.
export function statsForJob(
  job: JobRecord,
  index: Map<string, JobStatBucket>,
): JobStatBucket | null {
  const adapterKey = job.metadata[ADAPTER_KEY_METADATA_KEY];
  if (typeof adapterKey !== "string" || adapterKey === "") return null;
  return index.get(bucketKey(job.backendKind, adapterKey)) ?? null;
}

// Interquartile range (p75 - p25) — a spread measure robust to a lone slow/fast outlier,
// used to judge whether a gap between two groups is wide enough to call them distinct.
function iqr(sortedMs: number[]): number {
  return percentile(sortedMs, 75) - percentile(sortedMs, 25);
}

function statsFor(samples: Sample[]): Omit<JobStatMode, "label"> {
  const durations = samples.map((s) => s.ms).sort((a, b) => a - b);
  const sum = durations.reduce((acc, d) => acc + d, 0);
  let lastRunAt = samples[0]!.completedAt;
  for (const s of samples) if (s.completedAt > lastRunAt) lastRunAt = s.completedAt;
  return {
    count: durations.length,
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    meanMs: Math.round(sum / durations.length),
    lastRunAt,
  };
}

// Split a bucket's samples into a fast and a slow group at their widest internal gap, but only
// when the split is credible: each side holds >= MIN_MODE_SAMPLES, the gap dominates the
// within-side spread (> 2x the larger IQR), and the two groups are separated by a meaningful
// margin (MIN_SEPARATION_RATIO). Returns null otherwise. The 2x-IQR gate keeps a merely
// spread-out unimodal bucket from being torn in two on noise; the ratio gate keeps two nearly
// identical clusters (~zero spread, tiny gap) from being called distinct modes.
function splitIntoModes(samples: Sample[]): [Sample[], Sample[]] | null {
  const sorted = [...samples].sort((a, b) => a.ms - b.ms);
  const n = sorted.length;
  if (n < MIN_MODE_SAMPLES * 2) return null;

  let bestGap = -1;
  let bestIdx = -1;
  for (let i = MIN_MODE_SAMPLES; i <= n - MIN_MODE_SAMPLES; i++) {
    const gap = sorted[i]!.ms - sorted[i - 1]!.ms;
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;

  const lower = sorted.slice(0, bestIdx);
  const upper = sorted.slice(bestIdx);
  const lowerMs = lower.map((s) => s.ms);
  const spread = Math.max(iqr(lowerMs), iqr(upper.map((s) => s.ms)));
  if (bestGap <= 2 * spread) return null;
  if (bestGap < percentile(lowerMs, 50) * MIN_SEPARATION_RATIO) return null;
  return [lower, upper];
}

// Aggregate completed generation jobs into per-adapter duration stats, splitting a
// bucket into fast/slow modes when its durations form two well-separated clusters.
// Only ready jobs with a stamped adapterKey and a measurable run window count; jobs from before
// adapterKey stamping (or non-generation kinds) are silently excluded.
export function computeJobStats(jobs: readonly JobRecord[]): JobStatBucket[] {
  const groups = new Map<
    string,
    {
      backendKind: BackendKind;
      adapterKey: string;
      samples: Sample[];
    }
  >();

  for (const job of jobs) {
    if (job.kind !== "generation" || job.status !== "completed") continue;
    // Prefer processingStartedAt (actual work start, after any serial-queue wait) so a
    // comfy job's runtime isn't inflated by the jobs queued ahead of it in that run; fall
    // back to startedAt for backends/records that never stamped a processing start.
    const runStart = job.processingStartedAt ?? job.startedAt;
    if (!runStart || !job.completedAt) continue;
    const adapterKey = job.metadata[ADAPTER_KEY_METADATA_KEY];
    if (typeof adapterKey !== "string" || adapterKey === "") continue;

    const durationMs = new Date(job.completedAt).getTime() - new Date(runStart).getTime();
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;

    const key = bucketKey(job.backendKind, adapterKey);
    const sample: Sample = { ms: durationMs, completedAt: job.completedAt };
    const group = groups.get(key);
    if (group) {
      group.samples.push(sample);
    } else {
      groups.set(key, {
        backendKind: job.backendKind,
        adapterKey,
        samples: [sample],
      });
    }
  }

  const buckets: JobStatBucket[] = [];
  for (const group of groups.values()) {
    const split = splitIntoModes(group.samples);
    const modes: [JobStatMode, JobStatMode] | null = split
      ? [
          { label: "fast", ...statsFor(split[0]) },
          { label: "slow", ...statsFor(split[1]) },
        ]
      : null;
    buckets.push({
      backendKind: group.backendKind,
      adapterKey: group.adapterKey,
      ...statsFor(group.samples),
      modes,
    });
  }

  return buckets.sort(
    (a, b) =>
      b.count - a.count ||
      a.backendKind.localeCompare(b.backendKind) ||
      a.adapterKey.localeCompare(b.adapterKey),
  );
}
