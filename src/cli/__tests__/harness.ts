import * as fs from "node:fs/promises";
import * as path from "node:path";
import { format as utilFormat } from "node:util";
import { DIRECTION_SECTIONS } from "../../core/address.js";
import { applyDirectionSectionDecisions } from "../../core/direction-acceptance.js";
import { KonteError } from "../../core/errors.js";
import { syncFileAssets } from "../../core/file-sync.js";
import { StateManager } from "../../core/state/index.js";
import { SCHEMA_VERSION } from "../../core/types/index.js";
import { buildProgram } from "../program.js";
import { loadDirectionIfPresent, loadStageDefinitions } from "../load-definition.js";
import { writeFixtureVideo } from "./fixture-video.js";

// In-process CLI runner shared by the command-level test suites. Instead of spawning
// `bun run src/cli/index.ts` per call (a fresh Bun runtime + tsc type-check + template sync
// every time — ~0.8s each), it builds a fresh Command and drives it inside this process with
// project checks skipped, capturing stdout/stderr and translating exits into the same
// {stdout, stderr} / thrown {code, stdout, stderr} shape the subprocess used. A handful of
// full-stack smoke tests live in cli.e2e.test.ts and still spawn the real binary.
class ExitSignal extends Error {
  constructor(readonly exitCode: number) {
    super(`process.exit(${exitCode})`);
  }
}

function isCommanderError(err: unknown): err is { exitCode: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "exitCode" in err &&
    typeof (err as { exitCode: unknown }).exitCode === "number"
  );
}

export async function run(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const capture =
    (chunks: string[]) =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      const cb = rest.find((r) => typeof r === "function") as ((e?: Error) => void) | undefined;
      cb?.();
      return true;
    };

  // Commands write via both console.* (Bun's console is native and bypasses a
  // process.stdout.write override) and direct process.stdout/stderr.write (job
  // wait/logs, select), so intercept both.
  const line =
    (chunks: string[]) =>
    (...a: unknown[]) => {
      chunks.push(`${utilFormat(...a)}\n`);
    };
  const origConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  // The real CLI is one process per command, so its preAction is free to load the workspace's
  // credentials straight into process.env. In-process, that env would outlive the command and
  // bleed the fixture's credentials into every later test — so snapshot it and put it back.
  const prevEnv = { ...process.env };

  // Bun ignores `process.exitCode = undefined`, so a prior command's 1 would outlive it.
  process.exitCode = 0;
  if (cwd) process.chdir(cwd);
  console.log = line(outChunks);
  console.info = line(outChunks);
  console.warn = line(errChunks);
  console.error = line(errChunks);
  process.stdout.write = capture(outChunks) as typeof process.stdout.write;
  process.stderr.write = capture(errChunks) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;

  let exitCode = 0;
  try {
    const program = buildProgram({ skipProjectChecks: true });
    program.exitOverride();
    await program.parseAsync(args, { from: "user" });
    exitCode = process.exitCode ? Number(process.exitCode) : 0;
  } catch (err) {
    if (err instanceof ExitSignal) {
      exitCode = err.exitCode;
    } else if (err instanceof KonteError) {
      // Mirror the entrypoint's top-level formatting so stderr carries the code.
      errChunks.push(`Error [${err.code}]: ${err.message}\n`);
      exitCode = 1;
    } else if (isCommanderError(err)) {
      // Help/version/usage errors — commander already wrote text to the captured streams.
      exitCode = err.exitCode || 1;
    } else {
      errChunks.push(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      exitCode = 1;
    }
  } finally {
    console.log = origConsole.log;
    console.info = origConsole.info;
    console.warn = origConsole.warn;
    console.error = origConsole.error;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
    process.chdir(prevCwd);
    process.exitCode = prevExitCode ?? 0;
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
  }

  const stdout = outChunks.join("");
  const stderr = errChunks.join("");
  if (exitCode !== 0) {
    // Carry the command's own stderr in the message: a failure that only shows up under load is
    // read from a reporter line, which prints nothing but this.
    const detail = (stderr.trim() || stdout.trim()).slice(-2000);
    throw Object.assign(
      new Error(
        `konte ${args.join(" ")} exited with code ${exitCode}${detail ? `\n${detail}` : ""}`,
      ),
      { code: exitCode, stdout, stderr },
    );
  }
  return { stdout, stderr };
}

