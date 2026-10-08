import * as path from "node:path";
import type { Command } from "commander";
import { ratioOf } from "../../core/aspect.js";
import { downloadClip, isClipUrl } from "../../core/clip-download.js";
import { ensureFfmpeg } from "../../core/ffmpeg.js";
import { ffprobeBin } from "../../core/ffmpeg-binary.js";
import { formatSongTempo } from "../../core/song-grid.js";
import {
  DESCRIPTION_FILE,
  HEARD_FILE,
  MAX_SHOWN_SHOTS,
  clipFrameAt,
  formatClock,
  studyClip,
} from "../../core/study-clip.js";
import { parseTimecode } from "../../core/timecode.js";
import type { ClipStudy } from "../../core/types/index.js";
import { requireWorkspaceRoot } from "../context.js";
import { declareScope } from "../scope.js";

function fmtFps(fps: number): string {
  return `${Number.isInteger(fps) ? fps : fps.toFixed(2)}fps`;
}

function fmtSec(sec: number): string {
  return `${sec.toFixed(1)}s`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function printStudy(file: string, url: string | null, dir: string, study: ClipStudy): void {
  const lengths = study.shots.map((s) => s.endSec - s.startSec);
  console.log(file);
  if (url) console.log(`  from: ${url}`);
  if (study.page) {
    const { title, uploader } = study.page;
    console.log(`  page: "${title}"${uploader ? ` by ${uploader}` : ""}`);
  }
  console.log(
    `  ${formatClock(study.durationSec)} · ${study.width}×${study.height} ` +
      `(${ratioOf(study)}) · ${fmtFps(study.fps)}`,
  );
  console.log(
    `  cuts: ${study.shots.length} shot(s), median ${fmtSec(median(lengths))} ` +
      `(${fmtSec(Math.min(...lengths))}–${fmtSec(Math.max(...lengths))})`,
  );
  if (study.page && study.page.chapters.length > 0) {
    console.log("  chapters:");
    for (const c of study.page.chapters) console.log(`    ${formatClock(c.startSec)}  ${c.title}`);
  }
  if (study.tempo) console.log(`  music: ${formatSongTempo(study.tempo)}`);
  if (study.heard) {
    const { lang, from } = study.heard;
    const off = {
      subtitles: ", off its subtitles",
      "auto-subtitles": ", off its auto-generated subtitles",
      voice: "",
    }[from];
    console.log(`  heard: ${lang}${off} → ${path.join(dir, HEARD_FILE)}`);
  }
  if (study.page?.described) console.log(`  description: ${path.join(dir, DESCRIPTION_FILE)}`);
  const shown = study.sheets.reduce((sum, s) => sum + s.shots, 0);
  console.log(
    shown < study.shots.length
      ? `  sheets: ${shown} of ${study.shots.length.toLocaleString("en-US")} shots shown`
      : "  sheets:",
  );
  for (const sheet of study.sheets) {
    console.log(
      `    ${path.join(dir, sheet.file)}  ${formatClock(sheet.fromSec)}–${formatClock(sheet.toSec)}  ` +
        `${sheet.shots} shot(s)`,
    );
  }
}

export function registerStudyCommand(program: Command): void {
  const study = program.command("study").description("Read what a human brought in as a reference");

  declareScope(
    study
      .command("clip <file|url>")
      .description("Read a reference video's cuts, look, music and voice")
      .option("--at <time>", "Show the frame at this moment at the file's own size")
      .addHelpText(
        "after",
        `
Reads a video a human brought as "make it like this" — input to the direction, never material for
the piece. Prints its length, size and frame rate; its cuts (shot count, median and range of shot
length); the tempo of its music; the language its voice is heard in, the words written to heard.txt;
and contact sheets of one frame per shot, each labelled with the shot's start and length. Past
${MAX_SHOWN_SHOTS} shots the sheets show an even spread and say how many. The music and heard rows
are left out where the clip has none.

For a clip yt-dlp downloaded, its page's title, uploader, chapters and description are read, and
the words off its subtitles in place of hearing the voice.

A URL is downloaded once, into the clip's study under .konte/studies/; that file is the clip from
then on. Any page yt-dlp reads is a clip where it is on PATH; without it, only a direct link
to a video file is.

A clip runs at most 30 minutes. The study is kept under the workspace's .konte/studies/ by the
file's content, so a moved or renamed file reads back the same study; deleting it is safe — the
same command makes it again.

--at reads no study: it writes the one frame at that moment, at the file's own size.

Examples:
  konte study clip studies/ref.mp4              Study the clip, or print the study already made
  konte study clip studies/ref.mp4 --at 1:32    The frame at 1:32 at full size
  konte study clip https://youtu.be/<id>        Download the clip, then study it
`,
      )
      .action(async (arg: string, opts: { at?: string }) => {
        const workspaceRoot = requireWorkspaceRoot();
        await ensureFfmpeg();
        await ffprobeBin();
        const url = isClipUrl(arg) ? arg : null;
        const progress = (line: string) => console.error(`konte: ${line}…`);
        const abs = url ? await downloadClip(url, workspaceRoot, progress) : path.resolve(arg);
        const file = url ? path.relative(process.cwd(), abs) : arg;

        if (opts.at !== undefined) {
          const sec = parseTimecode(opts.at);
          const frame = await clipFrameAt({ workspaceRoot, file: abs, sec });
          console.log(`${file} at ${formatClock(sec)}`);
          console.log(`  ${frame.path}  ${frame.probe.width}×${frame.probe.height}`);
          return;
        }

        const { dir, study: result } = await studyClip({
          workspaceRoot,
          file: abs,
          progress,
        });
        printStudy(file, url, dir, result);
        console.log("");
        console.log("Next steps:");
        console.log(`  konte study clip ${file} --at <m:ss>   See one moment's frame at full size`);
        if (url) {
          console.log(
            `  Copy it to the video's studies/ and name it in brief.references: ` +
              `{ clip: "studies/${path.basename(abs)}", link: "${url}", take, avoid }`,
          );
        }
      }),
    { scope: "workspace" },
  );
}
