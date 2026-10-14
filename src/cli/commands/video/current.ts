import type { Command } from "commander";
import { resolveDirectionTimeline } from "../../../core/dsl/direction.js";
import { formatSeconds } from "../../../core/format-duration.js";
import { formatRelativeTime } from "../../../core/format-timestamp.js";
import { JobManager } from "../../../core/job-manager.js";
import { loadLatestReviewRecord, reviewStage } from "../../../core/review-record.js";
import { listVideos } from "../../../core/roots.js";
import { currentRoots, requireWorkspaceRoot } from "../../context.js";
import { loadDirectionIfPresent } from "../../load-definition.js";
import { declareScope } from "../../scope.js";

// The digest `konte video current` prints: enough to decide whether this session continues the
// current video or starts a new one, and nothing more. No shot list, no feedback text, no Next
// steps — those belong to `status`, and carrying them here would drag a fresh idea toward the
// piece the human just left.
interface VideoDigest {
  video: string | null;
  state: "selected" | "not-selected" | "not-found" | "no-videos";
  logline: string | null;
  shots: number;
  // Seconds on the timeline; the beats it is written as on a piece cut to a song no take of is read.
  runtime: { seconds: number } | { beats: number };
  lastReview: { scope: string; at: string } | null;
  lastExport: { scope: string; at: string } | null;
}

async function buildDigest(videoRoot: string, name: string): Promise<VideoDigest> {
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  // Every shot, aside included — this is the clock, and it has to agree with what `konte export`
  // reports for the same piece.
  const timings = direction ? [...resolveDirectionTimeline(direction).timings.values()] : [];

  const review = await loadLatestReviewRecord(videoRoot);
  const exports = (await new JobManager(videoRoot).listJobs({ status: "completed" })).filter(
    (job) => job.kind === "export",
  );
  const lastExport = exports.at(-1);

  return {
    video: name,
    state: "selected",
    logline: direction?.brief.logline ?? null,
    shots: timings.length,
    runtime: timings.every((shot) => shot.duration !== null)
      ? { seconds: timings.reduce((total, shot) => total + shot.duration!, 0) }
      : { beats: timings.reduce((total, shot) => total + (shot.beats ?? 0), 0) },
    lastReview: review ? { scope: reviewStage(review), at: review.createdAt } : null,
    lastExport: lastExport
      ? { scope: "video", at: lastExport.completedAt ?? lastExport.createdAt }
      : null,
  };
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
      : `Runtime: ${"seconds" in digest.runtime ? formatSeconds(digest.runtime.seconds) : `${digest.runtime.beats} beats`} across ${digest.shots} shots`,
  );
  console.log(
    `Last review: ${digest.lastReview ? `${digest.lastReview.scope}, ${formatRelativeTime(digest.lastReview.at)}` : "never"}`,
  );
  console.log(
    `Last export: ${digest.lastExport ? `${digest.lastExport.scope}, ${formatRelativeTime(digest.lastExport.at)}` : "never"}`,
  );
}

export function registerVideoCurrentCommand(video: Command): void {
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
            runtime: { seconds: 0 },
            lastReview: null,
            lastExport: null,
          };
        }

        printDigest(digest);
      }),
    { scope: "workspace", skipTypeCheck: true },
  );
}
