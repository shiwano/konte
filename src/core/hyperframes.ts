import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { format } from "node:util";
import type { CaptureSession } from "@hyperframes/producer";
import { ensureChromium } from "./chromium.js";
import { KonteError, errorMessage } from "./errors.js";
import { leadPathWithFfmpeg } from "./ffmpeg-binary.js";
import { ensureHyperFramesEnv } from "./hyperframes-env.js";
import { redactUrls } from "./redact-url.js";

export type { SrtEntry } from "./srt.js";
export { parseSrt } from "./srt.js";

export async function ensureHyperFrames(): Promise<void> {
  ensureHyperFramesEnv();
  await ensureChromium();
  // HyperFrames extracts, encodes and probes media by shelling out to bare `ffmpeg`/`ffprobe`, so
  // PATH is the only lever that points it at the build konte provisioned rather than the host's.
  await leadPathWithFfmpeg();

  try {
    await import("@hyperframes/producer");
  } catch {
    throw new KonteError("HYPERFRAMES_NOT_FOUND", "@hyperframes/producer is not installed.");
  }
}

/**
 * Drop HyperFrames' progress chatter (browser launch, session init phases, forwarded page logs)
 * for the duration of a capture. It goes to `console.log` with no logger hook to redirect it, and
 * konte's stdout is its own output contract. `console.warn`/`console.error` are left alone, so
 * warnings and failures still surface. Set `KONTE_DEBUG=1` to keep the chatter.
 *
 * Returns the restore function; call it in a `finally`. The swap is process-global, so keep the
 * quiet window around the producer call only.
 */
export function silenceHyperFramesLogs(): () => void {
  if (process.env.KONTE_DEBUG === "1") return () => {};
  const original = console.log;
  console.log = () => {};
  return () => {
    console.log = original;
  };
}

// A capture removes its workspace when it ends; one older than this was left by a killed process.
const STALE_CAPTURE_WORKSPACE_MS = 24 * 60 * 60 * 1000;

/**
 * A throwaway workspace for the capture file server, under the video so a hard link into it
 * (`linkIntoWorkspace`) stays on the volume its takes live on. Sweeps stale ones on the way.
 */
export async function makeCaptureWorkspace(videoRoot: string, prefix: string): Promise<string> {
  const root = path.join(videoRoot, ".konte", "cache", "capture");
  await fs.mkdir(root, { recursive: true });
  const cutoff = Date.now() - STALE_CAPTURE_WORKSPACE_MS;
  for (const entry of await fs.readdir(root).catch(() => [])) {
    const dir = path.join(root, entry);
    try {
      if ((await fs.stat(dir)).mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort: a concurrent sweep may have removed it
    }
  }
  return fs.mkdtemp(path.join(root, prefix));
}

/**
 * Place `source` at `target` in a capture workspace: a symlink; where the OS refuses one (Windows
 * without Developer Mode), a hard link; across volumes, a copy. An existing `target` is kept.
 */
export async function linkIntoWorkspace(source: string, target: string): Promise<void> {
  try {
    await fs.symlink(source, target);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    if (code !== "EPERM" && code !== "EACCES") throw err;
  }
  try {
    await fs.link(source, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") throw err;
    await fs.copyFile(source, target);
  }
}

/**
 * Refuse a capture session whose media did not load: the producer only warns and draws the element
 * blank. A `src` still holding a `__konte:…__` placeholder is a layer that resolved to nothing,
 * drawn as nothing on purpose. `describe` names a source by the served URL's path, still
 * percent-encoded; null falls back to the decoded path.
 */
export function assertCaptureMediaLoaded(
  session: CaptureSession,
  describe: (urlPath: string) => string | null = () => null,
): void {
  const failed = new Set<string>();
  const pending = new Set<string>();
  for (const w of session.warnings) {
    const into =
      w.code === "media_load_failed"
        ? failed
        : w.code === "media_readiness_timeout"
          ? pending
          : null;
    if (!into) continue;
    for (const src of w.details?.sources ?? []) {
      if (src.includes("__konte:")) continue;
      const urlPath = urlPathOf(src);
      into.add(describe(urlPath) ?? safeDecode(urlPath));
    }
  }
  const parts: string[] = [];
  if (failed.size > 0) parts.push(`media failed to load: ${[...failed].join(", ")}`);
  if (pending.size > 0)
    parts.push(`media still loading at the timeout: ${[...pending].join(", ")}`);
  if (parts.length === 0) return;
  throw new KonteError(
    "FRAME_CAPTURE_FAILED",
    `Capture refused, ${parts.join("; ")} — re-run with KONTE_DEBUG=1 for the renderer's own diagnostics`,
  );
}

function urlPathOf(src: string): string {
  try {
    return new URL(src).pathname;
  } catch {
    return src;
  }
}

function safeDecode(urlPath: string): string {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return urlPath;
  }
}

const renderLogs = new AsyncLocalStorage<(line: string) => void>();
const activeRenderLogs = new Set<(line: string) => void>();
let restoreRenderConsole: (() => void) | undefined;

// Producer's compiler and browser helpers bypass its per-job logger.
async function captureRenderLogs<T>(
  onLog: (line: string) => void,
  render: () => Promise<T>,
): Promise<T> {
  if (activeRenderLogs.size === 0) {
    const originals = {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      error: console.error,
    };
    for (const level of Object.keys(originals) as Array<keyof typeof originals>) {
      console[level] = (...args: unknown[]) => {
        const sink = renderLogs.getStore();
        if (sink) {
          sink(`${level}: ${format(...args)}`);
        } else if (
          typeof args[0] === "string" &&
          /^\[(?:HyperFrames|Browser(?::[^\]]+)?|non-blocking)\]/.test(args[0])
        ) {
          // Shared browser events arrive outside the render's async context.
          for (const log of activeRenderLogs) log(`shared browser ${level}: ${format(...args)}`);
        } else {
          originals[level](...args);
        }
      };
    }
    restoreRenderConsole = () => Object.assign(console, originals);
  }
  activeRenderLogs.add(onLog);
  try {
    return await renderLogs.run(onLog, render);
  } finally {
    activeRenderLogs.delete(onLog);
    if (activeRenderLogs.size === 0) {
      restoreRenderConsole?.();
      restoreRenderConsole = undefined;
    }
  }
}

