import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobManager } from "../../../core/job-manager.js";
import { saveReviewRecord } from "../../../core/review-record.js";
import { initWorkspace, run } from "../../__tests__/harness.js";

let tmpDir: string;
let workspace: string;
let videoDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-video-current-"));
  ({ workspace, video: videoDir } = await initWorkspace(path.join(tmpDir, "ws"), {
    video: "opening",
  }));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("video current", () => {
  it("digests the current video: what it is, how long, and that nothing has happened yet", async () => {
    const { stdout } = await run(["video", "current"], workspace);

    expect(stdout).toContain("Video: opening");
    expect(stdout).toMatch(/About: .+/);
    expect(stdout).toContain("Runtime: 10s across 3 shots");
    expect(stdout).toContain("Last review: never");
    expect(stdout).toContain("Last export: never");
  });

  // The digest exists to keep a fresh idea clean of the piece the human just left: it must not
  // carry the shot list, feedback text, or the "Next steps" that nudge the agent to continue.
  it("carries no shot list and no next steps", async () => {
    const { stdout } = await run(["video", "current"], workspace);

    expect(stdout).not.toContain("Next steps");
    expect(stdout).not.toContain("shot.01");
  });

  it("reports the latest review's scope and the latest completed export", async () => {
    await saveReviewRecord(
      videoDir,
      {
        mode: "video-preview",
        stage: "video",
        createdAt: new Date().toISOString(),
        context: { shots: [] },
        decisions: {},
      },
      { force: true },
    );
    const jobs = new JobManager(videoDir);
    const exportJob = await jobs.createExportJob({
      outputDir: "dist/video/main/20260101T000000000",
      allowUnaccepted: false,
    });
    await jobs.updateJob(exportJob.id, { status: "completed" });

    const { stdout } = await run(["video", "current"], workspace);
    expect(stdout).toMatch(/Last review: video, .+ ago|just now/);
    expect(stdout).toMatch(/Last export: video, .+ ago|just now/);
  });

  // An in-flight export says nothing about whether the piece shipped.
  it("ignores an export that has not completed", async () => {
    const jobs = new JobManager(videoDir);
    await jobs.createExportJob({
      outputDir: "dist/video/main/20260101T000000000",
      allowUnaccepted: false,
    });

    const { stdout } = await run(["video", "current"], workspace);
    expect(stdout).toContain("Last export: never");
  });

  it("reports an unauthored video as having no shots", async () => {
    await run(["video", "new", "blank-one", "--template", "blank"], workspace);

    const { stdout } = await run(["video", "current"], workspace);
    expect(stdout).toContain("Video: blank-one");
    expect(stdout).toContain("Runtime: no shots yet");
  });

  // The one command the check-in always opens with, so every "which video?" state is a state to
  // report, never an error to throw.
  it("reports an unset current video instead of failing", async () => {
    await fs.rm(path.join(workspace, ".konte", "current-video"));

    const { stdout } = await run(["video", "current"], workspace);

    expect(stdout).toContain("Video: none selected");
  });

  it("reports a current video that no longer exists instead of failing", async () => {
    await fs.writeFile(path.join(workspace, ".konte", "current-video"), "ghost");

    const { stdout } = await run(["video", "current"], workspace);

    expect(stdout).toContain(`the current video "ghost" no longer exists`);
  });

  it("reports an empty workspace instead of failing", async () => {
    await fs.rm(path.join(workspace, "videos"), { recursive: true });
    await fs.rm(path.join(workspace, ".konte", "current-video"));

    const { stdout } = await run(["video", "current"], workspace);

    expect(stdout).toContain("this workspace has no videos");
  });
});
