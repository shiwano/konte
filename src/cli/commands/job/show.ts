import type { Command } from "commander";
import { ADAPTER_KEY_METADATA_KEY } from "../../../core/adapter-key.js";
import { formatDuration } from "../../../core/format-duration.js";
import { formatRelativeTime, formatTimestamp } from "../../../core/format-timestamp.js";
import { comfyQueueAhead, computeJobTiming, diagnoseJob } from "../../../core/job-diagnosis.js";
import { isJobTerminal, JobManager } from "../../../core/job-manager.js";
import { indexJobStats, type JobStatBucket, statsForJob } from "../../../core/job-stats.js";
import type { JobRecord } from "../../../core/types/index.js";
import { requireVideoRoot } from "../../context.js";
import { jobTarget } from "./list.js";

function adapterKeyOf(job: JobRecord): string | null {
  const key = job.metadata[ADAPTER_KEY_METADATA_KEY];
  return typeof key === "string" && key !== "" ? key : null;
}

function leaseLine(job: JobRecord, now: number): string {
  if (isJobTerminal(job.status)) return "-";
  if (!job.lease) return "unclaimed";
  const expiresAt = Date.parse(job.lease.expiresAt);
  return expiresAt > now
    ? `held by ${job.lease.owner} (expires in ${formatDuration(expiresAt - now)})`
    : `${job.lease.owner}, expired ${formatDuration(now - expiresAt)} ago`;
}

function timestampCell(iso: string | null, now: number): string {
  if (!iso) return "-";
  return `${formatTimestamp(iso)} (${formatRelativeTime(iso, new Date(now))})`;
}

// The `executing` line for a comfy prompt that has not started: why it has not, in the terms the
// wait is actually measured in — how much of ComfyUI's serial queue is still ahead of it.
function notStartedLine(queueAhead: number | null): string {
  if (queueAhead === null) return "not started";
  if (queueAhead === 0) return "not started — next in ComfyUI's queue";
  return `not started — ${queueAhead} prompt(s) ahead in ComfyUI's queue`;
}

function printJob(
  job: JobRecord,
  dependencies: readonly JobRecord[],
  stats: JobStatBucket | null,
  diagnoses: readonly string[],
  queueAhead: number | null,
  now: number,
): void {
  const timing = computeJobTiming(job, now);

  console.log(`Job: ${job.id}`);
  console.log(`Kind: ${job.kind}`);
  console.log(`Status: ${job.status}`);
  console.log(`Target: ${jobTarget(job)}`);
  console.log(`Backend: ${job.backendKind}`);
  const adapterKey = adapterKeyOf(job);
  if (adapterKey) console.log(`Adapter: ${adapterKey}`);
  if (job.kind === "generation" && job.backendJobId) {
    console.log(`Backend job: ${job.backendJobId}`);
  }
  console.log(`Lease: ${leaseLine(job, now)}`);
  if (job.progress !== null) console.log(`Progress: ${job.progress}%`);

  console.log("Timing:");
  console.log(`  created    ${timestampCell(job.createdAt, now)}`);
  console.log(`  started    ${timestampCell(job.startedAt, now)}`);
  // The single most diagnostic line for a comfy job: an execution start that never arrived
  // separates "the model is slow" from "the prompt never ran".
  console.log(
    `  executing  ${
      job.processingStartedAt
        ? `${timestampCell(job.processingStartedAt, now)}${
            timing.queuedMs !== null ? ` — ${formatDuration(timing.queuedMs)} queued` : ""
          }`
        : job.backendKind === "comfy" && job.startedAt
          ? notStartedLine(queueAhead)
          : "-"
    }`,
  );
  if (timing.elapsedMs !== null) {
    const basis = timing.elapsedFrom === "execution" ? "executing" : "since submit";
    console.log(`  elapsed    ${formatDuration(timing.elapsedMs)} ${basis}`);
  }
  console.log(`  total      ${formatDuration(timing.totalMs)} since created`);
  if (stats) {
    console.log(
      `  typical    p50 ${formatDuration(stats.p50Ms)}, p90 ${formatDuration(stats.p90Ms)} over ${stats.count} run(s)`,
    );
  }

  if (dependencies.length > 0) {
    console.log("Depends on jobs:");
    for (const dep of dependencies) {
      console.log(`  ${dep.id}  ${dep.status}  ${jobTarget(dep)}`);
    }
  }
  // Ids that resolved to no job file: a dependency was pruned, so nothing will ever complete it.
  const missingDeps = job.dependsOnJobs.filter((id) => !dependencies.some((d) => d.id === id));
  if (missingDeps.length > 0) {
    console.log(`Missing dependency jobs: ${missingDeps.join(", ")}`);
  }

  if ((job.kind === "generation" || job.kind === "export") && job.dependsOnAssets.length > 0) {
    console.log("Depends on assets:");
    for (const address of job.dependsOnAssets) console.log(`  ${address}`);
  }

  if (job.kind === "generation" && job.outputFiles.length > 0) {
    console.log("Outputs:");
    for (const file of job.outputFiles) console.log(`  ${file}`);
  }
  if (job.kind === "export" && job.outputFile) {
    console.log(`Output: ${job.outputFile}`);
  }

  if (diagnoses.length > 0) {
    console.log("Diagnosis:");
    for (const d of diagnoses) console.log(`  ${d}`);
  }
}

export function registerJobShowCommand(program: Command): void {
  program
    .command("show <jobId>")
    .description("Show one job in detail, with a diagnosis of its current state")
    .addHelpText(
      "after",
      "\nPrints a single job's identity, its timing split into queue wait and execution time,\n" +
        "its run lease, its dependencies, and a diagnosis of anything notable — a prompt that\n" +
        "never started executing, a run far past the adapter's typical duration, a job no worker\n" +
        "is watching, or a backend that stopped answering. A healthy job carries no diagnosis.\n" +
        "\nExamples:\n" +
        "  konte job show v-lkWsgLMT   A generation job (the id is its variant id)\n" +
        "  konte job show cmd-9f2a1c   A comfy model download",
    )
    .action(async (jobId: string) => {
      const videoRoot = requireVideoRoot();
      const jobManager = new JobManager(videoRoot);
      const now = Date.now();

      const job = await jobManager.getJob(jobId);
      const allJobs = await jobManager.listJobs();
      // A pruned dependency simply drops out here; printJob names the ids that went missing.
      const dependencies = job.dependsOnJobs
        .map((id) => allJobs.find((j) => j.id === id))
        .filter((j): j is JobRecord => j !== undefined);

      const stats = statsForJob(job, indexJobStats(allJobs));
      const diagnoses = diagnoseJob({ job, dependencies, stats, now });
      const queueAhead = comfyQueueAhead(job, allJobs);

      printJob(job, dependencies, stats, diagnoses, queueAhead, now);
    });
}
