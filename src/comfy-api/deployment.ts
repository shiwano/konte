import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadKonteConfig } from "../core/config.js";
import { hasLiveDaemon } from "../core/daemon-registry.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { withFileLock } from "../core/file-lock.js";
import { isJobTerminal, JobManager } from "../core/job-manager.js";
import { listVideos, VIDEOS_DIR } from "../core/roots.js";
import { sleep } from "../core/sleep.js";
import type {
  ComfyApiDeploymentConfig,
  ComfyTarget,
  JobRecord,
  KonteConfig,
} from "../core/types/index.js";
import {
  adaptersRoutedTo,
  buildInputs,
  DEFAULT_VERSION_RESOLVERS,
  hashOf,
  resolveBuildDefinition,
  type VersionResolvers,
  workspaceComfyAdapters,
} from "./build-definition.js";
import {
  type DeploymentState,
  deploymentLockPath,
  loadDeploymentState,
  loadDeploymentStates,
  updateDeploymentState,
} from "./deploy-state.js";
import { ComfyApiHttpError } from "./http.js";
import {
  ComfyPlatformClient,
  type ComputeConfig,
  type PlatformDeployment,
} from "./platform-client.js";
import { ComfyRouter } from "./routing.js";

export const DEFAULT_IDLE_MINUTES = 15;

export type DeployTiming = {
  releasePollMs: number;
  releaseTimeoutMs: number;
  deploymentPollMs: number;
  deploymentTimeoutMs: number;
  // Bring-up waits out another process's whole release build behind the same lock.
  lockTimeoutMs: number;
};

const DEFAULT_TIMING: DeployTiming = {
  releasePollMs: 10_000,
  releaseTimeoutMs: 60 * 60_000,
  deploymentPollMs: 5_000,
  deploymentTimeoutMs: 30 * 60_000,
  lockTimeoutMs: 90 * 60_000,
};

export type DeployContext = {
  workspaceRoot: string;
  config: KonteConfig;
  apiKey: string;
  log: (line: string) => void;
  // Polled between steps and while waiting; true stops before anything more is created.
  shouldCancel?: () => Promise<boolean>;
  platform?: ComfyPlatformClient;
  router?: ComfyRouter;
  resolvers?: VersionResolvers;
  timing?: Partial<DeployTiming>;
};

export function deploymentConfig(config: KonteConfig, name: string): ComfyApiDeploymentConfig {
  const declared = config.comfy?.comfyapi?.deployments?.[name];
  if (!declared) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `No Comfy API deployment "${name}" under comfy.comfyapi.deployments in konte.config.json`,
    );
  }
  return declared;
}

function computeConfigOf(declared: ComfyApiDeploymentConfig): ComputeConfig {
  return { gpuClass: declared.gpuClass, region: declared.region, min: 0, max: declared.max ?? 1 };
}

