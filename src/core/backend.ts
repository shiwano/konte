import type { AssetDefinition, JobRecord } from "./types/index.js";

export type GenerationRequest = {
  address: string;
  assetDefinition: AssetDefinition;
  variantId: string;
  outputDir: string;
  resolvedDependencies: Record<string, string>;
  // A line for the job log, emitted during submit. The local backend generates inside submit()
  // (there is no wait phase to observe), so what it has to say cannot ride WaitOptions.onLog.
  onLog?: (line: string) => void;
};

export type GenerationResult = {
  files: string[];
  metadata: Record<string, unknown>;
  durationMs: number;
};

// The outcome of waitForCompletion. A waiter's own patience (timeoutMs) running out is NOT a
// job failure — it surfaces as `timedOut` (a returned value, never a thrown error) so the
// backend job is left re-observable instead of being marked failed. Only a genuine backend
// failure throws. This makes "I stopped waiting" structurally impossible to mistake for "the
// job failed": there is no exception to misroute into a failed commit.
export type WaitForCompletionResult =
  | { kind: "done"; result: GenerationResult }
  | { kind: "timedOut" };

export type WaitOptions = {
  onProgress?: (progress: { value: number; max: number; node?: string }) => void;
  // Fired (possibly repeatedly — treat as set-once) the first time the backend reports the
  // job is actually executing, not merely queued. comfy reports it from its "executing" event,
  // its HTTP running-history, or its presence in queue_running; the cloud backends never call
  // it (their submit-time start already is the real basis). Distinct from onProgress because
  // the polling paths observe "running" without any progress tick to carry it.
  onExecutionStarted?: () => void;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  // Consecutive duration with no successful status check before the job's status is
  // flagged unconfirmed (still polling, never failed). Defaults to ~30 min in the backends.
  unconfirmedThresholdMs?: number;
  // Fired when the poll loop crosses into (unconfirmed=true) or out of (unconfirmed=false)
  // a long run of transient status-check failures. Surfaced, never terminal.
  onUnconfirmedChange?: (info: { unconfirmed: boolean; lastError: string | null }) => void;
};

export interface GenerationBackend {
  // `seed` is generated once per job at the submitToBackend seam and reused for every
  // `__konte:seed__` occurrence, so a variant's persisted seed reproduces the submission.
  // A backend whose definition declares no seed placeholder simply ignores it.
  submit(request: GenerationRequest, jobRecord: JobRecord, seed: number): Promise<string>;
  waitForCompletion(
    backendJobId: string,
    outputDir: string,
    options?: WaitOptions,
  ): Promise<WaitForCompletionResult>;
  cancel(jobId: string): Promise<void>;
}
