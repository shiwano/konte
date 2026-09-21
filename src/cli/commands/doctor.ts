import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { type ComfyUIConfig, resolveComfyUIConfig } from "../../comfyui/config.js";
import { ComfyUIHttpClient } from "../../comfyui/http-client.js";
import {
  ComfyUIManagerClient,
  MIN_MANAGER_MAJOR_VERSION,
  parseManagerMajorVersion,
} from "../../comfyui/manager-client.js";
import { resolveHeaderTokens } from "../../comfyui/token-resolver.js";
import type { ComfyUISystemStats } from "../../comfyui/types.js";
import {
  getAssetEntry,
  listAssetPaths,
  listReferenceAssetPaths,
  listReviewableAssetPaths,
} from "../../core/address.js";
import {
  backendSetupAdvice,
  configuredVendorBackends,
  unconfiguredBackendAssets,
} from "../../core/backend-policy.js";
import { loadKonteConfig } from "../../core/config.js";
import { isSecretHeader } from "../../core/types/config.js";
import { KonteError, errorMessage } from "../../core/errors.js";
import { ffmpegToolStatus } from "../../core/ffmpeg-binary.js";
import {
  buildDependencyGraph,
  listBoardlessVideoShots,
  type DependencyGraph,
  listUnusedAssetPaths,
} from "../../core/graph.js";
import { JobManager } from "../../core/job-manager.js";
import { loadAnimatic, loadReference, loadVideoDefinition } from "../../core/loader.js";
import { readAssetsGitignore } from "../../core/assets-gitignore.js";
import { buildOrphanContext, listStrayVariantDirs } from "../../core/orphans.js";
import { listPatchVariantIds } from "../../core/patch.js";
import { collectStaleVariants } from "../../core/staleness.js";
import { StateManager } from "../../core/state/index.js";
import { typeCheckWorkspace } from "../../core/tsc.js";
import { isProtectedVariant } from "../../core/variant-lineage.js";
import { checkForUpdate } from "../../core/update-check.js";
import pkg from "../../../package.json" with { type: "json" };
import type {
  AssetDefinition,
  GenerationJob,
  KonteState,
  ReferenceDefinition,
  AnimaticDefinition,
  VideoDefinition,
} from "../../core/types/index.js";
import { VendorBackendKindSchema } from "../../core/types/index.js";
import { resolveFalConfig } from "../../fal/config.js";
import { FalHttpClient } from "../../fal/http-client.js";
import {
  checkDirection,
  classifyDirectionFinding,
  directionWaiverKey,
  reportableDirectionFindings,
} from "../../core/direction.js";
import { isDirectionSpendGateSatisfied } from "../../core/direction-acceptance.js";
import {
  loadDirectionIfPresent,
  loadAnimaticSetupState,
  loadStagingStageState,
} from "../load-definition.js";
import { currentRoots, requireWorkspaceRoot } from "../context.js";
import type { VideoRoots, VideoSelection } from "../../core/roots.js";
import { STAGE_ENTRY_FILE, stageEntryPath } from "../../core/roots.js";
import { declareScope } from "../scope.js";

// doctor is a quick health check; fail fast on an unreachable backend
// instead of waiting out the client's default request timeout.
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

type CheckResult = {
  name: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
  details?: string[];
  // A backend connectivity/health check. Its passing form carries live diagnostics (GPU/VRAM,
  // queue depth) worth surfacing, so it is shown even when PASS if --backends asked to survey.
  backend?: boolean;
};

