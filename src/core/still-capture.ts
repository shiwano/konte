import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KonteError, errorMessage } from "./errors.js";
import {
  assertCaptureMediaLoaded,
  ensureHyperFrames,
  linkIntoWorkspace,
  makeCaptureWorkspace,
  silenceHyperFramesLogs,
} from "./hyperframes.js";

/**
 * Render one HTML document to a single still image, captured at t=0 by the same headless Chromium
 * the compositions render through. `assetFiles` maps a workspace-relative name the HTML references
 * to the absolute file behind it.
 *
 * `format: "png"` is also the engine's alpha path — it forces `html`/`body` transparent, so a page
 * wanting an opaque ground must paint it on an element inside.
 */
export async function captureHtmlToImage(options: {
  html: string;
  assetFiles: Record<string, string>;
  outputFile: string;
  videoRoot: string;
  size: { width: number; height: number };
  format?: "png" | "jpeg";
  quality?: number;
}): Promise<void> {
  const { html, assetFiles, outputFile, size } = options;
  const format = options.format ?? "png";

  await ensureHyperFrames();
  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const {
    createFileServer,
    createCaptureSession,
    initializeSession,
    captureFrame,
    closeCaptureSession,
  } = await import("@hyperframes/producer");

  const restoreLogs = silenceHyperFramesLogs();
  const workspace = await makeCaptureWorkspace(options.videoRoot, "still-");
  try {
    await fs.writeFile(path.join(workspace, "index.html"), html, "utf-8");
    for (const [relativeName, absolutePath] of Object.entries(assetFiles)) {
      const target = path.join(workspace, relativeName);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await linkIntoWorkspace(path.resolve(absolutePath), target);
    }

    // The server is closed in its own finally, and before the session's: a rejection from
    // `createCaptureSession` (Chromium failing to start) would otherwise leave a listening handle
    // behind that keeps the process alive, and so would a throw from `closeCaptureSession`.
    const server = await createFileServer({ projectDir: workspace, fps: { num: 1, den: 1 } });
    try {
      const session = await createCaptureSession(server.url, path.dirname(outputFile), {
        width: size.width,
        height: size.height,
        // A still has no clock. 1fps quantizes t=0 onto its own grid, which is t=0.
        fps: { num: 1, den: 1 },
        format,
        ...(options.quality !== undefined ? { quality: options.quality } : {}),
      });
      try {
        await initializeSession(session);
        assertCaptureMediaLoaded(session, (urlPath) => assetFiles[urlPath.slice(1)] ?? null);
        const captured = await captureFrame(session, 0, 0);
        if (path.resolve(captured.path) !== path.resolve(outputFile)) {
          await fs.rename(captured.path, outputFile);
        }
      } finally {
        await closeCaptureSession(session);
      }
    } finally {
      server.close();
    }
  } catch (err) {
    if (err instanceof KonteError) throw err;
    throw new KonteError("HYPERFRAMES_ERROR", `Still capture failed: ${errorMessage(err)}`);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    restoreLogs();
  }
}
