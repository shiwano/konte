import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageEntryPath } from "../../../../core/roots.js";
import { shortId } from "../../../../core/short-id.js";
import { initWorkspace, run } from "../../../__tests__/harness.js";
import { createPreviewServer } from "../../preview/server.js";

let root: string;
let stop: (() => Promise<unknown>) | null = null;

async function startPreview(): Promise<{
  waitArgs: (id?: string) => string[];
  port: number;
  end: () => void;
}> {
  const project = await initWorkspace(path.join(root, "workspace"));
  const reviewId = `r-${shortId()}`;
  const { server, shutdown, triggerShutdown } = await createPreviewServer({
    videoRoot: project.video,
    videoPath: stageEntryPath(project.video, "video"),
    port: 0,
    mode: "direction-preview",
    stage: "direction",
    reviewId,
  });
  stop = () => {
    triggerShutdown();
    return shutdown;
  };
  return {
    waitArgs: (id = reviewId) => ["review", "wait", id, "--port", String(server.port)],
    port: server.port!,
    end: triggerShutdown,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "konte-review-wait-"));
});
afterEach(async () => {
  await stop?.();
  stop = null;
  await fs.rm(root, { recursive: true, force: true });
});

describe("review wait", () => {
  it("returns once the preview ends, after the preview has printed its outcome", async () => {
    const preview = await startPreview();
    let settled = false;
    const waiting = run(preview.waitArgs()).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);

    preview.end();
    const { stdout } = await waiting;
    const outcome = stdout.indexOf("not submitted (closed without submitting)");
    expect(outcome).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf("Review ended")).toBeGreaterThan(outcome);
  });

  it("treats another review's server on the same port as this review ended", async () => {
    const preview = await startPreview();
    const { stdout } = await run(preview.waitArgs(`r-${shortId()}`));
    expect(stdout).toContain("Review ended");
  });

  it("treats a server that is already gone as this review ended", async () => {
    const preview = await startPreview();
    const args = preview.waitArgs();
    await stop?.();
    stop = null;
    const { stdout } = await run(args);
    expect(stdout).toContain("Review ended");
  });

  it("leaves the review open when the timeout is reached", async () => {
    const preview = await startPreview();
    await expect(run([...preview.waitArgs(), "--timeout", "1"])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(
        `Next steps:\n  konte review wait ${preview.waitArgs()[2]} --port ${preview.port}`,
      ),
    });
    const ping = `http://127.0.0.1:${preview.port}/api/ping`;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http.get(ping, (res) => resolve(res.resume().statusCode)).on("error", reject);
    });
    expect(status).toBe(204);
  });

  it("refuses a malformed review id or port", async () => {
    await expect(run(["review", "wait", "../x", "--port", "4649"])).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_OPTION"),
    });
    await expect(run(["review", "wait", `r-${shortId()}`, "--port", "http"])).rejects.toMatchObject(
      {
        stderr: expect.stringContaining("INVALID_OPTION"),
      },
    );
  });
});