export function registerDoctorCommand(program: Command): void {
  const doctor = program
    .command("doctor")
    .description("Check project health")
    .option(
      "--backends",
      "Also probe every backend's connectivity, not just the ones the project uses",
    )
    .option("--all", "Show every check, including passing ones")
    .addHelpText(
      "after",
      `
Runs a battery of health checks over the project: state, type check, definitions,
staleness, orphaned jobs/targets, whether every declared asset's backend is configured,
the backends the project actually uses, and whether a newer konte release is out (checked once a
day; KONTE_UPDATE_CHECK=0 turns it off).

By default only actionable checks (warnings and failures) are printed, followed by a
summary; passing checks are hidden to keep the output terse. Pass --all to print
every check.

By default a backend is probed only if an asset uses it. Pass --backends to probe
every backend (ComfyUI, FAL, local ffmpeg) regardless — useful when
choosing a backend before any adapter is wired. A backend surfaced only by
--backends reports as WARN when unavailable (a survey, not a project error), so it
never changes the exit code. --backends also shows passing backend checks (with
their live GPU/queue diagnostics), which are otherwise hidden.

Examples:
  konte doctor              Health-check the project (problems only)
  konte doctor --all        Show every check, including passing ones
  konte doctor --backends   Also survey which backends are reachable/configured
`,
    )
    .action(async (opts: { backends?: boolean; all?: boolean }) => {
      // Backend connectivity/credentials, ffmpeg and the type check over `adapters/` are
      // workspace-level concerns, so doctor runs without a selected video: the full project battery
      // when one is selected, and only the workspace-level checks otherwise (so `konte doctor
      // --backends` works before any video exists). The reduced scope is itself surfaced as a WARN.
      const workspaceRoot = requireWorkspaceRoot();
      const selection = currentRoots()?.video;
      const videoRoot = selection?.kind === "selected" ? selection.root : null;
      const checks: CheckResult[] = [];
      let usedKinds = new Set<AssetDefinition["kind"]>();
      // The definitions the backend check scans; null when they could not be loaded.
      let defs: DefinitionSet | null = null;

      const typeCheck = await checkTypeCheck(workspaceRoot, videoRoot);
      checks.push(typeCheck);

      if (videoRoot) {
        const roots: VideoRoots = { workspace: workspaceRoot, video: videoRoot };

        checks.push(await checkStateJson(videoRoot));

        // Every check below loads video.tsx/animatic.tsx/reference.tsx by importing them. When the
        // project does not type-check, those imports crash at runtime with errors unrelated to the
        // real cause (the type errors above), so skip them and point at the type check instead.
        // State-only checks (stale/orphaned/missing) read konte.state.json and run regardless.
        if (typeCheck.status === "FAIL") {
          checks.push({
            name: "definition checks",
            status: "WARN",
            message: "skipped — resolve the type errors above first",
          });
        } else {
          const animaticResult = await checkAnimaticTs(videoRoot);
          checks.push(animaticResult.check);

          const videoResult = await checkVideoTs(videoRoot);
          checks.push(videoResult.check);

          const referenceResult = await checkReferenceTs(videoRoot);
          checks.push(referenceResult.check);
          const reference = referenceResult.reference;
          usedKinds = collectUsedKinds(videoResult.video, animaticResult.animatic, reference);
          defs = {
            video: videoResult.video,
            animatic: animaticResult.animatic,
            reference,
          };

          checks.push(...(await runBackendChecks(workspaceRoot, videoRoot, usedKinds)));

          if (videoResult.video) {
            checks.push(
              await checkWorkflowFiles(
                roots,
                videoResult.video,
                animaticResult.animatic,
                reference,
              ),
            );
          }

          if (videoResult.video && animaticResult.animatic) {
            checks.push(
              ...checkCrossStageConsistency(
                videoResult.video,
                animaticResult.animatic,
                reference ?? undefined,
              ),
            );
          }

          if (videoResult.video) {
            checks.push(
              checkUnusedAssets(videoResult.video, animaticResult.animatic, reference ?? undefined),
            );
          }

          checks.push(...(await checkDirectionHealth(videoRoot)));
        }

        checks.push(await checkStaleAssetsHealth(videoRoot));
        checks.push(await checkOrphanedJobs(videoRoot));
        checks.push(await checkOrphanedTargets(videoRoot));
        checks.push(await checkStrayVariantDirs(videoRoot));
        checks.push(await checkMissingAssets(videoRoot));
        checks.push(await checkAssetsGitignore(videoRoot));
      } else {
        checks.push(reducedScopeCheck(selection));
      }

      // --backends surveys the connectivity of every backend not already probed above (a project
      // with no adapters yet, or no video selected, uses none), so a backend can be weighed before
      // it is wired. These are advisory: an unused, unreachable backend is a WARN, never a FAIL, so
      // the survey never changes the exit code.
      if (opts.backends) {
        const surveyed = new Set(ALL_BACKEND_KINDS.filter((kind) => !usedKinds.has(kind)));
        checks.push(...(await runBackendChecks(workspaceRoot, videoRoot, surveyed, true)));
      }

      // Backend configuration is workspace-level, so this runs even with no video selected or
      // broken definitions.
      checks.push(await checkConfiguredBackends(workspaceRoot, defs));

      checks.push(await checkKonteRelease());

      const failCount = checks.filter((c) => c.status === "FAIL").length;
      if (failCount > 0) process.exitCode = 1;

      // Surface only actionable checks (WARN/FAIL) by default, so neither a human nor an agent
      // pays attention (or tokens) on a wall of PASS lines. --all shows everything; a passing
      // backend check is kept when --backends explicitly asked to survey connectivity, since its
      // message carries live GPU/queue diagnostics.
      const visible = checks.filter(
        (c) => opts.all || c.status !== "PASS" || (opts.backends && c.backend),
      );

      for (const check of visible) {
        const icon = check.status === "PASS" ? "\u2713" : check.status === "WARN" ? "!" : "\u2717";
        console.log(`${icon} ${check.status} ${check.name}: ${check.message}`);
        for (const detail of check.details ?? []) {
          console.log(`    ${detail}`);
        }
      }

      const warnCount = checks.filter((c) => c.status === "WARN").length;
      const summary =
        failCount > 0
          ? `${failCount} failed, ${warnCount} warning(s)`
          : warnCount > 0
            ? `${warnCount} warning(s)`
            : "All checks passed";
      console.log(`${visible.length > 0 ? "\n" : ""}${summary}.`);
    });

  // Workspace-scoped, not video-scoped: backend connectivity and ffmpeg are workspace concerns, so
  // doctor must run before any video exists (see the action). The type-check is one of doctor's own
  // checks, reported as a FAIL rather than raised as an error that would stop it running the rest.
  declareScope(doctor, { scope: "workspace", skipTypeCheck: true });
}

