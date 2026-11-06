import { loadNeedsReviewTargets } from "../../../core/status-report.js";
import { requireVideoRoot } from "../../context.js";
import { inferMediaType, variantMediaKind } from "../../../core/media-type.js";
import { shotById } from "../../../core/shot-index.js";
import type { StateManager } from "../../../core/state/index.js";
import type {
  AnimaticDefinition,
  StageDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";
import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { ensureFfmpeg, ensureFfprobe } from "../../../core/ffmpeg.js";
import {
  formatCompositionAddress,
  formatShotAddress,
  formatTimelineOverlayAddress,
  isCompositionAddress,
  isOverlayAddress,
  parseAddress,
  type ShotStage,
} from "../../../core/address.js";
import { shotSpans } from "../../../core/render-plan.js";
import {
  loadMotionWaveform,
  type MotionWaveform,
  renderCompositionMotionStrip,
  renderMotionStrip,
} from "../../../core/motion-inspect.js";
import { buildTimeAxis, cell, normalize, resample } from "../../audio-sparkline.js";
import { parseNumberOption } from "../../parse-option.js";
import { createMotionIntentLoader, formatMotionIntent } from "./motion-intent.js";
import { openProbeTargets, resolveProbeTargets } from "./resolve-arg.js";
import { compositionStage, openCompositionStages, requireCompositionShot } from "./shared.js";
import { formatSeconds } from "../../../core/format-duration.js";
import { printNextSteps } from "../../next-steps.js";

function parseFps(raw: string | undefined): number | "native" | undefined {
  if (raw == null) return undefined;
  if (raw.trim() === "native") return "native";
  const n = parseNumberOption("--fps", raw, { min: 0 });
  if (n === 0) {
    throw new KonteError(
      "INVALID_OPTION",
      `--fps must be 'native' or a positive number, got "${raw}"`,
    );
  }
  return n;
}

function fmtSegments(wf: MotionWaveform): string {
  const still = wf.segments.find((s) => s.type === "still");
  const active = wf.segments.find((s) => s.type === "active");
  const parts: string[] = [];
  if (active) parts.push(`high frame-diff ${active.start}s–${active.end}s`);
  if (still) parts.push(`low frame-diff ${still.start}s–${still.end}s`);
  return parts.join("   ");
}

function drawsVideo(
  stages: { video: VideoDefinition; animatic: AnimaticDefinition | null },
  manager: StateManager,
  address: string,
): boolean {
  const parsed = parseAddress(address);
  if (parsed.stage === "reference" || parsed.kind !== "shot") return false;
  const shot = shotById(compositionStage(stages, parsed.stage).shots, parsed.shotId);
  return (shot?.pictureRefs ?? shot?.compositionRefs ?? []).some((ref) => {
    const resolved = manager.resolveReference(ref, { includeStale: true });
    return resolved != null && variantMediaKind(manager, ref, resolved.variantId) === "video";
  });
}

// The shot a timeline moment falls in, and the moment on that shot's own clock.
export function overlayShotAt(stage: StageDefinition, at: number): { address: string; at: number } {
  if (!stage.overlay) {
    throw new KonteError(
      "ADDRESS_NOT_FOUND",
      `The ${stage.stage} has no overlay (${formatTimelineOverlayAddress(stage.stage)})`,
    );
  }
  const { spans, total } = shotSpans(stage.shots, stage.format.fps);
  if (at > total) {
    throw new KonteError(
      "INVALID_OPTION",
      `--at ${at} is past the end of the ${stage.stage} timeline (${formatSeconds(total, 2)})`,
    );
  }
  const i = Math.max(
    0,
    spans.findLastIndex((span) => span.start <= at),
  );
  const shot = stage.shots[i]!;
  const local = Math.min(shot.duration, Math.round((at - spans[i]!.start) * 1e6) / 1e6);
  return { address: formatCompositionAddress(stage.stage, shot.id), at: local };
}

interface MotionOptions {
  fps?: string;
  at?: string;
  window?: string;
  frames?: string;
  verbose?: boolean;
  needsReview?: boolean;
}

export function registerProbeMotionCommand(program: Command): void {
  program
    .command("motion [variantOrScope...]")
    .description("Render a tiled filmstrip of a video variant's or a shot composition's motion")
    .option(
      "--needs-review",
      "Probe only video takes, and compositions placing none, awaiting review; optionally one address-scope",
    )
    .option("--fps <fps>", "Override decode fps ('native' or a number; default min(nativeFps, 30))")
    .option(
      "--at <sec>",
      "Zoom into a window centered here instead of the whole clip (default: the motion peak; timeline seconds on an overlay)",
    )
    .option("--window <sec>", "Zoom window span in seconds; implies windowed mode (default 0.6)")
    .option("--frames <n>", "Number of tiled frames (default 16 full-clip, 12 windowed)")
    .option(
      "--verbose",
      "Print the full advisory (stats, segments, sparkline, reading note) to stderr",
    )
    .addHelpText(
      "after",
      `
Translates a video variant's unseeable time axis into a filmstrip you can Read. By default it tiles
frames sampled uniformly across the whole clip into one contact sheet (timestamps burned in). Pass --at or --window to zoom into a single moment (the motion peak by default) at
higher temporal density.

The strip path prints to stdout — Read it. By default nothing else prints, except any warnings on
stderr — the absolute, cross-clip signals ('low_motion' when nothing in frame moves anywhere,
'dispersed_motion' for flicker). The magnitude behind 'low_motion' is a displacement: the busiest
tile measured against the frame a second later, so a slow push-in or a small figure walking reads as
motion. A warning carries the shot's intent under it — the direction's action and the board's
blocking/camera.
The intent names the boundary into the shot where it breaks time or place: its 'join', and a
'location' line when its setup stands somewhere else than the shot before. A 'returns' line names
the shot it cuts back to across a cutaway, and the seconds since it left that setup.
Pass --verbose for the full advisory on stderr: the magnitude,
mean/peak, high/low frame-diff segments, duration/fps, the intent, the reading note, and the motion-energy
sparkline (the frame-to-frame diff waveform). Only the magnitude compares across clips; mean and peak
rank within one clip. Segments describe whole-frame changes between consecutive decoded frames;
low frame-diff can include small subject movements. Judge the intended motion from the filmstrip.
An image variant reports "not a
video".

Takes a variant id (v-…), an address (the take it resolves to, then every ready take awaiting a
verdict beside it), or an address-scope. A container scope (stage, shot, timeline) sweeps every
video source under it (stills are skipped) and prints one strip path per clip; a patch chain's steps are swept only by a patch scope
(<stage>:patch…). Several of any of those can be passed at once — they are probed in argument order,
each variant once. In sweep mode each strip is preceded by a "# <address>" header line; the
single-target form still prints only the strip path. A sweep spanning several shots ends with a Next
steps line: those shots side by side on one sheet is probe contact-sheet.

A composition address (<stage>:shot.<id>#composition) draws that shot as its live definition
renders it, clips included — the read for an <Animate> move's speed, easing and continuity. A scope never sweeps one in. A composition has no decoded profile: no
warnings, no motion peak (a window needs --at), and --fps is rejected.

The overlay address (<stage>:timeline#overlay) takes --at in timeline seconds: it draws the
composition of the shot under that moment, overlay laid over it, windowed at the same moment on the
shot's clock (stderr names the shot and its time). The window stops at the shot's cut. It is probed
on its own.

--needs-review selects the outstanding video takes probe contact-sheet --needs-review tiles,
including undecided alternatives beside an accepted take, and each composition awaiting review whose
picture places no video take — a shot whose motion lives only in its composition. It takes at most
one address-scope.

Examples:
  konte probe motion --needs-review video                     Every video take, and composition moving without one, awaiting review
  konte probe motion v-iuQeCrR2                                 Full-clip filmstrip path to stdout (warnings only on stderr)
  konte probe motion video:shot.01.motion                       The take the address resolves to, and any undecided beside it
  konte probe motion video                                      Every motion clip in the video stage, one strip each
  konte probe motion video:shot.01                              Every video source under shot 01
  konte probe motion video:shot.01.motion video:shot.04.motion  Just those two clips
  konte probe motion v-iuQeCrR2 --at 0.35                       Zoom into the moment at 0.35s
  konte probe motion v-iuQeCrR2 --window 0.8                    Zoom into the motion peak, ±0.4s
  konte probe motion v-iuQeCrR2 --verbose                       Full advisory (stats, segments, sparkline) to stderr
  konte probe motion v-iuQeCrR2 --fps native                    Re-sample at native fps to catch high-frequency jitter
  konte probe motion video:shot.33#composition --at 3.6 --window 2 --frames 16
                                                                An <Animate> move, frame by frame
  konte probe motion video:timeline#overlay --at 265            The overlay over the shot at 4:25`,
    )
    .action(async (targets: string[], opts: MotionOptions) => {
      let reviewManager;
      if (opts.needsReview) {
        if (targets.length > 1) {
          throw new KonteError("INVALID_OPTION", "--needs-review takes at most one address-scope");
        }
        const review = await loadNeedsReviewTargets(requireVideoRoot(), targets[0]);
        reviewManager = review.manager;
        targets = review.items.flatMap((item) => {
          if (!item.variantId) {
            if (!isCompositionAddress(item.address)) return [];
            return drawsVideo(review.definitions, review.manager, item.address)
              ? []
              : [item.address];
          }
          const file = review.manager.tryGetAssetState(item.address)?.variants?.[item.variantId]
            ?.file;
          return file && inferMediaType(file) === "video" ? [item.variantId] : [];
        });
        if (targets.length === 0) {
          console.log("No video takes or compositions awaiting review under this scope.");
          return;
        }
      } else if (targets.length === 0) {
        throw new KonteError(
          "INVALID_OPTION",
          "Pass a variant id, address or address-scope, or --needs-review",
        );
      }
      const drawn = (t: string) => isCompositionAddress(t) || isOverlayAddress(t);
      const compositions = targets.filter(drawn);
      if (compositions.length > 0 && opts.fps != null) {
        throw new KonteError("INVALID_OPTION", "--fps sets a clip's decode rate");
      }
      if (targets.some(isOverlayAddress)) {
        if (opts.at == null) {
          throw new KonteError(
            "INVALID_OPTION",
            "An overlay is drawn over the shot under --at <timeline sec>; pass --at",
          );
        }
        if (targets.length > 1) {
          throw new KonteError(
            "INVALID_OPTION",
            "--at reads timeline seconds on an overlay and shot seconds elsewhere; probe the overlay on its own",
          );
        }
      }
      // Before the targets open, so their state holds the synced `file` takes.
      const stages =
        compositions.length > 0 ? (await openCompositionStages(requireVideoRoot())).stages : null;
      const opened = await openProbeTargets(
        targets.filter((t) => !drawn(t)),
        { mediaKinds: ["video"], definitions: compositions.length > 0 },
      );
      const { videoRoot } = opened;
      const manager = reviewManager ?? opened.manager;
      const multi = opts.needsReview || opened.multi || targets.length > 1;

      const plan: ({ composition: string; at?: number } | { variantId: string })[] = [];
      const seen = new Set<string>();
      for (const target of targets) {
        if (isOverlayAddress(target)) {
          const parsed = parseAddress(target);
          if (parsed.stage === "reference") continue;
          const timelineAt = parseNumberOption("--at", opts.at, { min: 0 })!;
          const shot = overlayShotAt(compositionStage(stages!, parsed.stage), timelineAt);
          console.error(
            `${target} @${formatSeconds(timelineAt, 2)} is ${shot.address} @${formatSeconds(shot.at, 2)}`,
          );
          plan.push({ composition: shot.address, at: shot.at });
          continue;
        }
        const ids = isCompositionAddress(target)
          ? [target]
          : resolveProbeTargets(manager, [target], { mediaKinds: ["video"] }).variantIds;
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          plan.push(isCompositionAddress(id) ? { composition: id } : { variantId: id });
        }
      }

      await ensureFfmpeg();
      await ensureFfprobe();

      const motionIntent = createMotionIntentLoader(videoRoot, manager);

      const sweptShots = new Map<ShotStage, Set<string>>();
      const noteShot = (address: string): void => {
        const parsed = parseAddress(address);
        if (parsed.stage === "reference" || parsed.kind !== "shot") return;
        const shots = sweptShots.get(parsed.stage) ?? new Set<string>();
        shots.add(parsed.shotId);
        sweptShots.set(parsed.stage, shots);
      };

      const probeComposition = async (address: string, atOverride?: number): Promise<void> => {
        const parsed = parseAddress(address);
        if (parsed.stage === "reference" || parsed.kind !== "shot") return;
        const video = compositionStage(stages!, parsed.stage);
        requireCompositionShot(video, parsed.shotId);
        const shot = video.shots.find((s) => s.id === parsed.shotId)!;
        const at = atOverride ?? parseNumberOption("--at", opts.at, { min: 0, max: shot.duration });
        const window = parseNumberOption("--window", opts.window, { min: 0.001 });
        const frames = parseNumberOption("--frames", opts.frames, { integer: true, min: 2 });
        const windowed = at != null || window != null;
        const strip = await renderCompositionMotionStrip({
          videoRoot,
          video,
          manager,
          shotId: parsed.shotId,
          spec: { at, window, frames, full: !windowed },
        });
        if (multi) console.log(`# ${address}`);
        console.log(strip.path);
        noteShot(address);
        if (opts.verbose) {
          console.error(
            `${address}   [live composition]   ${windowed ? "windowed" : "full-shot"} ${
              strip.window.start
            }s–${strip.window.end}s, ${strip.timestamps.length} frames`,
          );
          const intent = await motionIntent(address);
          for (const line of intent ? formatMotionIntent(intent) : []) console.error(line);
          console.error("  note      drawn from the definition, so no motion profile or warnings");
        }
      };

      const probeVariant = async (variantId: string): Promise<void> => {
        const wf = await loadMotionWaveform({
          manager,
          videoRoot,
          variantId,
          fps: parseFps(opts.fps),
        });
        const fileAbs = path.resolve(videoRoot, wf.file);

        if (!wf.isVideo) {
          console.log(`${wf.variantId}   ${wf.address}   [${wf.status}]`);
          console.log(`  file      ${fileAbs}`);
          console.log("  motion    not a video (nothing to measure)");
          return;
        }

        const at = parseNumberOption("--at", opts.at, {
          min: 0,
          max: wf.durationSec ?? undefined,
        });
        const window = parseNumberOption("--window", opts.window, { min: 0.001 });
        const frames = parseNumberOption("--frames", opts.frames, { integer: true, min: 2 });
        // --at/--window ask to zoom into one moment; with neither, tile the whole clip (the reliable
        // "did it move" read). renderMotionStrip centers a windowed strip on the motion peak.
        const windowed = at != null || window != null;
        const strip = await renderMotionStrip({
          videoRoot,
          waveform: wf,
          spec: { at, window, frames, full: !windowed },
        });

        // The filmstrip is the judgment: its path is the only thing on stdout, so it pipes cleanly
        // and an agent Reads exactly one line. By default nothing else prints except any warnings on
        // stderr — those are the absolute, cross-clip signals ('low_motion'/'dispersed_motion') that
        // shouldn't need a flag to surface. --verbose restores the full advisory (mean/peak, segments,
        // sparkline), whose numbers only rank within one clip and mislead on localized motion, for a
        // human tuning timing. A sweep prefixes each strip with a "# <address>" header so the several
        // paths stay attributable; the single-target form keeps the bare-path contract.
        if (multi) console.log(`# ${wf.address}   ${wf.variantId}`);
        console.log(strip.path);
        noteShot(wf.address);

        const dur = wf.durationSec;
        // A `low_motion` reading is a failure only where movement was asked for. Fetched for a warning
        // or the full advisory, so a clean sweep never pays for the definition load.
        const intent =
          opts.verbose || wf.warnings.some((w) => w.type === "low_motion")
            ? await motionIntent(wf.address)
            : null;
        const intentLines = intent ? formatMotionIntent(intent) : [];
        if (opts.verbose) {
          console.error(
            `${wf.variantId}   ${wf.address}   [${wf.status}]   ${
              windowed ? "windowed" : "full-clip"
            }, ${strip.timestamps.length} frames   (advisory — judge from the filmstrip)`,
          );
          console.error(`  file      ${fileAbs}`);
          console.error(
            `  duration  ${dur != null ? formatSeconds(dur) : "—"}  decode fps ${wf.fps}  samples ${
              wf.samples
            }`,
          );
          const segText = fmtSegments(wf);
          console.error(
            `  magnitude ${wf.magnitude.value.toFixed(4)} @ ${wf.magnitude.time}s  (busiest tile over ${
              wf.displacementWindowSec
            }s)`,
          );
          console.error(
            `  motion    mean ${wf.mean.toFixed(3)}  peak ${wf.peak.value.toFixed(3)} @ ${
              wf.peak.time
            }s${segText ? `   ${segText}` : ""}`,
          );
          for (const w of wf.warnings) console.error(`  ⚠ ${w.message}`);
          for (const line of intentLines) console.error(line);
          console.error(
            "  note      mean/peak rank within one clip only; magnitude is the cross-clip number",
          );
          console.error(
            "            segments measure whole-frame changes between consecutive frames; low frame-diff can include small subject movements",
          );
          if (wf.samples > 0 && dur != null && dur > 0) {
            const termW = process.stderr.columns ?? 100;
            const graphW = Math.max(20, termW - 2);
            const wave = normalize(resample(wf.coherent, graphW))
              .map((v) => cell(v))
              .join("");
            console.error("");
            console.error("  " + buildTimeAxis(0, dur, graphW));
            console.error("  " + wave);
          }
        } else {
          for (const w of wf.warnings) console.error(`⚠ ${w.message}`);
          for (const line of intentLines) console.error(line);
        }
      };

      for (const [i, item] of plan.entries()) {
        if (multi && i > 0) console.log("");
        if ("composition" in item) await probeComposition(item.composition, item.at);
        else await probeVariant(item.variantId);
      }

      // One strip per clip shows each move; comparing the clips against each other is a sheet's job.
      const shotCount = [...sweptShots.values()].reduce((n, shots) => n + shots.size, 0);
      if (shotCount > 1) {
        const scopes = [...sweptShots].map(([stage, shots]) =>
          shots.size === 1 ? formatShotAddress(stage, [...shots][0]!) : stage,
        );
        printNextSteps([
          {
            command: `konte probe contact-sheet ${scopes.join(" ")} --frames-per-shot 6`,
            detail: "Compare the shots side by side on one sheet",
          },
        ]);
      }
    });
}
