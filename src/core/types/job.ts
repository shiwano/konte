import * as path from "node:path";
import { z } from "zod";
import { ComfyModelDeclarationSchema, ComfyNodeDeclarationSchema } from "./definition.js";

// Job and variant ids become on-disk filenames (`.konte/logs/<variantId>.log`)
// and a variant-dir path segment, so a crafted job record in a cloned repo could
// traverse outside the project (the MCP watcher processes these unattended).
// Constrain them to a single path-safe segment.
const JobIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be a single path-safe segment ([A-Za-z0-9_-])");

// An export job's outputDir is resolved against the project root and rendered
// into. Keep it inside the project: relative, no traversal segment, no NUL.
const RelativeDirSchema = z
  .string()
  .min(1)
  .refine(
    (p) => !path.isAbsolute(p) && !p.split(/[/\\]/).includes("..") && !p.includes("\0"),
    "must be a project-relative path without traversal",
  );

export const ProvenanceSchema = z.object({
  workflowHash: z.string().nullable(),
  inputHash: z.string().nullable(),
  resolvedDependencies: z.record(z.string(), z.string()),
  // For a frame-delivery upscale whose source is a composition: the source composition's
  // cache key (compositionCacheKey) captured at submit time, keyed by composition asset path.
  // The key must reflect the composition that was actually upscaled — recomputing it from live
  // state at completion would record a moved composition's key onto an upscale of the old one.
  compositionCacheKeys: z.record(z.string(), z.string()).default({}),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

export const BackendKindSchema = z.enum(["comfy", "fal", "local"]);
export type BackendKind = z.infer<typeof BackendKindSchema>;

// The backends a project chooses between — the ones that run someone else's model. `local` is
// konte's own ffmpeg plumbing, so it is not one of them (see backend-policy).
export const VendorBackendKindSchema = BackendKindSchema.exclude(["local"]);
export type VendorBackendKind = z.infer<typeof VendorBackendKindSchema>;

// The kind of a job. More kinds may be added over time; today there are:
// - "generation": the usual job, tied to an asset variant.
// - "comfy-model-download": a standalone job (no asset/variant of its own) that
//   other jobs can depend on. It exists to serialize and dedup a long download
//   behind an atomic claim. See AGENTS.md "Comfy model download jobs".
// - "comfy-node-install": a standalone job (no asset/variant) that installs one custom
//   node pack via ComfyUI-Manager, deduped per cnr_id behind an atomic claim. Installs
//   to disk only — it never reboots ComfyUI (a reboot is the comfy-node-activate job).
// - "comfy-node-activate": a standalone leaf-ish coordination job that depends on the run's
//   comfy-node-install jobs and, under a server-wide reboot lease, reboots ComfyUI once (only
//   when newly-installed packs are not yet loaded) so the new nodes register. comfy generation
//   jobs depend on this so nothing generates before the nodes are live.
// - "export": a standalone job (no asset/variant of its own) that renders the video
//   to a delivered MP4. It is the leaf of the dependency graph — nothing
//   depends on its output — so it needs no address; it consumes the resolved layer
//   and #delivery assets it depends on. Run by `run-export-job`, like a model download.
export const JobKindSchema = z.enum([
  "generation",
  "comfy-model-download",
  "comfy-node-install",
  "comfy-node-activate",
  "export",
]);
export type JobKind = z.infer<typeof JobKindSchema>;

// A run lease for jobs executed locally by a worker (export renders, and potentially
// other long local jobs). The owner renews `expiresAt` via heartbeat while running; a
// crashed owner stops renewing, so after the lease expires exactly one other worker may
// reclaim the job. Distinguishes "running, owner alive" from "running, owner dead" —
// which job status alone cannot — making reclaim safe across multiple concurrent watchers.
const JobLeaseSchema = z.object({
  owner: z.string(),
  expiresAt: z.string(),
});

const JobRecordBaseSchema = z.object({
  id: JobIdSchema,
  status: z.enum(["pending", "queued", "running", "completed", "failed", "cancelled"]),
  backendKind: BackendKindSchema,
  // Ids of other jobs this job waits on before it can submit (looked up by filename).
  dependsOnJobs: z.array(JobIdSchema).default([]),
  lease: JobLeaseSchema.nullable().default(null),
  progress: z.number().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  // Stamped the first time the job enters "running"; null while pending/queued.
  // Used to compute elapsed time (see JobManager.updateJobUnlocked). For a serial-queue
  // backend (comfy) this is the enqueue instant, not when work actually started — every
  // batched job gets ~the same startedAt, so its run window is inflated by the jobs ahead
  // of it. Use processingStartedAt for a queue-independent per-job runtime.
  startedAt: z.string().nullable().default(null),
  // Stamped once, the first time the backend reports work has actually begun (ComfyUI's first
  // "executing" event) — i.e. after any serial-queue wait. Set-once (see updateJobUnlocked) so a
  // reclaimer can't overwrite an earlier true start. Currently stamped for comfy only; null for
  // cloud backends (whose submit-time startedAt already is the right basis) and for jobs that
  // finished without emitting progress. Job duration stats measure from this when set, so a comfy
  // job's per-job runtime isn't inflated by however many jobs were queued ahead of it.
  processingStartedAt: z.string().nullable().default(null),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  // Set (ISO timestamp) while a non-terminal job's status checks have been failing
  // transiently for a long stretch — e.g. a backend outage. The job is still polled
  // and never auto-failed; this only surfaces "couldn't confirm status" to the human.
  // Cleared once a status check succeeds or the job reaches a terminal state.
  unconfirmedSince: z.string().nullable().default(null),
  // The definition files as the creating process read them (see definition-source.ts). A judge
  // whose definition hash disagrees with the job's while this still matches the files on disk is
  // holding stale definitions; null for the standalone kinds, which read no definition.
  sourceFingerprint: z.string().nullable().default(null),
  // How many times a stale judge handed the job back (pending again, lease dropped) instead of
  // failing it. The second such judge fails it: the disagreement is then in what no fingerprinted
  // file explains, not in one process's memory.
  staleReleases: z.number().int().default(0),
});

export const GenerationJobSchema = JobRecordBaseSchema.extend({
  kind: z.literal("generation"),
  // The asset variant this job produces (a `v-…` id). Equals `id` for generation
  // jobs, but is a distinct concept: identity vs produced output.
  variantId: JobIdSchema,
  address: z.string(),
  dependsOnAssets: z.array(z.string()).default([]),
  backendJobId: z.string().nullable(),
  submissionStartedAt: z.string().nullable().default(null),
  outputFiles: z.array(z.string()),
  provenance: ProvenanceSchema,
});

export const ComfyModelDownloadJobSchema = JobRecordBaseSchema.extend({
  kind: z.literal("comfy-model-download"),
  model: ComfyModelDeclarationSchema,
});

export const ComfyNodeInstallJobSchema = JobRecordBaseSchema.extend({
  kind: z.literal("comfy-node-install"),
  node: ComfyNodeDeclarationSchema,
});

export const ComfyNodeActivateJobSchema = JobRecordBaseSchema.extend({
  kind: z.literal("comfy-node-activate"),
  // The cnr_ids whose loaded-state this job verifies (and reboots ComfyUI to load if needed).
  cnrIds: z.array(z.string()).default([]),
});

export const ExportJobSchema = JobRecordBaseSchema.extend({
  kind: z.literal("export"),
  // Addresses (including #delivery targets) whose files the render consumes.
  dependsOnAssets: z.array(z.string()).default([]),
  // Project-relative output dir (the timestamped dist/video/<ts>) and final file.
  outputDir: RelativeDirSchema,
  outputFile: z.string().nullable().default(null),
  allowUnaccepted: z.boolean().default(false),
  // A working-size composite check that skips delivery upscales; its attempt dir is
  // suffixed `_no_delivery` so it never masquerades as the real deliverable.
  noDelivery: z.boolean().default(false),
  // Fingerprint of the definition this export actually rendered — see computeExportSignature,
  // stamped by the worker on completion from the reloaded definition (not at submit). `status`
  // re-derives it from the current definition and flags the last export as out of date when it no
  // longer matches. Null until completion, for a no-delivery check (not a real deliverable), and
  // for legacy jobs predating the field (can't verify → not flagged).
  exportSignature: z.string().nullable().default(null),
  // What the definition said the export would be when it was registered (see
  // computeExportPlanDigest): the render worker recomputes it from the definition it reloaded, and
  // a disagreement with the files unchanged means the worker, not the definition, is stale.
  planDigest: z.string().nullable().default(null),
});

export const JobRecordSchema = z.discriminatedUnion("kind", [
  GenerationJobSchema,
  ComfyModelDownloadJobSchema,
  ComfyNodeInstallJobSchema,
  ComfyNodeActivateJobSchema,
  ExportJobSchema,
]);

export type GenerationJob = z.infer<typeof GenerationJobSchema>;
export type ComfyModelDownloadJob = z.infer<typeof ComfyModelDownloadJobSchema>;
export type ComfyNodeInstallJob = z.infer<typeof ComfyNodeInstallJobSchema>;
export type ComfyNodeActivateJob = z.infer<typeof ComfyNodeActivateJobSchema>;
export type ExportJob = z.infer<typeof ExportJobSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type JobRecordInput = z.input<typeof JobRecordSchema>;
