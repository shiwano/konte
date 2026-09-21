import * as path from "node:path";
import type { Command } from "commander";
import { loadSourceWaveform } from "../../../core/audio-inspect.js";
import { definitionForAddress } from "../../../core/definition-hashes.js";
import { spokenLinesAt } from "../../../core/prompt-check.js";
import { ensureFfmpeg } from "../../../core/ffmpeg.js";
import { ffprobeBin } from "../../../core/ffmpeg-binary.js";
import { type AudioStreamInfo, probeMediaDetail } from "../../../core/video-probe.js";
import { buildTimeAxis, cell, fmtSeconds, normalize, resample } from "../../audio-sparkline.js";
import { openProbeTargets } from "./resolve-arg.js";
import { probeEach } from "./shared.js";

// Enough to read the shape of a broken-up take off one line.
const MAX_LISTED_SPANS = 6;

const MAX_LINE_CHARS = 80;

function fmtAudioInfo(info: AudioStreamInfo | null): string {
  if (!info) return "—";
  const parts: string[] = [];
  if (info.codec) parts.push(info.codec);
  if (info.sampleRate) parts.push(`${info.sampleRate} Hz`);
  if (info.channels) {
    parts.push(
      info.channelLayout ? `${info.channels}ch (${info.channelLayout})` : `${info.channels}ch`,
    );
  }
  if (info.bitRate) parts.push(`${Math.round(info.bitRate / 1000)} kb/s`);
  return parts.join("  ") || "—";
}

// Two decimals, unlike the project-wide fmtSeconds: an onset is subtracted from a cue's `start` to
// place a sound on a frame, where a rounded 0.1s is already three frames off at 30fps.
function fmtOnset(sec: number): string {
  return `${sec.toFixed(2)}s`;
}

export function registerProbeAudioCommand(program: Command): void {
  program
    .command("audio <variantOrScope...>")
    .description("Show a source's waveform and audio info")
    .addHelpText(
      "after",
      `
Renders a variant's whole-file waveform (an amplitude sparkline across the terminal width) plus its
audio stream info — for inspecting a generated or file-backed source. The waveform shares the
per-variant cache that \`konte probe reel-audio\` fills (.konte/cache/audio/<variantId>.json), so it
is computed once. A variant with no audio stream prints its info and reports "no audio".

A ⚠ line flags leading/trailing silence or a wholly silent file — catching an early-ended generation
(e.g. a 20s BGM whose music stops at 16s) in self-review without eyeballing the sparkline.

The line row names the words the take owes, read from its \`spokenText\` input or from wherever its
adapter says the model takes dialogue. It sits beside the duration and the spans, so a take's length
is read against its line's: a 12-character line answered by three seconds of speech across three
stretches is a model that padded the box it was given.

The spans line appears when the sound breaks up, listing each audible stretch — a generated take
padded out past the content it had comes back as several with both its edges short, which the ⚠ line
cannot see. It reports the shape; only the words say whether a break is a pause inside one line or a
model saying that line twice.

The onset line reports where the sound sits inside the file — its first audible sample and its
loudest one — so a cue lands on a frame without reading the offset off the sparkline: an <Audio>/
<Sound> \`start\` is the target time minus the onset (minus the peak instead when it is a percussive
hit whose attack must land on the frame).

To lay out the whole assembled timeline instead (silence warnings per track), use \`konte probe
reel-audio <animatic|video>\`.

Takes a variant id (v-…), an address (resolved to its canonical variant, like konte ref), or an
address-scope. A container scope (stage, shot, timeline) sweeps every source under it (stills, which
carry no audio, are skipped), so one command replaces looping over each address; a patch chain's
steps are swept only by a patch scope (<stage>:patch…). Several of any of those can be passed at
once — they are probed in argument order, each variant once.

Examples:
  konte probe audio v-iuQeCrR2                    Waveform + info for that variant
  konte probe audio video:timeline.bgm            Resolve the address to its canonical variant, then probe
  konte probe audio video                         Every audio-bearing source in the video stage
  konte probe audio video:shot.01                 Every audio-bearing source under shot 01
  konte probe audio reference:bgm reference:rain  Just those two sources
`,
    )
    .action(async (variantOrScopes: string[]) => {
      const targets = await openProbeTargets(variantOrScopes, {
        mediaKinds: ["video", "audio"],
        definitions: true,
      });
      const { videoRoot, manager, definitions } = targets;

      await ensureFfmpeg();
      await ffprobeBin();

      await probeEach(targets, async (variantId) => {
        const wf = await loadSourceWaveform({ manager, videoRoot, variantId });
        // loadSourceWaveform keys `file` video-root-relative (its on-disk contract), but probe's
        // output is meant to be opened as-is regardless of cwd — resolve to absolute for display.
        const fileAbs = path.resolve(videoRoot, wf.file);
        const info = wf.hasAudio ? ((await probeMediaDetail(fileAbs))?.audio ?? null) : null;
        const stage = definitions ? definitionForAddress(definitions, wf.address) : null;
        const lines = stage ? spokenLinesAt(stage.prompts ?? [], wf.address) : [];

        console.log(`${wf.variantId}   ${wf.address}   [${wf.status}]`);
        console.log(`  file      ${fileAbs}`);
        const dur = wf.durationSec;
        console.log(`  duration  ${dur != null ? fmtSeconds(dur) : "—"}`);
        console.log(`  audio     ${wf.hasAudio ? fmtAudioInfo(info) : "no audio stream"}`);
        for (const line of lines) {
          const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
          console.log(`  line      \u201c${shown}\u201d (${line.length} chars)`);
        }
        if (wf.onset) {
          console.log(
            `  onset     ${fmtOnset(wf.onset.startSec)} first audible, ` +
              `${fmtOnset(wf.onset.peakSec)} peak (offsets into the file)`,
          );
        }
        // Only when the sound breaks up: one span says nothing `onset` and `duration` have not
        // already said.
        if (wf.spans.length > 1) {
          const audible = wf.spans.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
          const listed = wf.spans
            .slice(0, MAX_LISTED_SPANS)
            .map((sp) => `${fmtOnset(sp.start)}–${fmtOnset(sp.end)}`)
            .join(", ");
          const rest = wf.spans.length - MAX_LISTED_SPANS;
          console.log(
            `  spans     ${wf.spans.length} audible, ${fmtOnset(audible)} of ` +
              `${dur != null ? fmtOnset(dur) : "—"}: ${listed}${rest > 0 ? `, +${rest} more` : ""}`,
          );
        }

        if (!wf.hasAudio || dur == null || dur <= 0) return;

        const termW = process.stdout.columns ?? 100;
        const graphW = Math.max(20, termW - 2);
        const axis = buildTimeAxis(0, dur, graphW);
        const wave = normalize(resample(wf.rms, graphW))
          .map((v) => cell(v))
          .join("");
        console.log("");
        console.log("  " + axis);
        console.log("  " + wave);

        if (wf.warnings.length > 0) {
          console.log("");
          for (const w of wf.warnings) console.log(`  ⚠ ${w.message}`);
        }
      });
    });
}
