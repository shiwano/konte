import { describe, expect, it } from "vitest";
import { ADAPTER_KEY_METADATA_KEY } from "../adapter-key.js";
import { bucketKey, computeJobStats, percentile } from "../job-stats.js";
import type { JobRecord } from "../types/index.js";

function makeJob(
  overrides: Partial<JobRecord> & {
    variantId: string;
    startedAt: string | null;
    completedAt: string | null;
  },
): JobRecord {
  return {
    kind: "generation",
    address: "video:shot.01.motion",
    status: "completed",
    dependsOnAssets: [],
    dependsOnJobs: [],
    lease: null,
    backendKind: "fal",
    backendJobId: null,
    progress: 100,
    error: null,
    outputFiles: ["out.mp4"],
    metadata: { [ADAPTER_KEY_METADATA_KEY]: "fal-ai/kling" },
    provenance: { workflowHash: null, inputHash: null, resolvedDependencies: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as JobRecord;
}

// A job that ran for `seconds` seconds, ending at a fixed instant.
function ranFor(variantId: string, seconds: number, extra: Partial<JobRecord> = {}): JobRecord {
  return ran(variantId, seconds, "2026-01-01T00:10:00.000Z", extra);
}

// A job that ran for `seconds` seconds, ending at `endIso` (lets a test control lastRunAt).
function ran(
  variantId: string,
  seconds: number,
  endIso: string,
  extra: Partial<JobRecord> = {},
): JobRecord {
  const start = new Date(new Date(endIso).getTime() - seconds * 1000).toISOString();
  return makeJob({ variantId, startedAt: start, completedAt: endIso, ...extra });
}

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("computes nearest-rank p50 and p90", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 90)).toBe(90);
    expect(percentile(sorted, 100)).toBe(100);
  });

  it("handles a single sample", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 90)).toBe(42);
  });
});

