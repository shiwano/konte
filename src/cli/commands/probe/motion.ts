import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { ensureFfmpeg } from "../../../core/ffmpeg.js";
import { isCompositionAddress, parseAddress } from "../../../core/address.js";
import {
  loadMotionWaveform,
  type MotionWaveform,
  renderCompositionMotionStrip,
  renderMotionStrip,
} from "../../../core/motion-inspect.js";
import { ffprobeBin } from "../../../core/ffmpeg-binary.js";
import { buildTimeAxis, cell, fmtSeconds, normalize, resample } from "../../audio-sparkline.js";
import { parseNumberOption } from "../../parse-option.js";
import { loadVideoAndAnimatic } from "../../load-definition.js";
import { createMotionIntentLoader, formatMotionIntent } from "./motion-intent.js";
import { openProbeTargets, resolveProbeTargets } from "./resolve-arg.js";
import { compositionStage, requireCompositionShot } from "./shared.js";

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

interface MotionOptions {
  fps?: string;
  at?: string;
  window?: string;
  frames?: string;
  verbose?: boolean;
}

export function registerProbeMotionCommand(program: Command): void {
  program
    .command("motion <variantOrScope...>")
    .description("Render a tiled filmstrip of a video variant's or a shot composition's motion")
    .option("--fps <fps>", "Override decode fps ('native' or a number; default min(nativeFps, 30))")
    .option(
      "--at <sec>",
      "Zoom into a window centered here instead of the whole clip (default: the motion peak; required on a composition)",
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
frames sampled uniformly across the whole clip into one contact sheet (timestamps burned in) — the
spatial reading (did it move, trajectory, appear/disappear, sustained breakage) that is the reliable
motion judgment. Pass --at or --window to zoom into a single moment (the motion peak by default) at
higher temporal density.

The strip path prints to stdout — Read it. By default nothing else prints, except any warnings on
stderr — the absolute, cross-clip signals ('low_motion' when nothing in frame moves anywhere,
'dispersed_motion' for flicker). The magnitude behind 'low_motion' is a displacement: the busiest
tile measured against the frame a second later, so a slow push-in or a small figure walking reads as
motion. A warning carries the shot's intent under it — the direction's action and the board's
blocking/camera — since a shot meant to hold still measures the same as one that failed to animate.
Pass --verbose for the full advisory on stderr: the magnitude,
mean/peak, high/low frame-diff segments, duration/fps, the intent, the reading note, and the motion-energy
sparkline (the frame-to-frame diff waveform). Only the magnitude compares across clips; mean and peak
rank within one clip. Segments describe whole-frame changes between consecutive decoded frames;
low frame-diff can include small subject movements. Judge the intended motion from the filmstrip.
The profile is cached per variant (.konte/cache/motion/<variantId>/). An image variant reports "not a
video".

Takes a variant id (v-…), an address (resolved to its canonical variant, like konte ref), or an
address-scope. A container scope (stage, shot, timeline) sweeps every video source under it (stills
are skipped) and prints one strip path per clip, so one command replaces looping over each shot's
motion; a patch chain's steps are swept only by a patch scope (<stage>:patch…). Several of any of
those can be passed at once — they are probed in argument order, each variant once. In sweep mode
each strip is preceded by a "# <address>" header line; the single-target form still prints only the
strip path.

A composition address (<stage>:shot.<id>#composition) draws that shot as its live definition
renders it, clips included — the read for an <Animate> move's speed, easing and continuity, which a
contact sheet samples too sparsely to show. A scope never sweeps one in. Its frames are cached by the
composition's content, beside probe reel-thumbnails'. A composition has no decoded profile: no
warnings, no motion peak (a window needs --at), and --fps is rejected.

Examples:
  konte probe motion v-iuQeCrR2                                 Full-clip filmstrip path to stdout (warnings only on stderr)
  konte probe motion video:shot.01.motion                       Resolve the address to its canonical variant, then probe
  konte probe motion video                                      Every motion clip in the video stage, one strip each
  konte probe motion video:shot.01                              Every video source under shot 01
  konte probe motion video:shot.01.motion video:shot.04.motion  Just those two clips
  konte probe motion v-iuQeCrR2 --at 0.35                       Zoom into the moment at 0.35s
  konte probe motion v-iuQeCrR2 --window 0.8                    Zoom into the motion peak, ±0.4s
  konte probe motion v-iuQeCrR2 --verbose                       Full advisory (stats, segments, sparkline) to stderr
  konte probe motion v-iuQeCrR2 --fps native                    Re-sample at native fps to catch high-frequency jitter
  konte probe motion video:shot.33#composition --at 3.6 --window 2 --frames 16
                                                                An <Animate> move, frame by frame`,
    )
    .action(async (targets: string[], opts: MotionOptions) => {
      const compositions = targets.filter(isCompositionAddress);
      if (compositions.length > 0 && opts.fps != null) {
        throw new KonteError(
          "INVALID_OPTION",
          "--fps sets a clip's decode rate; a composition is drawn frame by frame, not decoded",
        );
      }
      const opened = await openProbeTargets(
        targets.filter((t) => !isCompositionAddress(t)),
        { mediaKinds: ["video"], definitions: compositions.length > 0 },
      );
      const { videoRoot, manager } = opened;
      const multi = opened.multi || targets.length > 1;
      const stages = compositions.length > 0 ? await loadVideoAndAnimatic(videoRoot) : null;

      const plan: ({ composition: string } | { variantId: string })[] = [];
      const seen = new Set<string>();
      for (const target of targets) {
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
      await ffprobeBin();

      const motionIntent = createMotionIntentLoader(videoRoot, manager);

      const probeComposition = async (address: string): Promise<void> => {
        const parsed = parseAddress(address);
        if (parsed.stage === "reference" || parsed.kind !== "shot") return;
        const video = compositionStage(stages!, parsed.stage);
        requireCompositionShot(video, parsed.shotId);
        const shot = video.shots.find((s) => s.id === parsed.shotId)!;
        const at = parseNumberOption("--at", opts.at, { min: 0, max: shot.duration });
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
        if (opts.verbose) {
          console.error(
            `${address}   [live composition]   ${windowed ? "windowed" : "full-shot"} ${
              strip.window.start
            }s–${strip.window.end}s, ${strip.timestamps.length} frames`,
          );
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
            `  duration  ${dur != null ? fmtSeconds(dur) : "—"}  decode fps ${wf.fps}  samples ${
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
        if ("composition" in item) await probeComposition(item.composition);
        else await probeVariant(item.variantId);
      }
    });
}
