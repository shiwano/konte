import {
  backendSetupAdvice,
  configuredVendorBackends,
  unconfiguredBackendAssets,
} from "../../../backends/backend-policy.js";
import { deploymentReadiness, routedDeploymentNames } from "../../../comfy-api/deployment.js";
import { assertComfyAdapterKeys, comfyApiKey, ComfyRouter } from "../../../comfy-api/routing.js";
import { type ComfyUIConfig, resolveComfyUIConfig } from "../../../comfyui/config.js";
import { ComfyUIHttpClient } from "../../../comfyui/http-client.js";
import {
  ComfyUIManagerClient,
  MIN_MANAGER_MAJOR_VERSION,
  parseManagerMajorVersion,
} from "../../../comfyui/manager-client.js";
import { resolveHeaderTokens } from "../../../comfyui/token-resolver.js";
import type { ComfyUISystemStats } from "../../../comfyui/types.js";
import { loadKonteConfig } from "../../../core/config.js";
import { errorMessage, KonteError } from "../../../core/errors.js";
import { JobManager } from "../../../core/job-manager.js";
import { ffmpegToolStatus } from "../../../core/ffmpeg-binary.js";
import { isSecretHeader } from "../../../core/types/config.js";
import type { AssetDefinition, GenerationJob } from "../../../core/types/index.js";
import { VendorBackendKindSchema } from "../../../core/types/index.js";
import { falKey } from "../../../fal/config.js";
import { FalHttpClient } from "../../../fal/http-client.js";
import { capInline } from "../../format-list.js";
import type { CheckResult, DoctorVideo, VideoDefinitionSet } from "./types.js";

// doctor is a quick health check; fail fast on an unreachable backend
// instead of waiting out the client's default request timeout.
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export const ALL_BACKEND_KINDS: AssetDefinition["kind"][] = ["comfy", "local", "fal"];

// Backend connectivity/health checks, scoped to a set of asset kinds. `advisory` downgrades any
// FAIL to WARN — used for backends surfaced only by `konte doctor --backends`, where an unused,
// unreachable backend is a survey finding, not a project error that should fail the command.
export async function runBackendChecks(
  workspaceRoot: string,
  videos: readonly DoctorVideo[],
  kinds: Set<AssetDefinition["kind"]>,
  advisory = false,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  if (kinds.has("comfy")) {
    // The ComfyUI settings live in the workspace's konte.config.json, shared by every video.
    const config = await resolveComfyUIConfig(workspaceRoot);
    // Before the connection: an unresolved `${VAR}` makes every request below fail as a rejection
    // or a timeout, which reads as the server's fault.
    const credentials = checkComfyUICredentials(config);
    if (credentials) checks.push(credentials);
    const connection = await checkComfyUIConnection(config);
    checks.push(connection);
    if (connection.status === "PASS") {
      // The queue and stuck-job checks cross-reference konte's tracked jobs, which live per-video;
      // with no video selected there are none, so run only the video-agnostic manager check.
      for (const video of videos) {
        const tag = (check: CheckResult): CheckResult =>
          video.name === null ? check : { ...check, video: video.name };
        const snapshot = await readComfyQueue(config, video.root);
        checks.push(tag(checkComfyUIQueue(snapshot)));
        checks.push(tag(await checkStuckComfyJobs(config, snapshot)));
      }
      checks.push(await checkComfyUIManager(config));
    }
    // A survey does not ask after a deployment's Build.
    if (!advisory) checks.push(...(await checkComfyApiDeployments(workspaceRoot)));
  }

  if (kinds.has("local")) {
    const { ffmpeg, ffprobe } = await ffmpegToolStatus();
    checks.push(ffmpegToolCheck("ffmpeg", ffmpeg));
    checks.push(ffmpegToolCheck("ffprobe", ffprobe));
  }

  if (kinds.has("fal")) {
    checks.push(await checkFalConnection());
  }

  const tagged = checks.map((check): CheckResult => ({ ...check, backend: true }));
  return advisory
    ? tagged.map((check) => (check.status === "FAIL" ? { ...check, status: "WARN" } : check))
    : tagged;
}

function comfyClient(config: ComfyUIConfig): ComfyUIHttpClient {
  return new ComfyUIHttpClient(config.baseUrl, { headers: config.headers });
}

