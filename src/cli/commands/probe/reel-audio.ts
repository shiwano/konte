import type { Command } from "commander";
import { parseReelScope } from "../../../core/address.js";
import { findAnimaticOverflows, formatAnimaticOverflow } from "../../../core/animatic-overflow.js";
import {
  type AudioInspectModel,
  type AudioTrack,
  inspectTimelineAudio,
} from "../../../core/audio-inspect.js";
import { KonteError } from "../../../core/errors.js";
import { StateManager } from "../../../core/state/index.js";
import { buildTimeAxis, cell, resample } from "../../audio-sparkline.js";
import { requireVideoRoot } from "../../context.js";
import { loadVideoAndAnimatic } from "../../load-definition.js";
import { withAbsoluteFiles } from "./shared.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

function trackTag(t: AudioTrack): string {
  if (t.kind === "soundtrack") return t.soundtrackId ?? "bed";
  if (t.kind === "embedded") return `${t.shotId} embed`;
  return `${t.shotId} ${t.cueId ?? "sound"}`;
}

function renderModel(model: AudioInspectModel, labelW: number, graphW: number): string[] {
  const lines: string[] = [];
  const { start: vStart, end: vEnd } = model.view;
  const span = Math.max(0.001, vEnd - vStart);
  const colOf = (t: number): number => Math.round(((t - vStart) / span) * graphW);

  const pad = (s: string): string => (s.length > labelW ? s.slice(0, labelW) : s.padEnd(labelW));

  lines.push(" ".repeat(labelW) + " " + buildTimeAxis(vStart, vEnd, graphW));

  for (const track of model.tracks) {
    const span01 = Math.max(1e-6, track.end - track.start);
    const visStart = Math.max(track.start, vStart);
    const visEnd = Math.min(track.end, vEnd);
    let s = Math.max(0, Math.min(graphW, colOf(visStart)));
    let e = Math.max(0, Math.min(graphW, colOf(visEnd)));
    if (e <= s) e = Math.min(graphW, s + 1);
    const width = e - s;
    // Draw only the slice of the track's envelope that falls inside the view window.
    const f0 = (visStart - track.start) / span01;
    const f1 = (visEnd - track.start) / span01;
    const env = resample(track.envelope, width, f0, f1);
    const row = new Array<string>(graphW).fill(" ");
    for (let i = 0; i < width; i++) row[s + i] = cell(env[i]!);
    lines.push(pad(trackTag(track)) + " " + row.join(""));
  }
  return lines;
}

function formatLevelling(level: AudioTrack["levelling"]): string {
  if (level.reason) {
    const reasons = {
      unmeasured: "source unmeasured",
      "no-lufs": "source LUFS unavailable",
      stem: "already mixed stem",
      "no-lines": "no spoken lines",
      unclassified: "unclassified source",
    };
    return `auto off: ${reasons[level.reason]}`;
  }
  const db = 20 * Math.log10(level.gain);
  return `auto ${db >= 0 ? "+" : ""}${db.toFixed(1)} dB${level.limited ? " (limit)" : ""}`;
}

function formatTrackTable(model: AudioInspectModel): string[] {
  const lines: string[] = [
    "",
    "Tracks:",
    "  LUFS estimates use whole-source loudness + effective gain.",
    "  They exclude trimming, fades, and final mixing; ducked levels are listed separately.",
  ];
  const tagW = Math.max(...model.tracks.map((t) => trackTag(t).length), 4);
  for (const t of model.tracks) {
    const span = `${t.start.toFixed(1)}–${t.end.toFixed(1)}s`;
    const flags: string[] = [
      t.lufs != null ? `est ${t.lufs.toFixed(1)} LUFS` : "LUFS unknown",
      `gain ${t.volume.toFixed(2)}`,
      formatLevelling(t.levelling),
    ];
    if (t.duckedLufs != null) flags.push(`ducks to est ${t.duckedLufs.toFixed(1)} LUFS`);
    if (t.loop) flags.push("loop");
    if (t.fadeIn) flags.push(`fadeIn ${t.fadeIn}s`);
    if (t.fadeOut) flags.push(`fadeOut ${t.fadeOut}s`);
    if (t.mediaStart) flags.push(`mediaStart ${t.mediaStart}s`);
    lines.push(
      `  ${trackTag(t).padEnd(tagW)}  ${t.kind.padEnd(10)}  ${span.padStart(13)}  ${flags.join("  ")}  ${t.file}`,
    );
  }
  return lines;
}

