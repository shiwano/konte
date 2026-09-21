import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { collectShots } from "../../core/direction.js";
import { KonteError } from "../../core/errors.js";
import { formatRelativeTime } from "../../core/format-timestamp.js";
import {
  loadVideoTemplate,
  VIDEO_BINARY_FILES,
  VIDEO_TEMPLATE_NAMES,
} from "../../core/generated/template-assets.js";
import { JobManager } from "../../core/job-manager.js";
import { loadLatestReviewRecord, reviewStage } from "../../core/review-record.js";
import {
  listVideos,
  readCurrentVideo,
  VIDEO_NAME_PATTERN,
  VIDEOS_DIR,
  writeCurrentVideo,
} from "../../core/roots.js";
import { StateManager } from "../../core/state/index.js";
import { currentRoots, requireWorkspaceRoot } from "../context.js";
import { loadDirectionIfPresent } from "../load-definition.js";
import { declareScope } from "../scope.js";
import { selectPrompt } from "../select.js";
import { pathExists, writeTemplateFiles } from "../template-files.js";

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  blank: "Minimal starter to build a video from scratch",
  "kitchen-sink": "Every DSL feature at once, for type-checking konte itself",
};

async function resolveTemplate(requested: string | undefined): Promise<string> {
  const available = [...VIDEO_TEMPLATE_NAMES].sort();

  if (requested !== undefined) {
    if (!available.includes(requested)) {
      throw new KonteError(
        "INVALID_TEMPLATE",
        `Unknown template "${requested}". Available: ${available.join(", ")}`,
      );
    }
    return requested;
  }

  if (!process.stdin.isTTY) {
    throw new KonteError(
      "TEMPLATE_REQUIRED",
      `No template specified. Re-run with --template <${available.join("|")}>.`,
    );
  }

  return selectPrompt(
    "Select a video template:",
    available.map((name) => ({
      value: name,
      label: name,
      description: TEMPLATE_DESCRIPTIONS[name],
    })),
  );
}

// The digest `konte video current` prints: enough to decide whether this session continues the
// current video or starts a new one, and nothing more. No shot list, no feedback text, no Next
// steps — those belong to `status`, and carrying them here would drag a fresh idea toward the
// piece the human just left.
interface VideoDigest {
  video: string | null;
  state: "selected" | "not-selected" | "not-found" | "no-videos";
  logline: string | null;
  shots: number;
  runtimeSeconds: number;
  lastReview: { scope: string; at: string } | null;
  lastExport: { scope: string; at: string } | null;
}

async function buildDigest(videoRoot: string, name: string): Promise<VideoDigest> {
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  // Every shot, aside included — this is the clock, and it has to agree with what `konte export`
  // reports for the same piece.
  const shots = direction ? collectShots(direction) : [];

  const review = await loadLatestReviewRecord(videoRoot);
  const exports = (await new JobManager(videoRoot).listJobs({ status: "completed" })).filter(
    (job) => job.kind === "export",
  );
  const lastExport = exports.at(-1);

  return {
    video: name,
    state: "selected",
    logline: direction?.brief.logline ?? null,
    shots: shots.length,
    runtimeSeconds: shots.reduce((total, shot) => total + shot.duration, 0),
    lastReview: review ? { scope: reviewStage(review), at: review.createdAt } : null,
    lastExport: lastExport
      ? { scope: "video", at: lastExport.completedAt ?? lastExport.createdAt }
      : null,
  };
}

