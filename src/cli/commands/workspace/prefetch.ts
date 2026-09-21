import { ensureChromium } from "../../../core/chromium.js";
import { cloudflaredBin } from "../../../core/cloudflared-binary.js";
import { ffmpegBin, ffprobeBin } from "../../../core/ffmpeg-binary.js";
import { ensureHyperFramesEnv } from "../../../core/hyperframes-env.js";
import { ensureTsc } from "../../../core/tsc.js";
import { errorMessage } from "../../../core/errors.js";

/**
 * Fetches the managed runtimes into `<workspace>/.konte/tools/` while the user is still at the
 * terminal, so the first `generate` is not silently blocked on a 100 MB download.
 *
 * Sequential on purpose: two concurrent downloads interleave their progress lines into noise.
 *
 * A failure is loud but not fatal. A flaky network must not leave a half-built workspace behind —
 * whatever is missing is fetched on first use anyway.
 */
export async function prefetchManagedRuntimes(): Promise<void> {
  ensureHyperFramesEnv();

  await step("ffmpeg", async () => {
    await ffmpegBin();
    await ffprobeBin();
  });
  await step("tsc", () => ensureTsc());
  await step("chromium", () => ensureChromium());
  await step("cloudflared", () => cloudflaredBin());
}

async function step(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const message = errorMessage(err);
    console.error(
      `konte: prefetch failed for ${label} (${message}); it will be fetched on first use`,
    );
  }
}