/**
 * Render one composition to `outputFile`, returning the correctness warnings the render completed
 * with. A best-effort render (the default strictness) finishes and reports what it had to let
 * through — a frame captured before its media was ready, say. The file exists either way, so these
 * never fail the render; they ride the caller's own warnings channel to the job log and the export
 * metadata. Returned rather than printed: `renderVideoToFile` owns reporting, and stdout is
 * the CLI's.
 */
export async function compositeWithHyperFrames(options: {
  compositionHtml: string;
  assetFiles: Record<string, string>;
  outputFile: string;
  videoRoot: string;
  fps: number;
  size: { width: number; height: number };
  duration: number;
  quality: "draft" | "standard" | "high";
  onLog?: (line: string) => void;
}): Promise<string[]> {
  const { compositionHtml, assetFiles, outputFile, fps, quality } = options;

  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const workspace = await makeCaptureWorkspace(options.videoRoot, "render-");

  try {
    await fs.writeFile(path.join(workspace, "index.html"), compositionHtml, "utf-8");

    for (const [relativeName, absolutePath] of Object.entries(assetFiles)) {
      const source = path.resolve(absolutePath);
      const target = path.join(workspace, relativeName);
      await linkIntoWorkspace(source, target);
    }

    const { createRenderJob, executeRenderJob } = await import("@hyperframes/producer");
    const onLog = (line: string) =>
      options.onLog?.(redactUrls(`[${path.basename(outputFile)}] ${line}`));
    const log = (level: string, message: string, meta?: Record<string, unknown>) => {
      onLog(`${level}: ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    };

    const job = createRenderJob({
      fps,
      quality,
      entryFile: "index.html",
      ...(options.onLog && {
        logger: {
          error: (message, meta) => log("error", message, meta),
          warn: (message, meta) => log("warn", message, meta),
          info: (message, meta) => log("info", message, meta),
          debug: (message, meta) => log("debug", message, meta),
        },
      }),
    });

    if (options.onLog) {
      await captureRenderLogs(onLog, () => executeRenderJob(job, workspace, outputFile));
    } else {
      await executeRenderJob(job, workspace, outputFile);
    }

    return job.warnings.map(
      (w) => `render (${path.basename(outputFile)}): ${w.code} — ${w.message}`,
    );
  } catch (err) {
    if (err instanceof KonteError) throw err;
    const message = errorMessage(err);
    throw new KonteError("HYPERFRAMES_ERROR", `HyperFrames render failed: ${message}`);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
