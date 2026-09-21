import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { parseTimecode } from "../../../core/timecode.js";
import type {
  AnimaticDefinition,
  StageDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";
import { parseNumberOption } from "../../parse-option.js";
import type { ProbeTargets } from "./resolve-arg.js";

// Run `probe` over each target, separating a sweep's targets with a blank line.
export async function probeEach(
  targets: ProbeTargets,
  probe: (variantId: string) => Promise<unknown>,
): Promise<void> {
  for (const [i, variantId] of targets.variantIds.entries()) {
    if (targets.multi && i > 0) console.log("");
    await probe(variantId);
  }
}

// The core helpers key a `file` video-root-relative (their on-disk contract); probe's output is
// meant to be opened as-is regardless of cwd, so it is resolved to absolute for display.
export function withAbsoluteFiles<T extends { file: string }>(videoRoot: string, items: T[]): T[] {
  return items.map((item) => ({ ...item, file: path.resolve(videoRoot, item.file) }));
}

// The frame-capture options the two thumbnail probes share: scene detection bounded by
// `--threshold`/`--max-frames`, or exact `--at` timecodes.
export interface FrameCaptureOptions {
  threshold: string;
  maxFrames: string;
  at?: string;
}

export function addFrameCaptureOptions(command: Command): Command {
  return command
    .option("--threshold <n>", "Scene detection threshold (0.0-1.0)", "0.3")
    .option("--max-frames <n>", "Maximum number of frames", "8")
    .option(
      "--at <timestamps>",
      'Capture at specific timecodes (comma-separated; "90", "90s", "1:30", "00:01:30", "1:30.5")',
    );
}

export function parseFrameCaptureOptions(opts: FrameCaptureOptions): {
  threshold: number;
  maxFrames: number;
  timestamps: number[] | undefined;
} {
  return {
    threshold: parseNumberOption("--threshold", opts.threshold, { min: 0, max: 1 })!,
    maxFrames: parseNumberOption("--max-frames", opts.maxFrames, { integer: true, min: 1 })!,
    timestamps: opts.at ? opts.at.split(",").map((t) => parseTimecode(t.trim())) : undefined,
  };
}

export function compositionStage(
  loaded: { video: VideoDefinition; animatic: AnimaticDefinition | null },
  stage: "animatic" | "video",
): StageDefinition {
  if (stage === "video") return loaded.video;
  if (!loaded.animatic) {
    throw new KonteError("ANIMATIC_NOT_FOUND", "No animatic.tsx found in the video root");
  }
  return loaded.animatic;
}

export function requireCompositionShot(video: StageDefinition, shotId: string): void {
  const shot = video.shots.find((s) => s.id === shotId);
  if (!shot) throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" not found`);
  if (shot.shotFn) return;
  throw new KonteError(
    "SHOT_NOT_FOUND",
    shot.aside
      ? `Shot "${shotId}" is an aside the ${video.stage} does not board — konte fills its span with a slug, so there is no take to read here. Its picture is on the video.`
      : `Shot "${shotId}" has no composition to capture`,
  );
}
