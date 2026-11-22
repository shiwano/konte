import * as path from "node:path";
import type { Command } from "commander";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { listVideos, VIDEOS_DIR, type VideoRoots } from "../../../core/roots.js";
import { loadStageDefinitions } from "../../../core/stage-definitions.js";
import type { AssetDefinition } from "../../../core/types/index.js";
import { currentRoots, requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";
import { ALL_BACKEND_KINDS, checkConfiguredBackends, runBackendChecks } from "./backend.js";
import {
  checkAssetsGitignore,
  checkMissingAssets,
  checkOrphanedJobs,
  checkOrphanedTargets,
  checkStateJson,
  checkStrayVariantDirs,
  STATE_CHECK_NAMES,
} from "./state.js";
import {
  type CheckResult,
  type DefinitionSet,
  type DoctorVideo,
  type VideoDefinitionSet,
} from "./types.js";
import {
  checkCrossStageConsistency,
  checkFindings,
  checkUnusedAssets,
  checkWorkflowFiles,
  collectUsedKinds,
  stageCheck,
} from "./video.js";
import {
  checkCodexPath,
  checkKonteRelease,
  checkTypeCheck,
  reducedScopeCheck,
  videoTypeCheckOf,
} from "./workspace.js";

export function registerDoctorCommand(program: Command): void {
  const doctor = program
    .command("doctor")
    .description("Check project health")
    .option(
      "--backends",
      "Also probe every backend's connectivity, not just the ones the project uses",
    )
    .option("--all-videos", "Check every video in the workspace, not just the current one")
    .option("-v, --verbose", "Show every check, including passing ones")
    .addHelpText(
      "after",
      `
Runs a battery of health checks over the project: state, type check, definitions,
machine findings, orphaned jobs/targets, whether every declared asset's backend is
configured, the backends the project uses, and whether a newer konte release is out
(checked once a day; KONTE_UPDATE_CHECK=0 turns it off).

By default only the current video is checked. Pass --all-videos to check every video in the
workspace, each under its own heading; the workspace-level checks run once.

By default only actionable checks (warnings and failures) are printed, followed by a
summary; passing checks are hidden. Pass -v to print
every check.

By default a backend is probed only if an asset uses it. Pass --backends to probe
every backend (ComfyUI, FAL, local ffmpeg) regardless. A backend surfaced only by
--backends reports as WARN when unavailable, so it
never changes the exit code. --backends also shows passing backend checks (with
their live GPU/queue diagnostics), which are otherwise hidden.

Examples:
  konte doctor                Health-check the current video (problems only)
  konte doctor --all-videos   Health-check every video in the workspace
  konte doctor -v             Show every check, including passing ones
  konte doctor --backends     Also survey which backends are reachable/configured
`,
    )
    .action(async (opts: { backends?: boolean; verbose?: boolean; allVideos?: boolean }) => {
      // Backend connectivity/credentials, ffmpeg and the type check over `adapters/` are
      // workspace-level concerns, so doctor runs without a selected video: the full project battery
      // when one is selected, and only the workspace-level checks otherwise (so `konte doctor
      // --backends` works before any video exists). The reduced scope is itself surfaced as a WARN.
      const workspaceRoot = requireWorkspaceRoot();
      const selection = currentRoots()?.video;
      const targets: DoctorVideo[] = opts.allVideos
        ? (await listVideos(workspaceRoot)).map((name) => ({
            name,
            root: path.join(workspaceRoot, VIDEOS_DIR, name),
          }))
        : selection?.kind === "selected"
          ? [{ name: null, root: selection.root }]
          : [];
      const checks: CheckResult[] = [];
      const usedKinds = new Set<AssetDefinition["kind"]>();
      // The definitions the backend check scans; a video whose definitions could not be loaded
      // has none here.
      const defs: VideoDefinitionSet[] = [];

      // With --all-videos no single video is in scope, so each video's type errors come back under
      // `otherVideos` and fail only that video.
      const typeCheck = await checkTypeCheck(
        workspaceRoot,
        opts.allVideos ? null : (targets[0]?.root ?? null),
      );
      checks.push(typeCheck.check);

      for (const target of targets) {
        const videoChecks: CheckResult[] = [];
        const videoTypeCheck =
          target.name === null ? null : videoTypeCheckOf(workspaceRoot, target, typeCheck);
        if (videoTypeCheck) videoChecks.push(videoTypeCheck);
        const result = await runVideoChecks(
          { workspace: workspaceRoot, video: target.root },
          typeCheck.check.status === "FAIL" || videoTypeCheck?.status === "FAIL",
        );
        videoChecks.push(...result.checks);
        for (const kind of result.usedKinds) usedKinds.add(kind);
        if (result.defs) defs.push({ name: target.name, ...result.defs });
        checks.push(
          ...videoChecks.map((check) =>
            target.name === null ? check : { ...check, video: target.name },
          ),
        );
      }
      if (targets.length === 0) checks.push(reducedScopeCheck(selection, opts.allVideos));

      checks.push(...(await runBackendChecks(workspaceRoot, targets, usedKinds)));

      // --backends surveys the connectivity of every backend not already probed above (a project
      // with no adapters yet, or no video selected, uses none), so a backend can be weighed before
      // it is wired. These are advisory: an unused, unreachable backend is a WARN, never a FAIL, so
      // the survey never changes the exit code.
      if (opts.backends) {
        const surveyed = new Set(ALL_BACKEND_KINDS.filter((kind) => !usedKinds.has(kind)));
        checks.push(...(await runBackendChecks(workspaceRoot, targets, surveyed, true)));
      }

      // Backend configuration is workspace-level, so this runs even with no video selected or
      // broken definitions.
      checks.push(await checkConfiguredBackends(workspaceRoot, defs));

      const codexPath = await checkCodexPath();
      if (codexPath) checks.push(codexPath);

      checks.push(await checkKonteRelease());

      const failCount = checks.filter((c) => c.status === "FAIL").length;
      if (failCount > 0) process.exitCode = 1;

      // Surface only actionable checks (WARN/FAIL) by default, so neither a human nor an agent
      // pays attention (or tokens) on a wall of PASS lines. -v shows everything; a passing
      // backend check is kept when --backends explicitly asked to survey connectivity, since its
      // message carries live GPU/queue diagnostics.
      const visible = checks.filter(
        (c) => opts.verbose || c.status !== "PASS" || (opts.backends && c.backend),
      );

      const printCheck = (check: CheckResult) => {
        const icon = check.status === "PASS" ? "✓" : check.status === "WARN" ? "!" : "✗";
        console.log(`${icon} ${check.status} ${check.name}: ${check.message}`);
        for (const detail of check.details ?? []) {
          console.log(`    ${detail}`);
        }
      };
      visible.filter((c) => c.video === undefined).forEach(printCheck);
      for (const target of targets) {
        const group = visible.filter((c) => c.video !== undefined && c.video === target.name);
        if (group.length === 0) continue;
        console.log(`\nVideo: ${target.name}`);
        group.forEach(printCheck);
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

// One video's own battery. `typeCheckFailed` skips every check that imports its definitions: when
// the project does not type-check, those imports crash at runtime with errors unrelated to the real
// cause, so the type check is pointed at instead. konte.state.json and the definitions are each
// loaded once and handed to every check; the state-only ones run regardless.
async function runVideoChecks(
  roots: VideoRoots,
  typeCheckFailed: boolean,
): Promise<{
  checks: CheckResult[];
  usedKinds: Set<AssetDefinition["kind"]>;
  defs: DefinitionSet | null;
}> {
  const videoRoot = roots.video;
  const checks: CheckResult[] = [];
  let usedKinds = new Set<AssetDefinition["kind"]>();
  let defs: DefinitionSet | null = null;

  const state = await checkStateJson(videoRoot);
  checks.push(state.check);
  const { manager } = state;

  if (typeCheckFailed) {
    checks.push({
      name: "definition checks",
      status: "WARN",
      message: "skipped — resolve the type errors above first",
    });
  } else {
    const loaded = await loadStageDefinitions(videoRoot, { tolerant: true });
    const { reference, animatic, video } = loaded;
    checks.push(stageCheck("animatic", animatic, loaded.errors.animatic));
    checks.push(
      animatic
        ? stageCheck("video", video, loaded.errors.video)
        : {
            name: "video",
            status: "WARN",
            message: "skipped — video.tsx imports animatic.tsx, which did not load",
          },
    );
    checks.push(stageCheck("reference", reference, loaded.errors.reference));
    usedKinds = collectUsedKinds(video, animatic, reference);
    defs = { video, animatic, reference };
    await applyResolutionDefinitions({ videoRoot, definitions: defs, state: manager?.getState() });

    if (video) {
      checks.push(await checkWorkflowFiles(roots, video, animatic, reference));
    }

    if (video && animatic) {
      checks.push(...checkCrossStageConsistency(video, animatic, reference ?? undefined));
    }

    if (video) {
      checks.push(checkUnusedAssets(video, animatic, reference ?? undefined));
    }

    checks.push(...(await checkFindings(videoRoot, defs, manager)));
  }

  if (manager) {
    checks.push(await checkOrphanedJobs(videoRoot, manager));
    checks.push(await checkOrphanedTargets(videoRoot, manager, defs));
    checks.push(await checkStrayVariantDirs(videoRoot, manager));
    checks.push(await checkMissingAssets(videoRoot, manager));
    checks.push(await checkAssetsGitignore(videoRoot, manager));
  } else {
    checks.push(
      ...STATE_CHECK_NAMES.map(
        (name): CheckResult => ({ name, status: "PASS", message: "no state to check" }),
      ),
    );
  }
  return { checks, usedKinds, defs };
}