function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.log("");
  console.log("Warnings:");
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}

export function registerProbeReelAudioCommand(program: Command): void {
  program
    .command("reel-audio <address-scope>")
    .description("Inspect the audio timeline of a reel or one of its shots")
    .addHelpText(
      "after",
      `
Reconstructs the audio of a reel and shows, per track, where each sound plays and how loud — an
ASCII timeline with an amplitude sparkline inside each active region, for tuning timing. Tracks come
from the same three sources the final mux uses: shot \`<Audio>\` one-shots, \`<Video hasAudio>\`
embedded audio, and timeline \`soundtrack()\` beds.

Track LUFS is estimated from whole-source loudness plus effective gain, before trimming, fades,
and final mixing. Each track reports its effective gain multiplier and automatic correction or
skip reason; ducked LUFS is a separate estimate.

  animatic | video           The whole timeline of that stage
  <stage>:shot.<id>          Narrow the view to one shot's window

Offsets are NOMINAL (accumulated from each shot's declared duration), so this works before any shot
is rendered and may differ from the final mux by a few ms of encoder drift. Diagnostics flag missing
sources, silent embedded audio, looped/overflowing beds,
and — per track, over the region actually played — the same leading/trailing/whole-file silence
\`konte probe audio\` reports, so one run checks every source. They also flag a shot whose animatic
narration runs past its duration, which the stem's clamp cuts without a sound. Asset and timeline scopes
are rejected. Source-window boundaries with fades and overlapping effective gain sums are informational;
output discontinuities, clipping and limiter reduction are not measured.

Examples:
  konte probe reel-audio video               Inspect the delivered audio timeline
  konte probe reel-audio animatic            Inspect the board's lines against their shots
  konte probe reel-audio video:shot.02       Inspect shot 02's audio window
`,
    )
    .action(async (addressScope: string) => {
      const { stage, shotId } = parseReelScope(addressScope);

      const videoRoot = requireVideoRoot();
      const loaded = await loadVideoAndAnimatic(videoRoot);
      const video = stage === "animatic" ? loaded.animatic : loaded.video;

      if (shotId && !video.shots.some((s) => s.id === shotId)) {
        throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" not found`);
      }

      const manager = await StateManager.load(videoRoot);
      await applyResolutionDefinitions({ videoRoot, state: manager.getState() });
      const inspected = await inspectTimelineAudio({ video, manager, videoRoot, shotId });
      // The animatic's cues are not tracks here — they never reach the mux, and this view is the mux
      // — but the clamp that cuts them is a timing fault this page is read for.
      const overflows = loaded.animatic
        ? findAnimaticOverflows(loaded.animatic, manager).filter(
            (o) => !shotId || o.shotId === shotId,
          )
        : [];
      const model: AudioInspectModel = {
        ...inspected,
        tracks: withAbsoluteFiles(videoRoot, inspected.tracks),
      };

      const overflowWarnings = overflows.map(
        (o) => `${o.shotId} animatic: ${formatAnimaticOverflow(o)}`,
      );

      const scopeLabel = shotId ? `${stage}:shot.${shotId}` : stage;
      console.log(
        `${scopeLabel}   total ${model.totalDuration.toFixed(1)}s   ${model.tracks.length} track${model.tracks.length === 1 ? "" : "s"}   (nominal)`,
      );
      console.log("");

      // A shot whose only audio is its animatic has no track here, so the warnings outlive the
      // empty timeline rather than returning with it.
      if (model.tracks.length === 0) {
        console.log("No audio tracks in scope.");
        printWarnings(overflowWarnings);
        return;
      }

      const tagW = Math.min(16, Math.max(...model.tracks.map((t) => trackTag(t).length), 4));
      const termW = process.stdout.columns ?? 100;
      const graphW = Math.max(20, termW - tagW - 2);
      for (const line of renderModel(model, tagW, graphW)) console.log(line);
      for (const line of formatTrackTable(model)) console.log(line);

      const notes = [
        ...model.tracks.flatMap((t) => t.notes.map((note) => `${trackTag(t)}: ${note}`)),
        ...model.notes,
      ];
      if (notes.length > 0) {
        console.log("\nNotes:");
        for (const note of notes) console.log(`  ${note}`);
      }

      const trackWarnings = model.tracks.flatMap((t) =>
        t.warnings.map((w) => `${trackTag(t)}: ${w}`),
      );
      printWarnings([...trackWarnings, ...overflowWarnings]);
    });
}