function buildName(workspaceRoot: string, name: string): string {
  return `konte-${path.basename(workspaceRoot)}-${name}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Bring a deployment up and return its runtime endpoint: the Build that holds every adapter routed
 * to it, a release of that Build, and a deployment of the release with `min: 0`. Each step is
 * skipped when what is recorded still matches.
 *
 * Serialized per deployment across the workspace — every video's deploy job converges here.
 */
export async function ensureDeploymentReady(ctx: DeployContext, name: string): Promise<string> {
  const timing = { ...DEFAULT_TIMING, ...ctx.timing };
  await fs.mkdir(path.join(ctx.workspaceRoot, ".konte"), { recursive: true });
  return withFileLock(
    deploymentLockPath(ctx.workspaceRoot, name),
    () => bringUp(ctx, name, timing),
    { timeoutMs: timing.lockTimeoutMs },
  );
}

/**
 * Submit one job on a deployment: reconcile it with the current Build and compute (a delivery
 * upscale has no bring-up job before it), then run `submit` against its endpoint — inputs and POST
 * — under the deployment's lock, so no replacement deletes it in between. The job is recorded
 * as sent for a replacement to wait on.
 */
export async function submitOnDeployment<T>(
  ctx: DeployContext,
  name: string,
  jobId: string,
  submit: (endpoint: string) => Promise<T>,
): Promise<T> {
  const timing = { ...DEFAULT_TIMING, ...ctx.timing };
  await fs.mkdir(path.join(ctx.workspaceRoot, ".konte"), { recursive: true });
  return withFileLock(
    deploymentLockPath(ctx.workspaceRoot, name),
    async () => {
      const endpoint = await bringUp(ctx, name, timing);
      // Before the POST: a process that dies once it lands leaves no backend id on the job, and this
      // is then all that keeps a replacement from deleting the deployment its job runs on.
      const live = await unsettledJobs(ctx.workspaceRoot, `comfyapi:${name}`);
      await updateDeploymentState(ctx.workspaceRoot, name, (current) => ({
        sentJobs: {
          ...Object.fromEntries(Object.entries(current.sentJobs).filter(([id]) => live.has(id))),
          [jobId]: new Date().toISOString(),
        },
      }));
      return submit(endpoint);
    },
    { timeoutMs: timing.lockTimeoutMs },
  );
}

async function bringUp(ctx: DeployContext, name: string, timing: DeployTiming): Promise<string> {
  const { workspaceRoot, config, log } = ctx;
  const checkCancel = async (): Promise<void> => {
    if (await ctx.shouldCancel?.()) {
      throw new KonteError(
        "COMFY_API_DEPLOY_CANCELLED",
        `Bring-up of deployment ${name} cancelled`,
      );
    }
  };
  const declared = deploymentConfig(config, name);
  const platform = ctx.platform ?? new ComfyPlatformClient(ctx.apiKey);
  const router = ctx.router ?? new ComfyRouter(workspaceRoot, config);
  const target: ComfyTarget = `comfyapi:${name}`;

  const adapters = await adaptersRoutedTo(
    await workspaceComfyAdapters(workspaceRoot),
    target,
    router,
  );
  if (adapters.length === 0) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `No comfy adapter routes to ${target} in comfy.adapters, so there is nothing to deploy`,
    );
  }
  const inputs = buildInputs(adapters, declared.comfyVersion ?? null);
  let state = await loadDeploymentState(workspaceRoot, name);
  const resolved = await resolveBuildDefinition(
    inputs,
    state,
    ctx.resolvers ?? DEFAULT_VERSION_RESOLVERS,
  );
  const definitionHash = hashOf(resolved.definition);

  // Build: created once, replaced in place when the definition moves.
  await checkCancel();
  if (!state.buildId) {
    log(`Creating Build ${buildName(workspaceRoot, name)} (${adapters.length} adapter(s))`);
    const build = await platform.createBuild(buildName(workspaceRoot, name), resolved.definition);
    state = await updateDeploymentState(workspaceRoot, name, () => ({
      buildId: build.id,
      definitionHash,
      inputsHash: resolved.inputsHash,
      baseComfyVersion: resolved.baseComfyVersion,
      registryVersions: resolved.registryVersions,
    }));
  } else if (state.definitionHash !== definitionHash) {
    log(`Updating Build ${state.buildId} (ComfyUI ${resolved.baseComfyVersion})`);
    const current = await platform.getBuild(state.buildId);
    await platform.updateBuild(state.buildId, resolved.definition, current.updatedAt ?? null);
    state = await updateDeploymentState(workspaceRoot, name, () => ({
      definitionHash,
      inputsHash: resolved.inputsHash,
      baseComfyVersion: resolved.baseComfyVersion,
      registryVersions: resolved.registryVersions,
    }));
  } else if (state.inputsHash !== resolved.inputsHash) {
    // The inputs moved but resolved to the same definition (a `comfyVersion` naming the tag already
    // pinned); the pins are kept under the new inputs, or every later run would resolve them again.
    state = await updateDeploymentState(workspaceRoot, name, () => ({
      inputsHash: resolved.inputsHash,
      baseComfyVersion: resolved.baseComfyVersion,
      registryVersions: resolved.registryVersions,
    }));
  }

  // Release: one per definition; the builder dedups a repeat.
  await checkCancel();
  if (!state.releaseId || state.releaseDefinitionHash !== definitionHash) {
    log(`Cutting a release of Build ${state.buildId}`);
    let releaseId: string;
    try {
      releaseId = await platform.createRelease(state.buildId!);
    } catch (err) {
      throw releaseFailure(err);
    }
    state = await updateDeploymentState(workspaceRoot, name, () => ({
      releaseId,
      releaseDefinitionHash: definitionHash,
    }));
  }
  await waitForRelease(platform, state.releaseId!, timing, log, checkCancel);
  await checkCancel();

  // Deployment: a release is fixed for its life, so a new one means a new deployment.
  // A recorded deployment gone from the platform is forgotten first, so an unconfirmed create is
  // settled under its stored key.
  if (state.deploymentId && (await platform.getDeployment(state.deploymentId)) === null) {
    await updateDeploymentState(workspaceRoot, name, () => ({
      deploymentId: null,
      endpointUrl: null,
      stopped: false,
    }));
  }
  state = await settleUnconfirmedCreate(platform, workspaceRoot, name);
  const compute = computeConfigOf(declared);
  let deployment = state.deploymentId ? await platform.getDeployment(state.deploymentId) : null;
  const outdated =
    deployment &&
    (deployment.releaseId !== state.releaseId ||
      state.gpuClass !== compute.gpuClass ||
      state.region !== compute.region);
  // A deployment that failed to come up is not reused.
  const broken = deployment && ["failed", "unhealthy", "stop_failed"].includes(deployment.status);
  if (deployment && (outdated || broken)) {
    // Deleting it would cancel what is running there, and leave its waiters reading a new endpoint.
    if ((await submittedJobsOn(workspaceRoot, name, target)) > 0) {
      throw new KonteError(
        "COMFY_API_DEPLOY_DEFERRED",
        `Deployment ${name} has to be replaced (${broken ? `it is ${deployment.status}` : "its release or compute changed"}), ` +
          `but jobs are still running on it; the replacement waits for them`,
      );
    }
    log(
      `Replacing deployment ${deployment.id}: ${broken ? `it is ${deployment.status}` : "its release or compute changed"}`,
    );
    await platform.deleteDeployment(deployment.id);
    await updateDeploymentState(workspaceRoot, name, () => ({
      deploymentId: null,
      endpointUrl: null,
      stopped: false,
    }));
    deployment = null;
  }
  if (deployment && state.max !== compute.max) {
    await platform.updateDeployment(deployment.id, compute);
    await updateDeploymentState(workspaceRoot, name, () => ({ max: compute.max }));
  }
  if (!deployment) {
    log(`Creating deployment on ${compute.gpuClass} in ${compute.region} (max ${compute.max})`);
    // Recorded before the request, so a create whose answer is lost is resent as it was.
    const pending = {
      key: crypto.randomUUID(),
      releaseId: state.releaseId!,
      gpuClass: compute.gpuClass,
      region: compute.region,
      max: compute.max,
    };
    await updateDeploymentState(workspaceRoot, name, () => ({ pendingCreate: pending }));
    try {
      deployment = await platform.createDeployment(pending.releaseId, compute, pending.key);
    } catch (err) {
      // A refusal created nothing; only an unknown outcome keeps the request for the resend.
      if (err instanceof ComfyApiHttpError) {
        await updateDeploymentState(workspaceRoot, name, () => ({ pendingCreate: null }));
      }
      throw err;
    }
    state = await updateDeploymentState(workspaceRoot, name, () => ({
      deploymentId: deployment!.id,
      pendingCreate: null,
      endpointUrl: deployment!.endpointUrl ?? null,
      gpuClass: compute.gpuClass,
      region: compute.region,
      max: compute.max,
      stopped: false,
    }));
  } else if (deployment.status === "stopped") {
    log(`Starting deployment ${deployment.id}`);
    await platform.startDeployment(deployment.id);
  }

  const ready = await waitForDeployment(platform, deployment.id, timing, log, checkCancel);
  const endpointUrl = ready.endpointUrl;
  if (!endpointUrl) {
    throw new KonteError(
      "COMFY_API_DEPLOY_FAILED",
      `Deployment ${ready.id} is ready but names no endpoint`,
    );
  }
  await updateDeploymentState(workspaceRoot, name, () => ({
    endpointUrl,
    stopped: false,
    readyAt: new Date().toISOString(),
  }));
  log(`Deployment ${ready.id} is ready at ${endpointUrl}`);
  return endpointUrl;
}

function releaseFailure(err: unknown): unknown {
  if (err instanceof ComfyApiHttpError && err.status === 400) {
    return new KonteError(
      "COMFY_API_RELEASE_FAILED",
      `The release was refused: ${err.message}. A gated or private model cannot be fetched by the ` +
        `builder; route the adapter that declares it to comfyui or comfycloud.`,
    );
  }
  return err;
}

async function waitForRelease(
  platform: ComfyPlatformClient,
  releaseId: string,
  timing: DeployTiming,
  log: (line: string) => void,
  checkCancel: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timing.releaseTimeoutMs;
  let lastStatus = "";
  while (true) {
    const release = await platform.getRelease(releaseId);
    if (release.deployable === true) return;
    const failures = (release.artifacts ?? [])
      .map((a) => a.failureReason)
      .filter((r): r is string => typeof r === "string" && r !== "");
    if (failures.length > 0 || (release.status === "complete" && release.deployable === false)) {
      const logText = await platform.getReleaseLog(releaseId);
      const tail = logText ? `\n${logText.split("\n").slice(-30).join("\n")}` : "";
      throw new KonteError(
        "COMFY_API_RELEASE_FAILED",
        `Release ${releaseId} did not build${failures.length > 0 ? ` (${failures.join(", ")})` : ""}${tail}`,
      );
    }
    if (release.status && release.status !== lastStatus) {
      lastStatus = release.status;
      log(`Release ${releaseId}: ${release.status}`);
    }
    if (Date.now() > deadline) {
      throw new KonteError(
        "COMFY_API_RELEASE_FAILED",
        `Release ${releaseId} was not deployable after ${Math.round(timing.releaseTimeoutMs / 60_000)}m`,
      );
    }
    await sleep(timing.releasePollMs);
    await checkCancel();
  }
}

async function waitForDeployment(
  platform: ComfyPlatformClient,
  deploymentId: string,
  timing: DeployTiming,
  log: (line: string) => void,
  checkCancel: () => Promise<void>,
): Promise<PlatformDeployment> {
  const deadline = Date.now() + timing.deploymentTimeoutMs;
  let last = "";
  while (true) {
    const deployment = await platform.getDeployment(deploymentId);
    if (!deployment) {
      throw new KonteError(
        "COMFY_API_DEPLOY_FAILED",
        `Deployment ${deploymentId} was deleted while it was coming up`,
      );
    }
    if (deployment.status === "ready") return deployment;
    // A close by `stop` still in flight when this bring-up read it lands here; start it again.
    if (deployment.status === "stopped") {
      log(`Starting deployment ${deploymentId}`);
      await platform.startDeployment(deploymentId);
    }
    if (["failed", "unhealthy", "stop_failed"].includes(deployment.status)) {
      throw new KonteError(
        "COMFY_API_DEPLOY_FAILED",
        `Deployment ${deploymentId} went ${deployment.status} instead of ready`,
      );
    }
    const step = deployment.progress?.step;
    const now = step ? `${deployment.status} (${step})` : deployment.status;
    if (now !== last) {
      last = now;
      log(`Deployment ${deploymentId}: ${now}`);
    }
    if (Date.now() > deadline) {
      throw new KonteError(
        "COMFY_API_DEPLOY_FAILED",
        `Deployment ${deploymentId} was not ready after ${Math.round(timing.deploymentTimeoutMs / 60_000)}m`,
      );
    }
    await sleep(timing.deploymentPollMs);
    await checkCancel();
  }
}

/**
 * A create whose answer was lost left only its request: resent unchanged under its Idempotency-Key,
 * it returns the deployment it made — or makes it now.
 */
async function settleUnconfirmedCreate(
  platform: ComfyPlatformClient,
  workspaceRoot: string,
  name: string,
): Promise<DeploymentState> {
  const state = await loadDeploymentState(workspaceRoot, name);
  const pending = state.pendingCreate;
  if (!pending || state.deploymentId) return state;
  let deployment: PlatformDeployment;
  try {
    deployment = await platform.createDeployment(
      pending.releaseId,
      { gpuClass: pending.gpuClass, region: pending.region, min: 0, max: pending.max },
      pending.key,
    );
  } catch (err) {
    if (err instanceof ComfyApiHttpError) {
      await updateDeploymentState(workspaceRoot, name, () => ({ pendingCreate: null }));
    }
    throw err;
  }
  return updateDeploymentState(workspaceRoot, name, () => ({
    deploymentId: deployment.id,
    endpointUrl: deployment.endpointUrl ?? null,
    gpuClass: pending.gpuClass,
    region: pending.region,
    max: pending.max,
    stopped: false,
    pendingCreate: null,
  }));
}

/** Close one deployment the configured way: delete it (default) or stop it. */
export async function closeDeployment(ctx: DeployContext, name: string): Promise<boolean> {
  const declared = ctx.config.comfy?.comfyapi?.deployments?.[name];
  const platform = ctx.platform ?? new ComfyPlatformClient(ctx.apiKey);
  const state = await loadDeploymentState(ctx.workspaceRoot, name);
  if (!state.deploymentId || state.stopped) return false;
  if ((declared?.close ?? "delete") === "stop") {
    await platform.stopDeployment(state.deploymentId);
    await updateDeploymentState(ctx.workspaceRoot, name, () => ({ stopped: true }));
    ctx.log(`Stopped Comfy API deployment ${name} (${state.deploymentId})`);
  } else {
    await platform.deleteDeployment(state.deploymentId);
    await updateDeploymentState(ctx.workspaceRoot, name, () => ({
      deploymentId: null,
      endpointUrl: null,
      stopped: false,
    }));
    ctx.log(`Deleted Comfy API deployment ${name} (${state.deploymentId})`);
  }
  return true;
}

// Every video's generation jobs on this deployment that have not settled, by id.
async function unsettledJobs(
  workspaceRoot: string,
  target: ComfyTarget,
): Promise<Map<string, JobRecord & { kind: "generation" }>> {
  const out = new Map<string, JobRecord & { kind: "generation" }>();
  for (const video of await listVideos(workspaceRoot)) {
    const jobs = await new JobManager(path.join(workspaceRoot, VIDEOS_DIR, video))
      .listJobs()
      .catch(() => [] as JobRecord[]);
    for (const job of jobs) {
      if (job.kind !== "generation" || job.comfyTarget !== target) continue;
      if (!isJobTerminal(job.status)) out.set(job.id, job);
    }
  }
  return out;
}

// Jobs on this deployment: those whose backend id is recorded, and those sent under the lock
// (`sentJobs`) until they settle — a sender that died after its POST landed recorded nothing else.
// A job still waiting to submit is neither; two of them counting each other would wait forever.
async function submittedJobsOn(
  workspaceRoot: string,
  name: string,
  target: ComfyTarget,
): Promise<number> {
  const live = await unsettledJobs(workspaceRoot, target);
  const sent = (await loadDeploymentState(workspaceRoot, name)).sentJobs;
  return [...live.values()].filter((job) => job.backendJobId != null || job.id in sent).length;
}

function isActive(job: JobRecord): boolean {
  return job.status === "pending" || job.status === "queued" || job.status === "running";
}

/**
 * Every video's jobs on one deployment: whether any is still to run, and when the last one ended.
 * A deploy job counts as work too — its deployment is about to be used.
 */
export async function deploymentActivity(
  workspaceRoot: string,
  name: string,
): Promise<{ active: boolean; lastEndedAt: number | null }> {
  const target = `comfyapi:${name}`;
  let active = false;
  let lastEndedAt: number | null = null;
  for (const video of await listVideos(workspaceRoot)) {
    const jobs = await new JobManager(path.join(workspaceRoot, VIDEOS_DIR, video))
      .listJobs()
      .catch(() => [] as JobRecord[]);
    for (const job of jobs) {
      const onIt =
        (job.kind === "generation" && job.comfyTarget === target) ||
        (job.kind === "comfy-api-deploy" && job.deployment === name);
      if (!onIt) continue;
      if (isActive(job)) active = true;
      const ended = job.completedAt ? Date.parse(job.completedAt) : NaN;
      if (!Number.isNaN(ended)) lastEndedAt = Math.max(lastEndedAt ?? 0, ended);
    }
  }
  return { active, lastEndedAt };
}

/**
 * Close every deployment no job has used for its `idleMinutes`. One set to `0` is closed only by
 * `afterWait` (the end of `job wait`) once nothing is left to run on it, as is every one when no
 * daemon is alive to judge the idle time later; `force` closes each one with
 * no job still to run whatever its idle time — a daemon's last act.
 */
export async function closeIdleDeployments(opts: {
  workspaceRoot: string;
  log: (line: string) => void;
  force?: boolean;
  afterWait?: boolean;
  now?: number;
  platform?: ComfyPlatformClient;
}): Promise<string[]> {
  const apiKey = process.env.COMFY_API_KEY ?? "";
  if (apiKey === "") return [];
  const platform = opts.platform ?? new ComfyPlatformClient(apiKey);
  for (const [name, s] of Object.entries(await loadDeploymentStates(opts.workspaceRoot))) {
    if (!s.pendingCreate || s.deploymentId) continue;
    // Under the lock a bring-up records its own create under, reading the state afresh there.
    await withFileLock(
      deploymentLockPath(opts.workspaceRoot, name),
      () => settleUnconfirmedCreate(platform, opts.workspaceRoot, name),
      { timeoutMs: 2_000 },
    ).catch((err: unknown) =>
      opts.log(`Could not look up Comfy API deployment ${name}: ${errorMessage(err)}`),
    );
  }
  // A stop is accepted before it takes; one that went `stop_failed`, or that something started
  // again, is open after all and closed below.
  for (const [name, s] of Object.entries(await loadDeploymentStates(opts.workspaceRoot))) {
    if (!s.deploymentId || !s.stopped) continue;
    await withFileLock(
      deploymentLockPath(opts.workspaceRoot, name),
      () => confirmStopped(platform, opts.workspaceRoot, name),
      { timeoutMs: 2_000 },
    ).catch((err: unknown) =>
      opts.log(`Could not check Comfy API deployment ${name}: ${errorMessage(err)}`),
    );
  }
  const states = await loadDeploymentStates(opts.workspaceRoot);
  const open = Object.entries(states).filter(([, s]) => s.deploymentId && !s.stopped);
  if (open.length === 0) return [];
  const config = await loadKonteConfig(opts.workspaceRoot);
  const now = opts.now ?? Date.now();
  // With no daemon alive, nothing judges the idle time once this wait ends.
  const unattended = opts.afterWait === true && !(await hasLiveDaemon(opts.workspaceRoot));
  const closed: string[] = [];
  for (const [name, state] of open) {
    const idleMinutes =
      config.comfy?.comfyapi?.deployments?.[name]?.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    const due = (lastEndedAt: number | null): boolean => {
      if (opts.force || unattended) return true;
      if (idleMinutes === 0) return opts.afterWait === true;
      return now - Math.max(lastEndedAt ?? 0, readyAt(state)) >= idleMinutes * 60_000;
    };
    try {
      const closedOne = await withFileLock(
        deploymentLockPath(opts.workspaceRoot, name),
        async () => {
          const { active, lastEndedAt } = await deploymentActivity(opts.workspaceRoot, name);
          if (active || !due(lastEndedAt)) return false;
          return closeDeployment(
            {
              workspaceRoot: opts.workspaceRoot,
              config,
              apiKey,
              log: opts.log,
              platform,
            },
            name,
          );
        },
        // A bring-up holding the lock means the deployment is in use; the next pass decides.
        { timeoutMs: 2_000 },
      );
      if (closedOne) closed.push(name);
    } catch (err) {
      opts.log(`Could not close Comfy API deployment ${name}: ${errorMessage(err)}`);
    }
  }
  return closed;
}

async function confirmStopped(
  platform: ComfyPlatformClient,
  workspaceRoot: string,
  name: string,
): Promise<void> {
  const state = await loadDeploymentState(workspaceRoot, name);
  if (!state.deploymentId || !state.stopped) return;
  const live = await platform.getDeployment(state.deploymentId);
  if (live === null) {
    await updateDeploymentState(workspaceRoot, name, () => ({
      deploymentId: null,
      endpointUrl: null,
      stopped: false,
    }));
  } else if (live.status !== "stopped" && live.status !== "stopping") {
    await updateDeploymentState(workspaceRoot, name, () => ({ stopped: false }));
  }
}

function readyAt(state: DeploymentState): number {
  const at = state.readyAt ? Date.parse(state.readyAt) : NaN;
  return Number.isNaN(at) ? 0 : at;
}
