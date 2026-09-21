import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import {
  EXPORT_MANIFEST_FILE,
  type ExportManifest,
  ExportManifestSchema,
} from "../../../core/types/index.js";
import { computeExportSignature } from "../../../core/export-signature.js";
import { JobManager } from "../../../core/job-manager.js";
import { computeLastExports } from "../../../core/status-sections.js";
import { parseAddress } from "../../../core/address.js";
import { StateManager } from "../../../core/state/index.js";
import { loadVideoDefinition } from "../../../core/loader.js";
import { ffprobeBin } from "../../../core/ffmpeg-binary.js";
import { probeContainerTags, probeMediaDetail } from "../../../core/video-probe.js";
import { formatBytes } from "../clean-utils.js";
import { fmtSeconds } from "../../audio-sparkline.js";
import { requireVideoRoot } from "../../context.js";
import { stageEntryPath } from "../../../core/roots.js";

interface ExportProbeTarget {
  outputFile: string;
  outOfDate: boolean | null;
  noDelivery: boolean | null;
  // The signature of the definition as it stands now, for a file the job list could not place.
  currentSignature: string | null;
}

// The manifest beside the deliverable: its path when the file is there, its contents when they
// still parse. One konte no longer understands never fails a probe of the bytes themselves.
async function readManifest(fileAbs: string): Promise<{
  path: string;
  manifest: ExportManifest | null;
} | null> {
  const manifestAbs = path.join(path.dirname(fileAbs), EXPORT_MANIFEST_FILE);
  if (!existsSync(manifestAbs)) return null;
  const parsed = await fs
    .readFile(manifestAbs, "utf-8")
    .then((raw) => ExportManifestSchema.safeParse(JSON.parse(raw)))
    .catch(() => null);
  return { path: manifestAbs, manifest: parsed?.success ? parsed.data : null };
}

// The video stream's own frame count and length, to the millisecond — the container's duration
// rounds a frame's drift away. Against a manifest, the frames the direction's clock runs.
function formatPicture(
  video: { frames: number | null; durationSec: number | null } | null,
  manifest: ExportManifest | null,
): string {
  if (!video || (video.frames === null && video.durationSec === null)) return "—";
  const frames = video.frames !== null ? `${video.frames} frames` : "? frames";
  const length = video.durationSec !== null ? `${video.durationSec.toFixed(3)}s` : "?s";
  const expected = manifest
    ? Math.round(manifest.shots.reduce((sum, s) => sum + s.duration, 0) * manifest.fps)
    : null;
  const drift =
    expected !== null && video.frames !== null && video.frames !== expected
      ? `   [direction runs ${expected} frames]`
      : "";
  return `${frames}, ${length}${drift}`;
}

async function resolveTarget(
  arg: string | undefined,
  videoRoot: string,
): Promise<ExportProbeTarget> {
  const manager = await StateManager.load(videoRoot);
  const jobManager = new JobManager(videoRoot);
  const jobs = await jobManager.listJobs();
  // The out-of-date flag needs the current definition's signature; a broken/absent video.tsx just
  // leaves it unknown rather than failing the probe of an already-rendered file.
  const videoDef = await loadVideoDefinition(stageEntryPath(videoRoot, "video")).catch(() => null);
  const currentSignature = videoDef ? () => computeExportSignature(videoDef) : undefined;
  // A rendered deliverable is probeable even when video.tsx is currently broken/absent, so scope on
  // the presence of a video asset in state, not on the (possibly unloadable) definition.
  const videoInScope = Object.keys(manager.getState().assets).some(
    (addr) => parseAddress(addr).stage === "video",
  );
  const lastExports = computeLastExports(videoInScope, jobs, currentSignature);

  const signatureNow = currentSignature?.() ?? null;

  if (arg) {
    const rel = path.isAbsolute(arg) ? path.relative(videoRoot, arg) : arg;
    const match = lastExports.find((e) => e.outputFile === rel);
    return {
      outputFile: rel,
      outOfDate: match?.outOfDate ?? null,
      noDelivery: match?.noDelivery ?? null,
      currentSignature: signatureNow,
    };
  }

  const last = lastExports[0];
  if (!last) {
    throw new KonteError(
      "NO_EXPORT_FOUND",
      'No completed export found — run "konte export video" first, or pass an output file to probe.',
    );
  }
  return {
    outputFile: last.outputFile,
    outOfDate: last.outOfDate,
    noDelivery: last.noDelivery,
    currentSignature: signatureNow,
  };
}