// With no video selected, doctor drops to the workspace-level checks and says so: a WARN naming the
// reduced scope, so the thinner output never reads as a clean bill of health for a video.
function reducedScopeCheck(selection: VideoSelection | undefined): CheckResult {
  const reason =
    selection?.kind === "not-found"
      ? `the current video "${selection.name}" no longer exists`
      : "no video selected";
  return {
    name: "video scope",
    status: "WARN",
    message: `${reason}. ` + `Run "konte video use <name>" (or cd into a video).`,
  };
}

async function checkStateJson(videoRoot: string): Promise<CheckResult> {
  try {
    await StateManager.load(videoRoot);
    return { name: "konte.state.json", status: "PASS", message: "valid" };
  } catch (err) {
    return {
      name: "konte.state.json",
      status: "FAIL",
      message: errorMessage(err),
    };
  }
}

async function checkTypeCheck(
  workspaceRoot: string,
  videoRoot: string | null,
): Promise<CheckResult> {
  try {
    await fs.access(path.join(workspaceRoot, "tsconfig.json"));
  } catch {
    return {
      name: "type check",
      status: "PASS",
      message: "no tsconfig.json (skipped)",
    };
  }
  try {
    const result = await typeCheckWorkspace(workspaceRoot, videoRoot);
    if (result.success) {
      return { name: "type check", status: "PASS", message: "passed" };
    }
    const details = result.diagnostics.map(
      (d) => `${d.file}(${d.line},${d.column}): ${d.code} ${d.message}`,
    );
    return {
      name: "type check",
      status: "FAIL",
      message: `${result.errorCount} type error(s) found`,
      details: details.length > 0 ? details : undefined,
    };
  } catch (err) {
    return {
      name: "type check",
      status: "FAIL",
      message: errorMessage(err),
    };
  }
}

// Spell out the reviewable subset when `file` assets pad the raw count, so the
// number here lines up with the lower count shown by `konte status` / preview.
function assetCountMessage(
  definition: VideoDefinition | AnimaticDefinition | ReferenceDefinition,
  stage: "video" | "animatic" | "reference",
): string {
  const total = listAssetPaths(definition, stage).length;
  const reviewable = listReviewableAssetPaths(definition, stage).length;
  return reviewable < total ? `${total} assets, ${reviewable} reviewable` : `${total} assets`;
}

async function checkVideoTs(
  videoRoot: string,
): Promise<{ check: CheckResult; video: Awaited<ReturnType<typeof loadVideoDefinition>> | null }> {
  try {
    const videoPath = stageEntryPath(videoRoot, "video");
    const video = await loadVideoDefinition(videoPath);
    return {
      check: {
        name: "video",
        status: "PASS",
        message: `valid (${assetCountMessage(video, "video")})`,
      },
      video,
    };
  } catch (err) {
    return {
      check: {
        name: "video",
        status: "FAIL",
        message: errorMessage(err),
      },
      video: null,
    };
  }
}

// A missing reference.tsx is a FAIL like a broken one: the shared pool is a required entry.
async function checkReferenceTs(videoRoot: string): Promise<{
  check: CheckResult;
  reference: ReferenceDefinition | null;
}> {
  try {
    const reference = await loadReference(videoRoot);
    return {
      check: {
        name: "reference",
        status: "PASS",
        message: `valid (${assetCountMessage(reference, "reference")})`,
      },
      reference,
    };
  } catch (err) {
    return {
      check: {
        name: "reference",
        status: "FAIL",
        message: errorMessage(err),
      },
      reference: null,
    };
  }
}