describe("computeJobStats", () => {
  it("groups by (backendKind, adapterKey) and computes durations", () => {
    const jobs = [ranFor("v-1", 10), ranFor("v-2", 20), ranFor("v-3", 30)];
    const buckets = computeJobStats(jobs);
    expect(buckets).toHaveLength(1);
    const b = buckets[0]!;
    expect(bucketKey(b.backendKind, b.adapterKey)).toBe("fal|fal-ai/kling");
    expect(b.count).toBe(3);
    expect(b.p50Ms).toBe(20_000);
    expect(b.meanMs).toBe(20_000);
  });

  it("splits adapters into separate buckets", () => {
    const jobs = [
      ranFor("v-1", 10),
      ranFor("v-3", 10, {
        backendKind: "fal",
        metadata: { [ADAPTER_KEY_METADATA_KEY]: "kwaivgi/kling" },
      }),
    ];
    expect(computeJobStats(jobs)).toHaveLength(2);
  });

  it("excludes non-ready, unmeasurable, and unstamped jobs", () => {
    const jobs = [
      ranFor("v-ok", 10),
      ranFor("v-running", 10, { status: "running" }),
      ranFor("v-failed", 10, { status: "failed" }),
      makeJob({
        variantId: "v-nostart",
        startedAt: null,
        completedAt: "2026-01-01T00:10:00.000Z",
      }),
      ranFor("v-nokey", 10, { metadata: {} }),
      ranFor("v-emptykey", 10, { metadata: { [ADAPTER_KEY_METADATA_KEY]: "" } }),
    ];
    const buckets = computeJobStats(jobs);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.count).toBe(1);
  });

  it("ignores non-generation job kinds", () => {
    const jobs = [
      ranFor("v-1", 10),
      {
        kind: "export",
        id: "e-1",
        status: "completed",
        backendKind: "local",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:10:00.000Z",
        metadata: { [ADAPTER_KEY_METADATA_KEY]: "x" },
      } as unknown as JobRecord,
    ];
    expect(computeJobStats(jobs)).toHaveLength(1);
  });

  it("records the latest completedAt as lastRunAt", () => {
    const jobs = [
      makeJob({
        variantId: "v-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
      }),
      makeJob({
        variantId: "v-2",
        startedAt: "2026-01-02T00:00:00.000Z",
        completedAt: "2026-01-02T00:05:00.000Z",
      }),
    ];
    expect(computeJobStats(jobs)[0]!.lastRunAt).toBe("2026-01-02T00:05:00.000Z");
  });

  it("measures from processingStartedAt when set, ignoring the enqueue-time startedAt", () => {
    // A comfy job enqueued at 00:00 but not actually run by ComfyUI until 00:08 (queued
    // behind others): its runtime is 2 min, not the 10 min the enqueue window would show.
    const job = makeJob({
      variantId: "v-1",
      backendKind: "comfy",
      startedAt: "2026-01-01T00:00:00.000Z",
      processingStartedAt: "2026-01-01T00:08:00.000Z",
      completedAt: "2026-01-01T00:10:00.000Z",
    });
    expect(computeJobStats([job])[0]!.p50Ms).toBe(120_000);
  });

  it("falls back to startedAt when processingStartedAt is null", () => {
    const job = makeJob({
      variantId: "v-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      processingStartedAt: null,
      completedAt: "2026-01-01T00:10:00.000Z",
    });
    expect(computeJobStats([job])[0]!.p50Ms).toBe(600_000);
  });

  it("leaves modes null for a single unimodal cluster", () => {
    const jobs = [ranFor("v-1", 10), ranFor("v-2", 20), ranFor("v-3", 30)];
    expect(computeJobStats(jobs)[0]!.modes).toBeNull();
  });

  it("splits into fast/slow modes when durations form two separated clusters", () => {
    const jobs = [
      ...[20, 21, 22, 23, 24].map((s, i) => ranFor(`v-fast-${i}`, s)),
      ...[88, 90, 91, 92, 94].map((s, i) => ranFor(`v-slow-${i}`, s)),
    ];
    const bucket = computeJobStats(jobs)[0]!;
    expect(bucket.count).toBe(10);
    const modes = bucket.modes;
    if (!modes) throw new Error("expected the bucket to split into modes");
    const [fast, slow] = modes;
    expect(fast.label).toBe("fast");
    expect(slow.label).toBe("slow");
    expect(fast.count).toBe(5);
    expect(slow.count).toBe(5);
    expect(fast.p50Ms).toBe(22_000);
    expect(slow.p50Ms).toBe(91_000);
  });

  it("does not split when either side would hold fewer than five samples", () => {
    const jobs = [
      ...[20, 21, 22, 23].map((s, i) => ranFor(`v-fast-${i}`, s)),
      ...[88, 90, 91, 92, 94].map((s, i) => ranFor(`v-slow-${i}`, s)),
    ];
    expect(computeJobStats(jobs)[0]!.modes).toBeNull();
  });

  it("does not split a spread-out unimodal bucket whose gap does not dominate its spread", () => {
    const jobs = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65].map((s, i) => ranFor(`v-${i}`, s));
    expect(computeJobStats(jobs)[0]!.modes).toBeNull();
  });

  it("does not split two near-identical clusters separated by only a trivial gap", () => {
    // Both sides have ~zero internal spread, so the IQR gate alone would split on the 1s gap;
    // the separation-ratio gate keeps 100s vs 101s as one mode.
    const jobs = [
      ...Array.from({ length: 5 }, (_, i) => ranFor(`v-a-${i}`, 100)),
      ...Array.from({ length: 5 }, (_, i) => ranFor(`v-b-${i}`, 101)),
    ];
    expect(computeJobStats(jobs)[0]!.modes).toBeNull();
  });

  it("splits identical-within clusters when they are far enough apart", () => {
    const jobs = [
      ...Array.from({ length: 5 }, (_, i) => ranFor(`v-fast-${i}`, 20)),
      ...Array.from({ length: 5 }, (_, i) => ranFor(`v-slow-${i}`, 90)),
    ];
    const modes = computeJobStats(jobs)[0]!.modes;
    if (!modes) throw new Error("expected the bucket to split into modes");
    expect(modes[0].p50Ms).toBe(20_000);
    expect(modes[1].p50Ms).toBe(90_000);
  });

  it("computes each mode's lastRunAt from its own samples", () => {
    const jobs = [
      ...[20, 21, 22, 23, 24].map((s, i) => ran(`v-fast-${i}`, s, "2026-01-01T00:05:00.000Z")),
      ...[88, 90, 91, 92, 94].map((s, i) => ran(`v-slow-${i}`, s, "2026-03-01T00:05:00.000Z")),
    ];
    const modes = computeJobStats(jobs)[0]!.modes;
    if (!modes) throw new Error("expected the bucket to split into modes");
    const [fast, slow] = modes;
    expect(fast.lastRunAt).toBe("2026-01-01T00:05:00.000Z");
    expect(slow.lastRunAt).toBe("2026-03-01T00:05:00.000Z");
  });
});
