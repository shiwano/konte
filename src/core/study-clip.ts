import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { detectBeats } from "./beat-this.js";
import { readClipPageInfo, readClipSubtitle } from "./clip-sidecars.js";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import {
  type ContactSheetCell,
  drawContactSheet,
  planContactSheetLayout,
} from "./contact-sheet.js";
import { KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import { separateSong } from "./sherpa-binary.js";
import { type SongTempo, songTempo } from "./song-grid.js";
import { hearWindows, joinHeardWindows } from "./speech-hearing.js";
import {
  type VideoProbeResult,
  detectSceneChanges,
  extractFrameAt,
  lastSeekableTime,
  probeVideo,
} from "./thumbnail.js";
import { type ClipStudy, ClipStudySchema } from "./types/index.js";
import { probeHasAudio } from "./video-probe.js";

// Bumped whenever what a study reads, or how, changes: a study of another version is read again.
const STUDY_VERSION = 2;

export const MAX_CLIP_SEC = 30 * 60;

// The picture is read off a copy whose short side is this long.
const PROXY_SHORT_SIDE = 360;

const SCENE_THRESHOLD = 0.3;
const MIN_SHOT_SEC = 0.25;

export const SHEET_CELLS = 30;
export const MAX_SHOWN_SHOTS = 90;

// Music is heard where Beat This! finds at least this many beats, spaced as a pulse, over at least
// this share of the clip.
const MIN_MUSIC_BEATS = 16;
const MAX_BEAT_GAP_SEC = 1.5;
const MIN_MUSIC_SHARE = 0.3;

// Fewer tokens than this off the separated voice is noise the separation let through, not a voice.
const MIN_HEARD_TOKENS = 3;
// A pause this long between two heard tokens starts a new line in `heard.txt`.
const HEARD_LINE_GAP_SEC = 1.5;

const STUDY_FILE = "study.json";
export const HEARD_FILE = "heard.txt";
export const DESCRIPTION_FILE = "description.txt";

export function studiesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".konte", "studies");
}