// A missing animatic.tsx is a FAIL like a broken one: the board is a required entry.
async function checkAnimaticTs(videoRoot: string): Promise<{
  check: CheckResult;
  animatic: AnimaticDefinition | null;
}> {
  try {
    const animatic = await loadAnimatic(videoRoot);
    return {
      check: {
        name: "animatic",
        status: "PASS",
        message: `valid (${assetCountMessage(animatic, "animatic")})`,
      },
      animatic,
    };
  } catch (err) {
    return {
      check: {
        name: "animatic",
        status: "FAIL",
        message: errorMessage(err),
      },
      animatic: null,
    };
  }
}

const ALL_BACKEND_KINDS: AssetDefinition["kind"][] = ["comfy", "local", "fal"];

// Backend connectivity/health checks, scoped to a set of asset kinds. `advisory` downgrades any
// FAIL to WARN — used for backends surfaced only by `konte doctor --backends`, where an unused,
// unreachable backend is a survey finding, not a project error that should fail the command.
async function runBackendChecks(
  workspaceRoot: string,
  videoRoot: string | null,
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
      if (videoRoot) {
        checks.push(await checkComfyUIQueue(config, videoRoot));
        checks.push(await checkStuckComfyJobs(config, videoRoot));
      }
      checks.push(await checkComfyUIManager(config));
    }
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