export interface InitedWorkspace {
  workspace: string;
  video: string;
}

/**
 * Scaffolds a workspace with one video in it — the shape every command resolves its roots from.
 *
 * `video` is the root the old single-directory project used to be: the definitions, state,
 * assets and reviews. `workspace` holds konte.config.json, the adapters and tsconfig.
 *
 * By default it scaffolds the blank template and writes the TESTS' own video over it
 * (`writeFixtureVideo`), so the suite never asserts against a template, which has to stay free to
 * change. Pass an explicit `template` to exercise the template scaffolding.
 */
export async function initWorkspace(
  dir: string,
  { template, video = "main" }: { template?: string; video?: string } = {},
): Promise<InitedWorkspace> {
  const workspace = path.resolve(dir);
  await fs.mkdir(workspace, { recursive: true });
  await run(["workspace", "new"], workspace);
  await run(["video", "new", video, "--template", template ?? "blank"], workspace);
  const videoRoot = path.join(workspace, "videos", video);
  if (template === undefined) await writeFixtureVideo(videoRoot);
  return { workspace, video: videoRoot };
}

// `doctor` exits non-zero when any check FAILs; tests that assert on a single check's
// status (not the overall exit code) capture stdout regardless of the exit code.
export async function runCapture(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run(args, cwd);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export interface DoctorCheck {
  status: "PASS" | "WARN" | "FAIL";
  name: string;
  message: string;
  details: string[];
}

// One check per "<icon> <STATUS> <name>: <message>" line, with its indented detail lines under it.
// Always run with --all, so a check a test asks about is reported even when it passes.
export async function doctorChecks(
  projectDir: string,
  args: string[] = [],
): Promise<DoctorCheck[]> {
  const { stdout } = await runCapture(["doctor", "--all", ...args], projectDir);
  const checks: DoctorCheck[] = [];
  for (const line of stdout.split("\n")) {
    const head = line.match(/^\S (PASS|WARN|FAIL) ([^:]+): (.*)$/);
    if (head) {
      checks.push({
        status: head[1] as DoctorCheck["status"],
        name: head[2]!,
        message: head[3]!,
        details: [],
      });
    } else if (line.startsWith("    ") && checks.length > 0) {
      checks.at(-1)!.details.push(line.trim());
    }
  }
  return checks;
}

export async function doctorCheck(
  projectDir: string,
  name: string,
  args: string[] = [],
): Promise<DoctorCheck | undefined> {
  return (await doctorChecks(projectDir, args)).find((check) => check.name === name);
}

// Seed the direction acceptance a real reviewer records in `konte preview direction`, so a test can
// exercise the animatic/video spend gate without driving the preview UI. Accepts every section, as
// a reviewer who agreed with the whole page would — the gate demands every part, so anything less
// leaves it blocked.
export async function acceptDirection(projectDir: string): Promise<void> {
  const direction = await loadDirectionIfPresent(projectDir);
  if (!direction) return;
  const statePath = path.join(projectDir, "konte.state.json");
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf-8"));
  } catch {
    state = { schemaVersion: SCHEMA_VERSION, assets: {} };
  }
  state.directionAcceptance = applyDirectionSectionDecisions(
    direction,
    null,
    Object.fromEntries(DIRECTION_SECTIONS.map((s) => [s, true])),
  );
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

// Seed the accept a reviewer gives each `file` asset in `konte preview reference`.
export async function acceptFileAssets(projectDir: string): Promise<void> {
  const { video, animatic, reference } = await loadStageDefinitions(projectDir);
  await StateManager.withLock(projectDir, async (m) => {
    await syncFileAssets({ reference, animatic, video }, m);
    for (const [address, target] of Object.entries(m.getState().assets)) {
      for (const [variantId, v] of Object.entries(target.variants ?? {})) {
        if (v.file?.startsWith("assets/files/") && v.status !== "accepted") {
          m.setAccepted(address, variantId);
        }
      }
    }
  });
}

// Poll until `predicate` holds, so a test never races a fixed wall-clock sleep.
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