/**
 * The configured headers, checked without touching the network: that every `${VAR}` resolves, and
 * that a credential is not being sent in the clear. null when no header is configured at all.
 */
function checkComfyUICredentials(config: ComfyUIConfig): CheckResult | null {
  const names = Object.keys(config.headers);
  if (names.length === 0) return null;

  try {
    resolveHeaderTokens(config.headers);
  } catch (err) {
    return { name: "ComfyUI credentials", status: "FAIL", message: errorMessage(err) };
  }

  const secret = names.filter(isSecretHeader);
  if (secret.length > 0 && config.baseUrl.startsWith("http://")) {
    return {
      name: "ComfyUI credentials",
      status: "WARN",
      message: `${secret.join(", ")} is sent over plain http to ${config.baseUrl}`,
    };
  }
  return { name: "ComfyUI credentials", status: "PASS", message: `sending ${names.join(", ")}` };
}

async function checkComfyUIConnection(config: ComfyUIConfig): Promise<CheckResult> {
  const { baseUrl } = config;
  const client = comfyClient(config);
  let stats: ComfyUISystemStats;
  try {
    stats = await client.systemStats(HEALTH_CHECK_TIMEOUT_MS);
  } catch (err) {
    // A rejection is not an outage — the server answered — so the two must not share a message.
    if (err instanceof KonteError && err.code === "COMFYUI_UNAUTHORIZED") {
      return { name: "ComfyUI connection", status: "FAIL", message: errorMessage(err) };
    }
    return { name: "ComfyUI connection", status: "FAIL", message: `cannot reach ${baseUrl}` };
  }
  const gpu = formatGpuSummary(stats.devices);
  const message = gpu ? `connected to ${baseUrl} — ${gpu}` : `connected to ${baseUrl}`;
  return { name: "ComfyUI connection", status: "PASS", message };
}

function formatGpuSummary(devices: ComfyUISystemStats["devices"] | undefined): string | null {
  if (!devices || devices.length === 0) return null;
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return devices
    .map((device) => {
      const label = device.name.split(" : ")[0];
      if (typeof device.vram_total === "number" && device.vram_total > 0) {
        return `${label} (VRAM ${gb(device.vram_free ?? 0)}/${gb(device.vram_total)} GB free)`;
      }
      return label;
    })
    .join("; ");
}

// ComfyUI's live queue, and the video's comfy jobs read after it so a job submitted meanwhile is
// already tracked. null when the queue cannot be fetched; `jobs` is null when jobs.db cannot be read.
type ComfyQueueSnapshot = {
  items: unknown[];
  running: number;
  pending: number;
  jobs: GenerationJob[] | null;
} | null;

async function readComfyQueue(
  config: ComfyUIConfig,
  videoRoot: string,
): Promise<ComfyQueueSnapshot> {
  let queue: Awaited<ReturnType<ComfyUIHttpClient["getQueue"]>>;
  try {
    queue = await comfyClient(config).getQueue(HEALTH_CHECK_TIMEOUT_MS);
  } catch {
    return null;
  }
  const jobs = await new JobManager(videoRoot).listJobs().then(
    (all) =>
      all.filter(
        (job): job is GenerationJob =>
          job.kind === "generation" && job.backendKind === "comfy" && job.backendJobId !== null,
      ),
    () => null,
  );
  return {
    items: [...queue.queue_running, ...queue.queue_pending],
    running: queue.queue_running.length,
    pending: queue.queue_pending.length,
    jobs,
  };
}

function checkComfyUIQueue(snapshot: ComfyQueueSnapshot): CheckResult {
  if (snapshot === null) {
    return { name: "ComfyUI queue", status: "FAIL", message: "unable to fetch queue" };
  }
  // ComfyUI's queue is shared with anything else pointing at the same server,
  // so it can include jobs konte never submitted. Cross-reference the queue's
  // prompt IDs against konte's tracked comfy jobs (backendJobId === prompt_id)
  // so `konte job list` (konte-only) and this line agree on whose jobs these are.
  const trackedPromptIds = new Set((snapshot.jobs ?? []).map((job) => job.backendJobId as string));
  const external = snapshot.items.filter((item) => {
    const promptId = queueItemPromptId(item);
    return promptId === null || !trackedPromptIds.has(promptId);
  }).length;

  const base = `${snapshot.running} running, ${snapshot.pending} pending`;
  const message = external > 0 ? `${base} (${external} not tracked by konte)` : base;
  return { name: "ComfyUI queue", status: "PASS", message };
}