async function checkComfyUIQueue(config: ComfyUIConfig, videoRoot: string): Promise<CheckResult> {
  try {
    const client = comfyClient(config);
    const queue = await client.getQueue(HEALTH_CHECK_TIMEOUT_MS);
    const running = queue.queue_running.length;
    const pending = queue.queue_pending.length;

    // ComfyUI's queue is shared with anything else pointing at the same server,
    // so it can include jobs konte never submitted. Cross-reference the queue's
    // prompt IDs against konte's tracked comfy jobs (backendJobId === prompt_id)
    // so `konte job list` (konte-only) and this line agree on whose jobs these are.
    const trackedPromptIds = await listTrackedComfyPromptIds(videoRoot);
    const external = [...queue.queue_running, ...queue.queue_pending].filter((item) => {
      const promptId = queueItemPromptId(item);
      return promptId === null || !trackedPromptIds.has(promptId);
    }).length;

    const base = `${running} running, ${pending} pending`;
    const message = external > 0 ? `${base} (${external} not tracked by konte)` : base;
    return { name: "ComfyUI queue", status: "PASS", message };
  } catch {
    return { name: "ComfyUI queue", status: "FAIL", message: "unable to fetch queue" };
  }
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
          message: `not detected at ${baseUrl} (required by comfyui.autoInstallModels)`,
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

async function listTrackedComfyPromptIds(videoRoot: string): Promise<Set<string>> {
  try {
    const jobs = await new JobManager(videoRoot).listJobs();
    return new Set(
      jobs
        .filter(
          (job): job is GenerationJob =>
            job.kind === "generation" && job.backendKind === "comfy" && job.backendJobId !== null,
        )
        .map((job) => job.backendJobId as string),
    );
  } catch {
    return new Set();
  }
}

// konte jobs stuck "running" whose backend prompt is absent from BOTH the live queue and
// history — the exact mismatch a ComfyUI crash/restart leaves behind (`job list` shows them
// running while the backend has no record). A live waiter/watcher reconciles these to failed
// on its own (see ws-client's orphan detection); this surfaces them when nothing is waiting.
async function checkStuckComfyJobs(config: ComfyUIConfig, videoRoot: string): Promise<CheckResult> {
  try {
    const client = comfyClient(config);
    const queue = await client.getQueue(HEALTH_CHECK_TIMEOUT_MS);
    const live = new Set<string>();
    for (const item of [...queue.queue_running, ...queue.queue_pending]) {
      const promptId = queueItemPromptId(item);
      if (promptId) live.add(promptId);
    }

    const jobs = await new JobManager(videoRoot).listJobs();
    const running = jobs.filter(
      (job): job is GenerationJob =>
        job.kind === "generation" &&
        job.backendKind === "comfy" &&
        job.status === "running" &&
        job.backendJobId !== null,
    );

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
    const preview = stuck.slice(0, 3).join(", ");
    const suffix = stuck.length > 3 ? `, ... (+${stuck.length - 3} more)` : "";
    return {
      name: "ComfyUI stuck jobs",
      status: "WARN",
      message:
        `${stuck.length} running job(s) absent from ComfyUI's queue and history ` +
        `(ComfyUI likely crashed/restarted): ${preview}${suffix} — ` +
        "run `konte job wait` (or start the MCP watcher) to reconcile them to failed",
    };
  } catch {
    return { name: "ComfyUI stuck jobs", status: "PASS", message: "unable to check (skipped)" };
  }
}

async function checkFalConnection(): Promise<CheckResult> {
  try {
    const config = await resolveFalConfig();
    const client = new FalHttpClient(config.apiKey);
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
    if (err instanceof KonteError && err.code === "FAL_AUTH_MISSING") {
      return { name: "FAL connection", status: "FAIL", message: err.message };
    }
    return {
      name: "FAL connection",
      status: "FAIL",
      message: errorMessage(err),
    };
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

async function checkWorkflowFiles(
  roots: VideoRoots,
  video: Awaited<ReturnType<typeof loadVideoDefinition>>,
  animatic: AnimaticDefinition | null,
  reference?: ReferenceDefinition | null,
): Promise<CheckResult> {
  const missing: string[] = [];
  const addresses = listAssetPaths(video, "video");
  if (animatic) {
    addresses.push(...listAssetPaths(animatic, "animatic"));
  }
  if (reference) {
    addresses.push(...listReferenceAssetPaths(reference));
  }

  for (const addr of addresses) {
    const def = addr.startsWith("animatic:")
      ? (animatic ?? video)
      : addr.startsWith("reference:")
        ? (reference ?? video)
        : video;
    const entry = getAssetEntry(def, addr);
    if (entry.kind !== "comfy") continue;

    const workflowPath = path.join(roots.workspace, "adapters", "comfy", entry.workflow);
    try {
      await fs.access(workflowPath);
    } catch {
      missing.push(entry.workflow);
    }
  }

  const unique = [...new Set(missing)];
  if (unique.length === 0) {
    return { name: "workflow files", status: "PASS", message: "all found" };
  }
  return {
    name: "workflow files",
    status: "FAIL",
    message: `missing: ${unique.join(", ")}`,
  };
}

async function checkOrphanedJobs(videoRoot: string): Promise<CheckResult> {
  try {
    let state: KonteState;
    try {
      const manager = await StateManager.load(videoRoot);
      state = manager.getState();
    } catch {
      return { name: "orphaned jobs", status: "PASS", message: "no state to check" };
    }

    const jobManager = new JobManager(videoRoot);
    const jobs = await jobManager.listJobs();
    const orphaned: string[] = [];

    for (const job of jobs) {
      // Only generation jobs are tied to an asset/variant — model downloads and export
      // render jobs have no address/variant, so they can never be orphaned.
      if (job.kind !== "generation") continue;
      const target = state.assets[job.address];
      if (!target) {
        orphaned.push(job.variantId);
        continue;
      }
      if (!target.variants?.[job.variantId]) {
        orphaned.push(job.variantId);
      }
    }

    if (orphaned.length === 0) {
      return { name: "orphaned jobs", status: "PASS", message: "none found" };
    }
    return {
      name: "orphaned jobs",
      status: "WARN",
      message: `${orphaned.length} orphaned job(s): ${orphaned.join(", ")} — run \`konte prune\` to remove them`,
    };
  } catch {
    return { name: "orphaned jobs", status: "PASS", message: "no jobs to check" };
  }
}

// Assets defined but consumed by no composition or panel: not part of any deliverable,
// so they need no review/accept and aren't generated. WARN (not FAIL) — it's a tidiness
// hint, not a broken project; removing them means editing video.tsx / animatic.tsx, so
// (unlike orphaned targets) prune is not suggested.
function checkUnusedAssets(
  video: VideoDefinition,
  animatic: AnimaticDefinition | null,
  reference?: ReferenceDefinition,
): CheckResult {
  let unused: string[];
  try {
    unused = listUnusedAssetPaths(
      video,
      animatic,
      buildDependencyGraph(video, animatic ?? undefined, reference),
      reference,
    );
  } catch {
    // Invalid refs surface via the "missing assets" check; don't double-report here.
    return { name: "unused assets", status: "PASS", message: "skipped (dependency graph invalid)" };
  }
  if (unused.length === 0) {
    return { name: "unused assets", status: "PASS", message: "none found" };
  }
  const preview = unused.slice(0, 3).join(", ");
  const suffix = unused.length > 3 ? `, ... (+${unused.length - 3} more)` : "";
  return {
    name: "unused assets",
    status: "WARN",
    message: `${unused.length} asset(s) used by no composition, panel, or reference export: ${preview}${suffix} — remove from ${STAGE_ENTRY_FILE.video} / ${STAGE_ENTRY_FILE.animatic} / ${STAGE_ENTRY_FILE.reference} if unneeded`,
  };
}

async function checkOrphanedTargets(videoRoot: string): Promise<CheckResult> {
  const skip = (message: string): CheckResult => ({
    name: "orphaned targets",
    status: "PASS",
    message,
  });

  let state: KonteState;
  try {
    const manager = await StateManager.load(videoRoot);
    state = manager.getState();
  } catch {
    return skip("no state to check");
  }

  let video: VideoDefinition;
  try {
    video = await loadVideoDefinition(stageEntryPath(videoRoot, "video"));
  } catch {
    return skip("cannot load definition (skipped)");
  }
  const animatic = await loadAnimatic(videoRoot).catch(() => null);
  const reference = await loadReference(videoRoot).catch(() => null);

  // Reuse prune's orphan definition so doctor never warns about (and suggests pruning) a live
  // composition baseline or #delivery target that prune itself would correctly keep.
  const { isOrphan } = buildOrphanContext(
    video,
    animatic,
    reference,
    new Set(await listPatchVariantIds(videoRoot)),
    state,
  );
  const orphans = Object.keys(state.assets).filter(isOrphan);
  if (orphans.length === 0) {
    return { name: "orphaned targets", status: "PASS", message: "none found" };
  }

  const preview = orphans.slice(0, 3).join(", ");
  const suffix = orphans.length > 3 ? `, ... (+${orphans.length - 3} more)` : "";
  return {
    name: "orphaned targets",
    status: "WARN",
    message:
      `${orphans.length} orphaned target(s): ${preview}${suffix}` +
      " — run `konte prune` to remove them, or `konte prune <address-scope>` for some",
  };
}

async function checkStrayVariantDirs(videoRoot: string): Promise<CheckResult> {
  let state: KonteState;
  try {
    state = (await StateManager.load(videoRoot)).getRecordedState();
  } catch {
    return { name: "stray variant directories", status: "PASS", message: "no state to check" };
  }
  const stray = await listStrayVariantDirs(videoRoot, state);
  if (stray.length === 0) {
    return { name: "stray variant directories", status: "PASS", message: "none found" };
  }
  const preview = stray.slice(0, 3).join(", ");
  const suffix = stray.length > 3 ? `, ... (+${stray.length - 3} more)` : "";
  return {
    name: "stray variant directories",
    status: "WARN",
    message: `${stray.length} not in state: ${preview}${suffix} — run \`konte prune\` to remove them`,
  };
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

async function readMediaHead(file: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(LFS_POINTER_PREFIX.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

// A protected variant's media is what git holds, so its absence is a FAIL. An absent variant never
// reaches this check (see `StateManager.absentVariantIds`).
async function checkMissingAssets(videoRoot: string): Promise<CheckResult> {
  let state: KonteState;
  try {
    state = (await StateManager.load(videoRoot)).getState();
  } catch {
    return { name: "missing assets", status: "PASS", message: "no state to check" };
  }

  const protectedMissing: string[] = [];
  const otherMissing: string[] = [];
  let protectedPointers = 0;
  for (const [address, target] of Object.entries(state.assets)) {
    for (const [variantId, variant] of Object.entries(target.variants ?? {})) {
      if (!variant.file) continue;
      const head = await readMediaHead(path.resolve(videoRoot, variant.file));
      if (head !== null && head !== LFS_POINTER_PREFIX) continue;
      const isPointer = head !== null;
      const line = `${address} ${variantId}: ${variant.file}${isPointer ? " (Git LFS pointer)" : ""}`;
      if (isProtectedVariant(state, address, variantId)) {
        protectedMissing.push(line);
        if (isPointer) protectedPointers += 1;
      } else {
        otherMissing.push(line);
      }
    }
  }

  if (protectedMissing.length > 0) {
    const fetchLfs = "Git LFS objects not fetched (run `git lfs pull`)";
    const cause =
      protectedPointers === 0
        ? "not committed"
        : protectedPointers === protectedMissing.length
          ? fetchLfs
          : `not committed, or ${fetchLfs}`;
    return {
      name: "missing assets",
      status: "FAIL",
      message: `${protectedMissing.length} accepted take(s) or patch source(s) missing their media — ${cause}`,
      details: protectedMissing,
    };
  }
  if (otherMissing.length > 0) {
    return {
      name: "missing assets",
      status: "WARN",
      message: `${otherMissing.length} missing asset(s)`,
    };
  }
  return { name: "missing assets", status: "PASS", message: "all present" };
}

// Repaired by the next state write; a drift here is a hand edit or a save that died after writing
// the state.
async function checkAssetsGitignore(videoRoot: string): Promise<CheckResult> {
  let manager: StateManager;
  try {
    manager = await StateManager.load(videoRoot);
  } catch {
    return { name: "assets/.gitignore", status: "PASS", message: "no state to check" };
  }
  const actual = await readAssetsGitignore(videoRoot);
  if (actual === manager.renderAssetsGitignore()) {
    return { name: "assets/.gitignore", status: "PASS", message: "matches the state" };
  }
  return {
    name: "assets/.gitignore",
    status: "WARN",
    message:
      actual === null
        ? "missing — the next state write restores it, until then git tracks every take"
        : "does not match the state — the next state write regenerates it",
  };
}

function checkCrossStageConsistency(
  video: VideoDefinition,
  animatic: AnimaticDefinition,
  reference?: ReferenceDefinition,
): CheckResult[] {
  const results: CheckResult[] = [];

  let graph: DependencyGraph;
  try {
    graph = buildDependencyGraph(video, animatic, reference);
    results.push({
      name: "cross-stage dependencies",
      status: "PASS",
      message: "all video dependencies on animatic resolved",
    });
  } catch (err) {
    results.push({
      name: "cross-stage dependencies",
      status: "FAIL",
      message: errorMessage(err),
    });
    return results;
  }

  // A shot that spends is blocking work — `generate video`, `reroll`, `export` and `patch apply` all
  // refuse it (ANIMATIC_UNCONSUMED). One built from footage or konte's own ffmpeg ops has no input a
  // board could be wired into, so no gate refuses it; it is still a board reviewed and then left out
  // of the piece. A `pendingShot` is listed by neither.
  const boardless = listBoardlessVideoShots(video, animatic, graph);
  const spending = boardless.filter((s) => s.spends).map((s) => s.shotId);
  const assembled = boardless.filter((s) => !s.spends).map((s) => s.shotId);
  if (spending.length > 0) {
    results.push({
      name: "animatic wiring",
      status: "FAIL",
      message: `video shot(s) spend without building on the board they develop: ${spending.join(", ")}`,
    });
  }
  if (assembled.length > 0) {
    results.push({
      name: "animatic wiring",
      status: "WARN",
      message: `video shot(s) draw nothing from the board they develop: ${assembled.join(", ")}`,
    });
  }

  return results;
}

function collectUsedKinds(
  video: VideoDefinition | null,
  animatic: AnimaticDefinition | null,
  reference?: ReferenceDefinition | null,
): Set<AssetDefinition["kind"]> {
  const kinds = new Set<AssetDefinition["kind"]>();
  if (video) {
    for (const addr of listAssetPaths(video, "video")) {
      kinds.add(getAssetEntry(video, addr).kind);
    }
  }
  if (animatic) {
    for (const addr of listAssetPaths(animatic, "animatic")) {
      kinds.add(getAssetEntry(animatic, addr).kind);
    }
  }
  if (reference) {
    for (const addr of listReferenceAssetPaths(reference)) {
      kinds.add(getAssetEntry(reference, addr).kind);
    }
  }
  return kinds;
}

// Reports the direction's structural validity and direction-level arc/pacing findings (report-only —
// the generate/reroll/export gate is what enforces them). Stage/completeness findings are
// command-scoped and left to the gate, so doctor runs the direction-only pass (no realizedIds).
async function checkDirectionHealth(videoRoot: string): Promise<CheckResult[]> {
  let direction: Awaited<ReturnType<typeof loadDirectionIfPresent>>;
  try {
    direction = await loadDirectionIfPresent(videoRoot);
  } catch (err) {
    return [
      {
        name: "direction",
        status: "FAIL",
        message: errorMessage(err),
      },
    ];
  }
  if (!direction) {
    return [
      {
        name: "direction",
        status: "FAIL",
        message: "no direction.ts — declare the video's direction (lens + shots)",
      },
    ];
  }

  // Supply the reference pool so the characters checks (character-unreferenced / unused-character) run;
  // an unreadable reference.tsx is an empty pool, so a declared character reports as unreferenced.
  const reference = await loadReference(videoRoot).catch(() => null);
  const {
    structureErrors,
    active: allActive,
    staleWaivers,
  } = checkDirection(direction, {
    referenceAssetNames: reference?.exposedAssetNames ?? [],
    animaticSetups: await loadAnimaticSetupState(videoRoot, direction),
    stagingStage: await loadStagingStageState(videoRoot, direction),
  });
  const manager = await StateManager.load(videoRoot).catch(() => null);
  const acceptance = manager?.getDirectionAcceptance();
  const active = reportableDirectionFindings(
    allActive,
    isDirectionSpendGateSatisfied(direction, acceptance ?? null),
  );
  const results: CheckResult[] = [];

  // An empty direction means "not started yet", not "wrong" — a fresh `konte workspace new` ships `shots: []`,
  // so reporting it as a hard FAIL would make every brand-new project fail doctor. Surface it alone
  // as a WARN (the `generate` gate still hard-blocks it). Any other structural error is a real
  // definition bug and stays a FAIL.
  const realErrors = structureErrors.filter((e) => e.code !== "empty-direction");
  const emptyDirection = structureErrors.some((e) => e.code === "empty-direction");

  if (realErrors.length > 0) {
    results.push({
      name: "direction",
      status: "FAIL",
      message: `${structureErrors.length} structural error(s)`,
      details: structureErrors.map((e) => `[${e.code}] ${e.message}`),
    });
  } else if (emptyDirection) {
    results.push({
      name: "direction",
      status: "WARN",
      message: "direction is empty — declare at least one shot to begin",
    });
  } else if (active.length > 0) {
    results.push({
      name: "direction",
      status: "FAIL",
      message: `${active.length} unresolved finding(s) — fix direction.ts or add a waiver`,
      details: active.map(
        (f) => `[${directionWaiverKey(f)}] (${classifyDirectionFinding(f.code)}) ${f.message}`,
      ),
    });
  } else {
    results.push({ name: "direction", status: "PASS", message: "direction is sound" });
  }

  if (staleWaivers.length > 0) {
    results.push({
      name: "direction waivers",
      status: "WARN",
      message: `${staleWaivers.length} stale waiver(s) — the finding is gone; remove the waiver`,
      details: staleWaivers.map((w) => `${w.key}: ${w.reason}`),
    });
  }

  return results;
}

type DefinitionSet = {
  video: VideoDefinition | null;
  animatic: AnimaticDefinition | null;
  reference: ReferenceDefinition | null;
};

// The one network call doctor makes on konte's own behalf, cached a day beside the binary
// (update-check.ts). Advisory — never a FAIL.
async function checkKonteRelease(): Promise<CheckResult> {
  const name = "konte release";
  const result = await checkForUpdate(pkg.version);
  switch (result.kind) {
    case "outdated":
      return {
        name,
        status: "WARN",
        message: `v${result.latest} is out (installed v${result.current}) — run /konte:upgrade, or rerun the installer`,
      };
    case "current":
      return { name, status: "PASS", message: `v${result.current} is the latest release` };
    case "unknown":
      return {
        name,
        status: "PASS",
        message: `v${result.current}; could not check for a newer release (${result.reason})`,
      };
    case "disabled":
      return {
        name,
        status: "PASS",
        message: `v${result.current}; release check disabled (KONTE_UPDATE_CHECK=0)`,
      };
  }
}

// Every declared asset against the backends this workspace has configured. The
// `generate` gate runs the same check, but only once the direction is accepted and a run is asked
// for; it reads the definitions alone, so doctor can answer it before either — and, since backend
// configuration is workspace-level, before any video exists. `defs` is null when the definitions
// were not loaded (type errors, or no video selected), leaving the config itself to speak to.
async function checkConfiguredBackends(
  workspaceRoot: string,
  defs: DefinitionSet | null,
): Promise<CheckResult> {
  const name = "configured backends";
  const config = await loadKonteConfig(workspaceRoot);
  const configured = configuredVendorBackends(config);

  const unconfigured = defs
    ? [
        ...(defs.animatic ? unconfiguredBackendAssets(defs.animatic, "animatic", config) : []),
        ...(defs.video ? unconfiguredBackendAssets(defs.video, "video", config) : []),
        ...(defs.reference ? unconfiguredBackendAssets(defs.reference, "reference", config) : []),
      ]
    : [];

  if (unconfigured.length > 0) {
    return {
      name,
      status: "FAIL",
      message:
        `${unconfigured.length} asset(s) on a backend this workspace has not configured — ` +
        `generate will refuse them; ${backendSetupAdvice(unconfigured.map((v) => v.kind))}`,
      details: unconfigured.map((v) => `${v.address} (${v.kind})`),
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
      `[${configured.join(", ")}] configured` + (defs === null ? " (assets not checked)" : ""),
  };
}

async function checkStaleAssetsHealth(videoRoot: string): Promise<CheckResult> {
  try {
    const manager = await StateManager.load(videoRoot);
    const state = manager.getState();
    const staleAddresses: string[] = [];

    // Only an accepted (resolved) variant being stale is worth flagging — mirror the
    // accepted-only definition `status`' Stale section uses (collectStaleVariants). A stale
    // non-accepted history variant is harmless (never resolved/used), so warning on it made
    // doctor contradict `status` and read as "you broke something" when nothing was wrong.
    for (const address of Object.keys(state.assets)) {
      if (collectStaleVariants(state, address, null).length > 0) {
        staleAddresses.push(address);
      }
    }

    if (staleAddresses.length === 0) {
      return { name: "stale assets", status: "PASS", message: "no stale assets" };
    }
    const preview = staleAddresses.slice(0, 3).join(", ");
    const suffix = staleAddresses.length > 3 ? `, ... (+${staleAddresses.length - 3} more)` : "";
    return {
      name: "stale assets",
      status: "WARN",
      message: `${staleAddresses.length} stale asset(s): ${preview}${suffix}`,
    };
  } catch {
    return { name: "stale assets", status: "PASS", message: "no state to check" };
  }
}
