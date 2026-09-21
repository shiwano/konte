import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach } from "vitest";
import { applyResolutionDefinitions } from "../../../../core/definition-hashes.js";
import { ffmpegBin } from "../../../../core/ffmpeg-binary.js";
import { type ReviewRecord, saveReviewRecord } from "../../../../core/review-record.js";
import { StateManager } from "../../../../core/state/manager.js";
import { feedbackFramePath } from "../../../../core/thumbnail.js";
import { loadVideoAndAnimatic } from "../../../load-definition.js";
import { initWorkspace } from "../../../__tests__/harness.js";

const execFileAsync = promisify(execFile);

// The scaffolded project each `review record show` suite drives, shared by the record-show-*.test.ts
// files the suite runs in parallel. `projectDir` is a live binding: the hooks below and
// `useSubtitleFreeProject` are its only writers.
let tmpDir: string;
let originalCwd: string;
export let projectDir: string;

/**
 * A ready take for shot 01's only asset, so its composition builds — which is what `show` needs
 * before it will look for (or render) any note frame.
 */
export async function seedShotTakes(): Promise<void> {
  const { video } = await loadVideoAndAnimatic(projectDir);
  await fs.mkdir(path.join(projectDir, "assets"), { recursive: true });
  const sm = await StateManager.load(projectDir);
  for (const shot of video.shots) {
    for (const name of Object.keys(shot.assets ?? {})) {
      const address = `video:shot.${shot.id}.${name}`;
      const file = path.join("assets", `${shot.id}-${name}.mp4`);
      await fs.writeFile(path.join(projectDir, file), "");
      const variantId = sm.reserveVariantId(address);
      sm.getAssetState(address).variants![variantId]!.file = file;
      sm.setAccepted(address, variantId);
    }
  }
  await sm.save();
}

/** Take one shot's only input away, so its composition stops building — and its notes stop having a
 * frame at all, rendered or not. */
export async function dropShotTakes(shotId: string): Promise<void> {
  const { video } = await loadVideoAndAnimatic(projectDir);
  const shot = video.shots.find((s) => s.id === shotId)!;
  const sm = await StateManager.load(projectDir);
  for (const name of Object.keys(shot.assets ?? {})) {
    sm.getState().assets[`video:shot.${shotId}.${name}`] = { variants: {} };
  }
  await sm.save();
}

/**
 * A second workspace whose shots draw only their take: the fixture captions every shot, and a caption is
 * still something to capture once the picture is gone. Its own project, and so its own module url —
 * `video.tsx` is imported during setup, and an edit after that import is one no loader would see.
 */
export async function useSubtitleFreeProject(): Promise<void> {
  projectDir = (await initWorkspace(path.join(tmpDir, "plain"))).video;
  const file = path.join(projectDir, "video.tsx");
  const src = await fs.readFile(file, "utf-8");
  await fs.writeFile(file, src.replace(/<Subtitle[\s\S]*?\/>/g, ""));
  await seedShotTakes();
}

/**
 * Pre-render a note's frame into the shot's cache dir. `show` derives the same path, so a seeded
 * frame reads as a hit and nothing here drives a headless capture.
 */
export async function writeFrame(
  feedbackId: string,
  localTime: number,
  shotId = "01",
): Promise<void> {
  const { video } = await loadVideoAndAnimatic(projectDir);
  const manager = await StateManager.load(projectDir);
  await applyResolutionDefinitions({ videoRoot: projectDir, state: manager.getState() });
  const rel = await feedbackFramePath({
    video,
    manager,
    videoRoot: projectDir,
    feedbackId,
    shotId,
    localTime,
  });
  if (!rel) throw new Error(`no frame path for ${feedbackId} — shot ${shotId} does not compose`);
  const file = path.join(projectDir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await execFileAsync(await ffmpegBin(), [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=192x108",
    "-frames:v",
    "1",
    file,
  ]);
}

export function record(notes: NonNullable<ReviewRecord["notes"]>): ReviewRecord {
  return {
    mode: "video-preview",
    stage: "video",
    createdAt: "2026-05-16T12:00:00.000Z",
    // One shot, so every note's timeline time is also its shot-local time.
    context: { shots: [{ shotId: "01", duration: 5, variants: { motion: "v-0001" } }] },
    decisions: { "01": "accepted" },
    notes,
  };
}

// A review of `count` notes, each with its frame already on disk.
export async function seedManyNotes(count: number): Promise<NonNullable<ReviewRecord["notes"]>> {
  const notes: NonNullable<ReviewRecord["notes"]> = [];
  for (let i = 0; i < count; i++) {
    const id = `fb-${String(i).padStart(2, "0")}`;
    await writeFrame(id, i + 1);
    notes.push({
      id,
      time: i + 1,
      shotId: "01",
      text: `note ${i}`,
    });
  }
  await saveReviewRecord(projectDir, record(notes), { force: true });
  return notes;
}

export function useReviewShowProject(): void {
  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-review-show-"));
    process.chdir(tmpDir);
    projectDir = (await initWorkspace(path.join(tmpDir, "testproject"))).video;
    await seedShotTakes();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
}