async function checkComfyUIManager(config: ComfyUIConfig): Promise<CheckResult> {
  const { baseUrl, autoInstallModels } = config;
  const client = new ComfyUIManagerClient(baseUrl, comfyClient(config));
  const version = await client.getVersion();
  if (version === null) {
    // autoInstallModels relies on ComfyUI-Manager to fetch missing models, so a
    // missing Manager is fatal when it's enabled and merely advisory otherwise.
    return autoInstallModels
      ? {
          name: "ComfyUI-Manager",
          status: "FAIL",
          message: `not detected at ${baseUrl} (required by comfy.comfyui.autoInstallModels)`,
        }
      : { name: "ComfyUI-Manager", status: "WARN", message: `not detected at ${baseUrl}` };
  }
  // konte drives the Manager's V4 API exclusively; an older Manager answers a different route
  // surface, so flag it rather than letting later calls fail obscurely. An unparseable version
  // is left to PASS — better to proceed than to block on a format we don't recognize.
  const major = parseManagerMajorVersion(version);
  if (major !== null && major < MIN_MANAGER_MAJOR_VERSION) {
    return {
      name: "ComfyUI-Manager",
      status: "FAIL",
      message: `${version} is too old — konte requires ComfyUI-Manager V${MIN_MANAGER_MAJOR_VERSION}+`,
    };
  }
  return { name: "ComfyUI-Manager", status: "PASS", message: `installed (${version})` };
}

function queueItemPromptId(item: unknown): string | null {
  return Array.isArray(item) && typeof item[1] === "string" ? item[1] : null;
}

// konte jobs stuck "running" whose backend prompt is absent from BOTH the live queue and
// history — the exact mismatch a ComfyUI crash/restart leaves behind (`job list` shows them
// running while the backend has no record). A live waiter/watcher reconciles these to failed
// on its own (see ws-client's orphan detection); this surfaces them when nothing is waiting.
async function checkStuckComfyJobs(
  config: ComfyUIConfig,
  snapshot: ComfyQueueSnapshot,
): Promise<CheckResult> {
  const skipped: CheckResult = {
    name: "ComfyUI stuck jobs",
    status: "PASS",
    message: "unable to check (skipped)",
  };
  if (!snapshot?.jobs) return skipped;
  try {
    const client = comfyClient(config);
    const live = new Set<string>();
    for (const item of snapshot.items) {
      const promptId = queueItemPromptId(item);
      if (promptId) live.add(promptId);
    }
    const running = snapshot.jobs.filter((job) => job.status === "running");

    const stuck: string[] = [];
    for (const job of running) {
      const promptId = job.backendJobId as string;
      if (live.has(promptId)) continue;
      // Absent from the queue could just be the brief queue→history handoff; only history
      // confirms it's truly gone (a crash/restart loses both).
      const history = await client.getHistory(promptId);
      if (!history) stuck.push(job.variantId);
    }

    if (stuck.length === 0) {
      return { name: "ComfyUI stuck jobs", status: "PASS", message: "none found" };
    }
    // Named by preview, not in full: the remedy waits on the whole queue, so a message carrying
    // every id would be a list nobody has to copy.
    const preview = capInline(stuck, { cap: 3 });
    return {
      name: "ComfyUI stuck jobs",
      status: "WARN",
      message:
        `${stuck.length} running job(s) absent from ComfyUI's queue and history ` +
        `(ComfyUI likely crashed/restarted): ${preview} — ` +
        "run `konte job run` to reconcile them to failed",
    };
  } catch {
    return skipped;
  }
}

