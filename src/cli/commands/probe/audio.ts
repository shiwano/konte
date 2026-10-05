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
import { loadDirectionIfPresent } from "../../load-definition.js";
import { songAnalysisOf } from "../../../core/song-reading.js";
import { recognizesSpeechIn } from "../../../core/sherpa-binary.js";
import { readHeardSpeech } from "../../../core/speech-hearing.js";
import { formatSongTempo, songAddressOf, songBeatSec, songTempo } from "../../../core/song-take.js";
import { barAt, songBars } from "../../../core/song-report.js";
import type { SongAnalysis } from "../../../core/types/index.js";
import { type LyricPlacementEntry, placeDirectionLyrics } from "../../../core/dsl/direction.js";
import { probeEach } from "./shared.js";

// Enough to read the shape of a broken-up take off one line.
const MAX_LISTED_SPANS = 6;

const MAX_LINE_CHARS = 80;

function quoteLine(text: string): string {
  const shown = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
  return `\u201c${shown}\u201d (${text.length} chars)`;
}

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

The heard row under it is the speech recognized in the take when it landed, in \`policy.lang\`: a
line said twice, cut short, misread or followed by words nobody wrote shows there as text. It is a
machine hearing — a near-homophone or a kanji/kana difference is not a wrong take.

The spans line appears when the sound breaks up, listing each audible stretch — a generated take
padded out past the content it had comes back as several with both its edges short, which the ⚠ line
cannot see. It reports the shape; the heard row says whether a break is a pause inside one line or a
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
      const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
      const songAddress = songAddressOf(direction);

      const lang = direction?.policy.lang;
      const heardRow = (address: string, variantId: string): string => {
        if (lang && !recognizesSpeechIn(lang))
          return `unknown — speech in ${lang} is not recognized`;
        const variant = manager.getState().assets[address]?.variants?.[variantId];
        const words = readHeardSpeech(videoRoot, address, variantId, variant?.outputHash)
          ?.map((t) => t.text)
          .join("")
          .trim();
        if (words === undefined) return "unknown — the take was not recognized when it landed";
        return words ? quoteLine(words) : "nothing";
      };

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
          console.log(`  line      ${quoteLine(line)}`);
        }
        if (lines.length > 0 && wf.address !== songAddress) {
          console.log(`  heard     ${heardRow(wf.address, variantId)}`);
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

        const song = songAnalysisOf(
          manager.videoRoot,
          wf.address,
          variantId,
          manager.getState().assets[wf.address]?.variants?.[variantId]?.song,
        );
        if (direction && wf.address === songAddress && dur != null) {
          printSong(song ?? null, dur, wf.rms, wf.rate);
          if (song && direction.lyrics) {
            printLyrics(
              placeDirectionLyrics(direction, { address: wf.address, variantId, analysis: song }),
            );
          }
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

// What konte read off a take of the song: its clock, each bar's level on its beats, the section
// boundary candidates and where it is sung.
function printSong(
  song: SongAnalysis | null,
  durationSec: number,
  rms: readonly number[],
  rate: number,
): void {
  if (!song) {
    console.log("  song      not read yet — `konte song analyze` reads it");
    return;
  }
  printSongReading(song);
  console.log("  bars");
  for (const bar of songBars(song, durationSec, rms, rate)) {
    const level = bar.levelDb === null ? "  —  " : `${bar.levelDb.toFixed(0).padStart(4)} dB`;
    console.log(
      `    ${String(bar.index).padStart(3)}  ${fmtOnset(bar.startSec).padStart(7)}  ${level}`,
    );
  }
}

// The reading's clock — its tempo, meter and beat 0 — its section candidates, where it is sung and
// what it is heard to sing.
export function printSongReading(song: SongAnalysis): void {
  const corrected = song.firstBeatSet !== undefined ? " (set by hand)" : "";
  console.log(
    `  song      ${formatSongTempo(songTempo(song))}, ${song.beatsPerBar}/bar, beat 0 at ` +
      `${fmtOnset(songBeatSec(song, 0))}${corrected}`,
  );
  const sections = song.sectionSecs
    .map((sec) => ({ sec, bar: barAt(song, sec) }))
    .sort((a, b) => a.sec - b.sec)
    .map(({ sec, bar }) => `bar ${bar} (${fmtOnset(sec)})`);
  console.log(`  sections  ${sections.length > 0 ? sections.join(", ") : "none stands out"}`);
  if (song.phrases === null) {
    console.log("  sung      unknown — the vocal track could not be separated");
  } else {
    const listed = song.phrases
      .map((p) => `${fmtOnset(p.startSec)}–${fmtOnset(p.endSec)}`)
      .join(", ");
    console.log(`  sung      ${song.phrases.length} stretch(es): ${listed || "none"}`);
  }
  if (song.heard === null) {
    console.log("  heard     unknown — the vocal track could not be recognized");
  } else {
    const words = song.heard
      .map((t) => t.text)
      .join("")
      .trim();
    console.log(`  heard     ${words ? `"${words}"` : "nothing"}`);
  }
}

// Where each lyric line falls in this take, on its own clock — what the song's review page lays
// over the audio — keyed as `konte song set --line` takes it.
export function printLyrics(lines: readonly LyricPlacementEntry[]): void {
  console.log("  lines");
  const singerWidth = Math.max(0, ...lines.map((l) => l.singer.join("+").length));
  for (const line of lines) {
    const span =
      line.start === null
        ? "unplaced"
        : `${fmtOnset(line.start)}–${fmtOnset(line.end)}${line.set ? " (set)" : ""}`;
    console.log(
      `    ${line.key.padEnd(5)} ${span.padEnd(20)} ${line.singer.join("+").padEnd(singerWidth)} ${line.text}`,
    );
  }
}