function formatRuntime(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function printDigest(digest: VideoDigest): void {
  if (digest.state === "no-videos") {
    console.log(`Video: none — this workspace has no videos. Run "konte video new <name>".`);
    return;
  }
  if (digest.state === "not-selected") {
    console.log(`Video: none selected — run "konte video list" to see this workspace's videos.`);
    return;
  }
  if (digest.state === "not-found") {
    console.log(
      `Video: none — the current video "${digest.video}" no longer exists. Run "konte video list".`,
    );
    return;
  }

  console.log(`Video: ${digest.video}`);
  console.log(`About: ${digest.logline ?? "not authored yet"}`);
  console.log(
    digest.shots === 0
      ? "Runtime: no shots yet"
      : `Runtime: ${formatRuntime(digest.runtimeSeconds)} across ${digest.shots} shots`,
  );
  console.log(
    `Last review: ${digest.lastReview ? `${digest.lastReview.scope}, ${formatRelativeTime(digest.lastReview.at)}` : "never"}`,
  );
  console.log(
    `Last export: ${digest.lastExport ? `${digest.lastExport.scope}, ${formatRelativeTime(digest.lastExport.at)}` : "never"}`,
  );
}

export function registerVideoCommand(program: Command): void {
  const video = program.command("video").description("Manage the workspace's videos");

  declareScope(
    video
      .command("new <name>")
      .description("Create a video in this workspace")
      .option(
        "--template <name>",
        `Video template to scaffold (${[...VIDEO_TEMPLATE_NAMES].sort().join(", ")})`,
      )
      .addHelpText(
        "after",
        `
Creates videos/<name>/ from a template and makes it the workspace's current video, so the
commands that follow act on it without any further selection.

Examples:
  konte video new opening --template blank    Scaffold an empty video`,
      )
      .action(async (name: string, options: { template?: string }) => {
        const workspaceRoot = requireWorkspaceRoot();

        // The name becomes a path segment written into the workspace.
        if (!VIDEO_NAME_PATTERN.test(name)) {
          throw new KonteError(
            "INVALID_VIDEO_NAME",
            `Invalid video name "${name}". Use lowercase letters, digits, ".", "_" and "-", starting with a letter or digit.`,
          );
        }

        const videoDir = path.join(workspaceRoot, VIDEOS_DIR, name);
        if (await pathExists(videoDir)) {
          throw new KonteError("VIDEO_ALREADY_EXISTS", `Video "${name}" already exists`);
        }

        const template = await resolveTemplate(options.template);
        const files = await loadVideoTemplate(template);
        if (!files) throw new KonteError("INVALID_TEMPLATE", `Unknown template "${template}"`);

        await fs.mkdir(videoDir, { recursive: true });
        await writeTemplateFiles(videoDir, files, VIDEO_BINARY_FILES);
        await StateManager.init(videoDir);
        await writeCurrentVideo(workspaceRoot, name);

        console.log(`Video "${name}" created from the "${template}" template, and is now current.`);
      }),
    { scope: "workspace" },
  );

  declareScope(
    video
      .command("current")
      .description("Show the current video and where it stands")
      .addHelpText(
        "after",
        `
The session opener: which video commands act on, what it is, how long it runs, where its last
review left off, and whether it has been exported — enough to decide whether to carry it on or
start a new one. It never fails: an empty workspace or an unset current video is reported as a
state, not an error. For what to do next on the video itself, run "konte status".

Examples:
  konte video current          Show the current video and where it stands
`,
      )
      .action(async () => {
        const workspace = requireWorkspaceRoot();
        const selection = currentRoots()?.video;

        let digest: VideoDigest;
        if (selection?.kind === "selected") {
          digest = await buildDigest(selection.root, selection.name);
        } else {
          const empty = (await listVideos(workspace)).length === 0;
          digest = {
            video: selection?.kind === "not-found" ? selection.name : null,
            state:
              selection?.kind === "not-found" ? "not-found" : empty ? "no-videos" : "not-selected",
            logline: null,
            shots: 0,
            runtimeSeconds: 0,
            lastReview: null,
            lastExport: null,
          };
        }

        printDigest(digest);
      }),
    { scope: "workspace", skipTypeCheck: true },
  );

  declareScope(
    video
      .command("list")
      .description("List the videos in this workspace")
      .action(async () => {
        const workspace = requireWorkspaceRoot();
        const videos = await listVideos(workspace);
        const current = await readCurrentVideo(workspace);

        if (videos.length === 0) {
          console.log(`No videos yet. Run "konte video new <name>" to create one.`);
          return;
        }
        for (const name of videos) {
          console.log(`${name === current ? "*" : " "} ${name}`);
        }
      }),
    { scope: "workspace", skipTypeCheck: true },
  );

  declareScope(
    video
      .command("use <name>")
      .description("Set the workspace's current video")
      .action(async (name: string) => {
        const workspace = requireWorkspaceRoot();
        const videos = await listVideos(workspace);
        if (!videos.includes(name)) {
          throw new KonteError(
            "VIDEO_NOT_FOUND",
            videos.length === 0
              ? `No video named "${name}". This workspace has no videos yet — run "konte video new <name>".`
              : `No video named "${name}". Available: ${videos.join(", ")}`,
          );
        }
        await writeCurrentVideo(workspace, name);
        console.log(`Current video: ${name}`);
      }),
    { scope: "workspace" },
  );

  video.addHelpText(
    "after",
    `
Commands that act on one video (generate, status, review, …) take it from the directory you are
in, or — outside any video directory — from the workspace's current video. There is no --video
flag: run "konte --cwd videos/<name> <command>" to target another one without switching.

Examples:
  konte video list             List every video, marking the current one
  konte video use opening      Make "opening" the current video
`,
  );
}