// Each Comfy API deployment an adapter routes to: a Build of its current adapters, deployed.
async function checkComfyApiDeployments(workspaceRoot: string): Promise<CheckResult[]> {
  const apiKey = comfyApiKey();
  if (apiKey === null) return [];
  try {
    const config = await loadKonteConfig(workspaceRoot);
    const router = new ComfyRouter(workspaceRoot, config);
    const checks: CheckResult[] = [];
    for (const name of await routedDeploymentNames(workspaceRoot, config, router)) {
      const check = `Comfy API deployment ${name}`;
      const readiness = await deploymentReadiness({ workspaceRoot, config, apiKey, router }, name);
      checks.push(
        readiness.kind === "ready"
          ? { name: check, status: "PASS", message: `${readiness.deployment.id} ready` }
          : {
              name: check,
              status: "FAIL",
              message:
                (readiness.kind === "unbuilt"
                  ? "its Build is missing or older than its adapters"
                  : readiness.kind === "deploying"
                    ? `${readiness.deployment.id} is ${readiness.deployment.status}`
                    : `no ready deployment of release ${readiness.releaseId}`) +
                ` — run \`konte adapter comfy build ${name}\``,
            },
      );
    }
    return checks;
  } catch (err) {
    return [{ name: "Comfy API deployments", status: "FAIL", message: errorMessage(err) }];
  }
}

async function checkFalConnection(): Promise<CheckResult> {
  try {
    const key = falKey();
    const client = new FalHttpClient(() => key);
    const ok = await client.ping();
    if (ok) {
      return { name: "FAL connection", status: "PASS", message: "API key configured" };
    }
    return {
      name: "FAL connection",
      status: "FAIL",
      message: "cannot reach FAL API (key may be invalid)",
    };
  } catch (err) {
    return { name: "FAL connection", status: "FAIL", message: errorMessage(err) };
  }
}

function ffmpegToolCheck(
  name: "ffmpeg" | "ffprobe",
  status: Awaited<ReturnType<typeof ffmpegToolStatus>>["ffmpeg"],
): CheckResult {
  switch (status.source) {
    case "override":
      return { name, status: "PASS", message: `using ${status.path} (override)` };
    case "cached":
      return { name, status: "PASS", message: `konte-managed build ready (${status.version})` };
    case "unsupported":
      return {
        name,
        status: "WARN",
        message: `no managed build for this platform; set KONTE_${name.toUpperCase()}_PATH`,
      };
    case "unpinned":
      return {
        name,
        status: "FAIL",
        message: `no pinned checksum for the ${status.version} download; regenerate the manifest`,
      };
    default:
      return {
        name,
        status: "WARN",
        message: "not installed; konte downloads a managed build on first use",
      };
  }
}

// Every declared asset against the backends this workspace has configured. The
// `generate` gate runs the same check, but only once the direction is accepted and a run is asked
// for; it reads the definitions alone, so doctor can answer it before either — and, since backend
// configuration is workspace-level, before any video exists. `defs` is empty when no definitions
// were loaded (type errors, or no video selected), leaving the config itself to speak to.
export async function checkConfiguredBackends(
  workspaceRoot: string,
  defs: readonly VideoDefinitionSet[],
): Promise<CheckResult> {
  const name = "configured backends";
  const config = await loadKonteConfig(workspaceRoot);
  const configured = configuredVendorBackends(config);
  try {
    assertComfyAdapterKeys(workspaceRoot, config);
  } catch (err) {
    return { name, status: "FAIL", message: errorMessage(err) };
  }

  const unconfigured = defs.flatMap((set) =>
    [
      ...(set.animatic ? unconfiguredBackendAssets(set.animatic, "animatic", config) : []),
      ...(set.video ? unconfiguredBackendAssets(set.video, "video", config) : []),
      ...(set.reference ? unconfiguredBackendAssets(set.reference, "reference", config) : []),
    ].map((asset) => ({ ...asset, video: set.name })),
  );

  if (unconfigured.length > 0) {
    return {
      name,
      status: "FAIL",
      message:
        `${unconfigured.length} asset(s) on a backend this workspace has not configured — ` +
        `generate will refuse them; ${backendSetupAdvice(unconfigured.map((v) => v.kind))}`,
      details: unconfigured.map(
        (v) => `${v.video === null ? "" : `${v.video}: `}${v.address} (${v.kind})`,
      ),
    };
  }
  if (configured.length === 0) {
    return {
      name,
      status: "WARN",
      message:
        "no vendor backend is configured, so generate refuses every vendor asset — " +
        backendSetupAdvice(VendorBackendKindSchema.options),
    };
  }
  return {
    name,
    status: "PASS",
    message:
      `[${configured.join(", ")}] configured` + (defs.length === 0 ? " (assets not checked)" : ""),
  };
}