export function clipStudyDir(workspaceRoot: string, sha256: string): string {
  return path.join(studiesDir(workspaceRoot), `clip-${sha256}`);
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// One hash per file per process, keyed by its size and mtime: a preview asks on every state load.
const hashes = new Map<string, { key: string; sha256: string }>();

export async function clipSha256(file: string): Promise<string> {
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const known = hashes.get(file);
  if (known?.key === key) return known.sha256;
  const sha256 = await sha256OfFile(file);
  hashes.set(file, { key, sha256 });
  return sha256;
}

export function readClipStudy(dir: string): ClipStudy | null {
  try {
    const parsed = ClipStudySchema.safeParse(
      JSON.parse(readFileSync(path.join(dir, STUDY_FILE), "utf-8")),
    );
    return parsed.success && parsed.data.version === STUDY_VERSION ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The cached study of `file`, or null where it has not been studied by this version. */
export async function cachedClipStudy(
  workspaceRoot: string,
  file: string,
): Promise<{ dir: string; study: ClipStudy } | null> {
  if (!existsSync(file)) return null;
  const dir = clipStudyDir(workspaceRoot, await clipSha256(file));
  const study = readClipStudy(dir);
  return study ? { dir, study } : null;
}

export async function probeClip(file: string): Promise<VideoProbeResult> {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new KonteError("CLIP_UNREADABLE", `No such file: ${file}`);
  }
  let probe: VideoProbeResult;
  try {
    probe = await probeVideo(file);
  } catch (err) {
    throw new KonteError("CLIP_UNREADABLE", `${file} is not a video: ${errorMessage(err)}`);
  }
  if (probe.width <= 0 || probe.height <= 0 || probe.videoDuration <= 0) {
    throw new KonteError("CLIP_UNREADABLE", `${file} holds no picture`);
  }
  if (probe.duration > MAX_CLIP_SEC) {
    throw new KonteError(
      "CLIP_TOO_LONG",
      `${file} runs ${formatClock(probe.duration)}, past the ${formatClock(MAX_CLIP_SEC)} a study reads`,
    );
  }
  return probe;
}

// `m:ss`, the clock a clip is read on.
export function formatClock(sec: number): string {
  const whole = Math.floor(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The shots between the cuts at `cuts`, dropping a cut closer than `MIN_SHOT_SEC` to either end. */
export function shotsBetween(
  cuts: readonly number[],
  durationSec: number,
): { startSec: number; endSec: number }[] {
  const bounds = [0];
  for (const cut of cuts) {
    if (cut - bounds.at(-1)! >= MIN_SHOT_SEC && durationSec - cut >= MIN_SHOT_SEC) bounds.push(cut);
  }
  bounds.push(durationSec);
  return bounds.slice(1).map((endSec, i) => ({ startSec: bounds[i]!, endSec }));
}

/** The indices of `count` items spread evenly over `total`, first and last included. */
export function evenPicks(total: number, count: number): number[] {
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  if (count <= 1) return [0];
  const step = (total - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(step * i));
}

/** The tempo of the music Beat This! hears, or null where its beats do not hold a pulse. */
export function musicTempo(beats: readonly number[], durationSec: number): SongTempo | null {
  if (beats.length < MIN_MUSIC_BEATS || durationSec <= 0) return null;
  let pulse = 0;
  for (let i = 1; i < beats.length; i++) {
    const gap = beats[i]! - beats[i - 1]!;
    if (gap <= MAX_BEAT_GAP_SEC) pulse += gap;
  }
  if (pulse < durationSec * MIN_MUSIC_SHARE) return null;
  return songTempo({ beats, firstBeat: 0, beatsPerBar: 4 });
}

/** The heard tokens as lines, each opened by the clock it starts at, broken at each pause. */
export function heardLines(tokens: readonly { text: string; startSec: number }[]): string[] {
  const lines: { startSec: number; text: string }[] = [];
  let last = -Infinity;
  for (const token of tokens) {
    if (token.startSec - last > HEARD_LINE_GAP_SEC || lines.length === 0) {
      lines.push({ startSec: token.startSec, text: "" });
    }
    lines.at(-1)!.text += token.text;
    last = token.startSec;
  }
  return lines
    .map((l) => ({ ...l, text: l.text.trim() }))
    .filter((l) => l.text !== "")
    .map((l) => `[${formatClock(l.startSec)}] ${l.text}`);
}

function sheetCellLabel(shot: { startSec: number; endSec: number }): string {
  return `${formatClock(shot.startSec)}  ${(shot.endSec - shot.startSec).toFixed(1)}s`;
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(await ffmpegBin(), ["-v", "error", "-y", ...args]);
}

async function makeProxy(file: string, out: string): Promise<void> {
  const s = PROXY_SHORT_SIDE;
  await ffmpeg([
    "-i",
    file,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `scale='if(gt(iw,ih),-2,trunc(min(${s},iw)/2)*2)':'if(gt(iw,ih),trunc(min(${s},ih)/2)*2,-2)'`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "26",
    out,
  ]);
}

async function renderSheets(opts: {
  proxy: string;
  probe: VideoProbeResult;
  shots: readonly { startSec: number; endSec: number }[];
  workDir: string;
  outDir: string;
}): Promise<ClipStudy["sheets"]> {
  const { proxy, probe, shots, workDir, outDir } = opts;
  const shown = evenPicks(shots.length, MAX_SHOWN_SHOTS).map((i) => shots[i]!);
  const lastFrame = lastSeekableTime(probe.videoDuration, probe.fps);
  const aspect = probe.width / probe.height;
  const cells: ContactSheetCell[] = await mapConcurrent(
    shown,
    FFMPEG_CONCURRENCY,
    async (shot, i) => {
      const file = path.join(workDir, `shot-${String(i).padStart(4, "0")}.jpg`);
      await extractFrameAt(proxy, Math.min((shot.startSec + shot.endSec) / 2, lastFrame), file);
      return { label: sheetCellLabel(shot), file, aspect };
    },
  );
  const maxCells = Math.min(SHEET_CELLS, cells.length);
  const sheets: ClipStudy["sheets"] = [];
  for (let at = 0; at < cells.length; at += SHEET_CELLS) {
    const page = cells.slice(at, at + SHEET_CELLS);
    const pageShots = shown.slice(at, at + SHEET_CELLS);
    const layout = planContactSheetLayout(maxCells, page.length, { aspect });
    const { bytes } = await drawContactSheet(page, layout);
    const name = `sheet-${sheets.length + 1}.jpg`;
    await fs.writeFile(path.join(outDir, name), bytes);
    sheets.push({
      file: name,
      fromSec: pageShots[0]!.startSec,
      toSec: pageShots.at(-1)!.endSec,
      shots: page.length,
    });
  }
  return sheets;
}

// The words the clip's separated voice is heard to say, and the language most of them are in.
async function hearVoice(
  file: string,
  durationSec: number,
  workDir: string,
): Promise<{ lang: string; lines: string[] } | null> {
  await fs.mkdir(workDir, { recursive: true });
  const stereo = path.join(workDir, "mix.wav");
  await ffmpeg([
    "-i",
    file,
    "-map",
    "0:a:0",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s16le",
    stereo,
  ]);
  const vocals = path.join(workDir, "vocals.wav");
  await separateSong(stereo, {
    vocalsWav: vocals,
    instrumentalWav: path.join(workDir, "instrumental.wav"),
  });
  const { starts, heard } = await hearWindows(vocals, durationSec, null, workDir);
  const tokens = joinHeardWindows(starts.map((startSec, i) => ({ startSec, heard: heard[i]! })));
  if (tokens.length < MIN_HEARD_TOKENS) return null;
  const byLang = new Map<string, number>();
  for (const w of heard) {
    if (w.lang && w.tokens.length > 0)
      byLang.set(w.lang, (byLang.get(w.lang) ?? 0) + w.tokens.length);
  }
  const lang = [...byLang].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!lang) return null;
  return { lang, lines: heardLines(tokens) };
}

/**
 * Study `file`: its cuts, a contact sheet of one frame per shot, the tempo of its music and the
 * words of its voice, kept under the workspace by the file's sha256. A study this version already
 * made is read back.
 */
export async function studyClip(opts: {
  workspaceRoot: string;
  file: string;
  progress: (line: string) => void;
}): Promise<{ dir: string; study: ClipStudy; reused: boolean }> {
  const { workspaceRoot, file, progress } = opts;
  const probe = await probeClip(file);
  const dir = clipStudyDir(workspaceRoot, await clipSha256(file));
  const cached = readClipStudy(dir);
  if (cached) return { dir, study: cached, reused: true };

  await fs.mkdir(studiesDir(workspaceRoot), { recursive: true });
  const workDir = await fs.mkdtemp(`${dir}-`);
  try {
    const outDir = path.join(workDir, "out");
    await fs.mkdir(outDir);

    progress("scaling the picture down");
    const proxy = path.join(workDir, "proxy.mp4");
    await makeProxy(file, proxy);

    progress("finding the cuts");
    const cuts = await detectSceneChanges(proxy, SCENE_THRESHOLD, MIN_SHOT_SEC);
    const shots = shotsBetween(cuts, probe.videoDuration);

    progress(`drawing ${Math.min(shots.length, MAX_SHOWN_SHOTS)} shot(s) onto sheets`);
    const sheets = await renderSheets({ proxy, probe, shots, workDir, outDir });

    const info = readClipPageInfo(file);
    const subtitle = readClipSubtitle(file, info?.language ?? null);
    let heard: (NonNullable<ClipStudy["heard"]> & { lines: string[] }) | null = subtitle && {
      lang: subtitle.lang,
      from: subtitle.auto ? "auto-subtitles" : "subtitles",
      lines: subtitle.cues.map((c) => `[${formatClock(c.startSec)}] ${c.text}`),
    };
    let tempo: SongTempo | null = null;
    if (await probeHasAudio(file)) {
      progress("listening for a beat");
      const { beats, durationSec } = await detectBeats(file);
      tempo = musicTempo(beats, durationSec);
      if (!heard) {
        progress("listening for a voice");
        const voice = await hearVoice(file, probe.duration, path.join(workDir, "voice"));
        if (voice) heard = { ...voice, from: "voice" };
      }
    }
    if (heard) await fs.writeFile(path.join(outDir, HEARD_FILE), `${heard.lines.join("\n")}\n`);
    const description = info?.description?.trim();
    if (description) await fs.writeFile(path.join(outDir, DESCRIPTION_FILE), `${description}\n`);

    const study: ClipStudy = {
      version: STUDY_VERSION,
      durationSec: probe.duration,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      shots,
      tempo,
      page: info?.title
        ? {
            title: info.title,
            uploader: info.uploader ?? info.channel ?? null,
            chapters: (info.chapters ?? []).map((c) => ({
              startSec: c.start_time,
              title: c.title,
            })),
            described: Boolean(description),
          }
        : null,
      heard: heard && { lang: heard.lang, from: heard.from },
      sheets,
    };
    // A study of an older version goes whole; a frame `--at` left beside it stays.
    await fs.mkdir(dir, { recursive: true });
    for (const stale of [STUDY_FILE, HEARD_FILE, DESCRIPTION_FILE])
      await fs.rm(path.join(dir, stale), { force: true });
    for (const entry of await fs.readdir(dir)) {
      if (/^sheet-\d+\.jpg$/.test(entry)) await fs.rm(path.join(dir, entry), { force: true });
    }
    for (const entry of await fs.readdir(outDir)) {
      await fs.rename(path.join(outDir, entry), path.join(dir, entry));
    }
    // Last: its presence is what says the study is whole.
    await writeFileAtomic(path.join(dir, STUDY_FILE), `${JSON.stringify(study, null, 2)}\n`);
    return { dir, study, reused: false };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** The frame of `file` at `sec`, at the file's own size, kept in its study directory. */
export async function clipFrameAt(opts: {
  workspaceRoot: string;
  file: string;
  sec: number;
}): Promise<{ path: string; probe: VideoProbeResult }> {
  const { workspaceRoot, file, sec } = opts;
  const probe = await probeClip(file);
  if (sec < 0 || sec >= probe.videoDuration) {
    throw new KonteError(
      "INVALID_OPTION",
      `--at ${formatClock(sec)} is outside ${file}, which runs ${formatClock(probe.videoDuration)}`,
    );
  }
  const dir = clipStudyDir(workspaceRoot, await clipSha256(file));
  const out = path.join(dir, `frame-${Math.round(sec * 1000)}.png`);
  if (!existsSync(out)) {
    await extractFrameAt(
      file,
      Math.min(sec, lastSeekableTime(probe.videoDuration, probe.fps)),
      out,
    );
  }
  return { path: out, probe };
}