export function registerProbeExportCommand(program: Command): void {
  program
    .command("export [outputFile]")
    .description("Verify an export deliverable's real resolution, duration, fps, frames and audio")
    .addHelpText(
      "after",
      `
Reads the produced MP4 back with ffprobe — the actual bytes, not the render plan — so a delivery
size or mux length that drifted from what was intended shows up here. With no argument it probes the
latest completed export, including a --no-delivery working-size render. Pass a project-relative
or absolute path to probe a specific file. Also reports whether the deliverable is
out of date against the current definition, and reads the sibling manifest.json — when it renders,
what it was rendered with, and whether it is a rough cut.

Examples:
  konte probe export                                  Probe the latest completed export
  konte probe export dist/video/20260716T.../video.mp4   Probe a specific deliverable`,
    )
    .action(async (outputFile: string | undefined) => {
      const videoRoot = requireVideoRoot();
      const target = await resolveTarget(outputFile, videoRoot);
      const fileAbs = path.resolve(videoRoot, target.outputFile);

      if (!existsSync(fileAbs)) {
        throw new KonteError(
          "NO_EXPORT_FOUND",
          `Export file not found: ${target.outputFile} (it may have been cleaned).`,
        );
      }

      await ffprobeBin();
      const [detail, stat, tags] = await Promise.all([
        probeMediaDetail(fileAbs),
        fs.stat(fileAbs),
        probeContainerTags(fileAbs),
      ]);
      const dimensions = detail?.video ?? null;
      const duration = detail?.durationSec ?? null;
      const fps = detail?.video?.fps ?? null;
      const audio = detail?.audio ?? null;

      const found = await readManifest(fileAbs);
      const manifest = found?.manifest ?? null;
      // The id konte burned into the container at render time (see tagDeliverable): which manifest
      // describes THESE bytes. A mismatch means the pair no longer belong together.
      const burnedId = tags.konte_manifest ?? null;
      const idMismatch = burnedId !== null && manifest !== null && burnedId !== manifest.id;
      // Tagging is non-fatal at render time, so an untagged file is not evidence of a swap: the
      // pairing cannot be checked either way.
      const idUnverifiable = burnedId === null && manifest !== null;
      // The job list places a deliverable it still has a record of; for anything else — an older
      // export whose job was pruned, a file copied elsewhere — the manifest's own signature is
      // what remains to compare against.
      const outOfDate =
        target.outOfDate ??
        (manifest?.exportSignature && target.currentSignature
          ? manifest.exportSignature !== target.currentSignature
          : null);

      const flag = outOfDate ? "   [out of date]" : "";
      console.log(`${fileAbs}${flag}`);
      if (target.noDelivery !== null) {
        console.log(
          `  output      ${target.noDelivery ? "working size (--no-delivery)" : "delivery"}`,
        );
      }
      console.log(`  resolution  ${dimensions ? `${dimensions.width}×${dimensions.height}` : "—"}`);
      console.log(`  duration    ${duration != null ? fmtSeconds(duration) : "—"}`);
      console.log(`  fps         ${fps != null ? Math.round(fps * 1000) / 1000 : "—"}`);
      console.log(`  picture     ${formatPicture(dimensions, manifest)}`);
      console.log(`  size        ${formatBytes(stat.size)}`);
      console.log(
        `  audio       ${
          audio
            ? [
                audio.codec ?? "?",
                audio.sampleRate != null ? `${audio.sampleRate}Hz` : null,
                audio.channelLayout ?? (audio.channels != null ? `${audio.channels}ch` : null),
              ]
                .filter(Boolean)
                .join("  ")
            : "none"
        }`,
      );
      console.log(
        `  manifest    ${found?.path ?? "(none)"}${idMismatch ? "   [does not describe this file]" : ""}`,
      );
      if (manifest) {
        console.log(`  id          ${manifest.id}`);
        console.log(`  rendered    ${manifest.renderedAt}  (konte ${manifest.konteVersion})`);
        console.log(`  delivery    ${manifest.deliveryUpscale ?? "none (working size)"}`);
        if (manifest.allowUnaccepted) {
          console.log(`  note        rough cut — rendered with --allow-unaccepted`);
        }
      }
      if (idMismatch) {
        console.log(`  note        the file was rendered under manifest ${burnedId}`);
      } else if (idUnverifiable) {
        console.log(`  note        cannot verify the pairing — the file carries no konte tag`);
      } else if (!manifest && burnedId) {
        // The manifest is unreadable, or there is none — which of the two decides what the reader
        // goes looking for.
        const why = found ? "the manifest beside it does not parse" : "no manifest beside it";
        console.log(`  id          ${burnedId}  (burned into the file; ${why})`);
      }
    });
}
