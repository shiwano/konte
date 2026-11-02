// A clip source is read as an original to adapt: every shot shown, in windows of about three minutes
// (`w1`, `w2` …) whose locators are the file's clock.
//
// The cuts and the heard words are read once per file and kept in the workspace cache by its sha256
// (`.konte/studies/clip-<sha>/source-reading.json`), outside `chunks/`, which a recount clears. The
// structure is counted off that reading where it is there — windows snapped to the nearest cut — and
// off the length alone where it is not, so the locator check never decodes the picture. `konte source
// import clip` reads the cuts first, and recounts a structure counted without them.

import { existsSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { shortHash } from "./content-hash.js";
import { PAGE_INFO_FILE, readClipPageInfo, readClipSubtitle } from "./clip-sidecars.js";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import {
  type ContactSheetCell,
  drawContactSheet,
  planContactSheetLayout,
} from "./contact-sheet.js";
import { KonteError } from "./errors.js";
import { formatClipClock } from "./source-locator.js";
import {
  INDEX_JSON,
  type SourceRef,
  type SourceStudyKind,
  type StudyOptions,
  readStudyIndex,
  sourceChunksDir,
} from "./source-study.js";
import {
  type HeardLine,
  SCENE_THRESHOLD,
  SHEET_CELLS,
  clipSha256,
  clipStudyDir,
  formatClock,
  hearVoice,
  makeProxy,
  probeClip,
  shotsBetween,
} from "./study-clip.js";
import { detectSceneChanges, extractFrameAt, lastSeekableTime } from "./frame-extract.js";
import { probeHasAudio, type VideoProbeResult } from "./video-probe.js";

const READING_VERSION = 1;
const READING_FILE = "source-reading.json";

export const WINDOW_SEC = 180;
// A window boundary moves to a cut at most this far from where three minutes put it.
const SNAP_SEC = 60;
// A shot longer than this shows a frame every `LONG_SHOT_STEP_SEC` instead of one.
const LONG_SHOT_SEC = 10;
const LONG_SHOT_STEP_SEC = 5;
const MIN_SHOT_SEC = 0.25;

export const UNSNAPPED_NOTE =
  "windows cut every 3:00 off the length alone — konte source import clip snaps them to the cuts";

type Shot = { startSec: number; endSec: number };

type ClipReading = {
  version: number;
  durationSec: number;
  shots: Shot[];
  heard: {
    lang: string;
    from: "subtitles" | "auto-subtitles" | "voice";
    lines: HeardLine[];
  } | null;
};

// `<workspace>/videos/<name>/source`.
function workspaceRootOf(src: SourceRef): string {
  return path.resolve(src.dir, "../../..");
}

function originalOf(src: SourceRef): string {
  return path.join(src.dir, src.file);
}

async function readingDir(src: SourceRef): Promise<string> {
  return clipStudyDir(workspaceRootOf(src), await clipSha256(originalOf(src)));
}

async function cachedReading(src: SourceRef): Promise<ClipReading | null> {
  try {
    const reading = JSON.parse(
      readFileSync(path.join(await readingDir(src), READING_FILE), "utf-8"),
    ) as ClipReading;
    return reading.version === READING_VERSION ? reading : null;
  } catch {
    return null;
  }
}

/** The clip's cuts and heard words, read off the file where the cache does not hold them. */
async function ensureClipReading(
  src: SourceRef,
  progress: (line: string) => void,
): Promise<ClipReading> {
  const cached = await cachedReading(src);
  if (cached) return cached;
  const file = originalOf(src);
  const probe = await probeClip(file, { uncapped: true });
  const dir = await readingDir(src);
  await fs.mkdir(dir, { recursive: true });
  const workDir = await fs.mkdtemp(`${dir}-`);
  try {
    progress("scaling the picture down");
    const proxy = path.join(workDir, "proxy.mp4");
    await makeProxy(file, proxy);
    progress("finding the cuts");
    const cuts = await detectSceneChanges(proxy, SCENE_THRESHOLD, MIN_SHOT_SEC);
    const shots = shotsBetween(cuts, probe.videoDuration);

    const info = readClipPageInfo(path.join(dir, PAGE_INFO_FILE));
    const subtitle = readClipSubtitle(dir, info?.language ?? null);
    let heard: ClipReading["heard"] = subtitle && {
      lang: subtitle.lang,
      from: subtitle.auto ? "auto-subtitles" : "subtitles",
      lines: subtitle.cues.map((c) => ({ startSec: c.startSec, text: c.text })),
    };
    if (!heard && (await probeHasAudio(file))) {
      progress("listening for a voice");
      const voice = await hearVoice(file, probe.duration, path.join(workDir, "voice"));
      if (voice) heard = { ...voice, from: "voice" };
    }
    const reading: ClipReading = {
      version: READING_VERSION,
      durationSec: probe.duration,
      shots,
      heard,
    };
    await writeFileAtomic(path.join(dir, READING_FILE), `${JSON.stringify(reading)}\n`);
    return reading;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The windows `durationSec` splits into: about `WINDOW_SEC` each, every boundary moved to the cut
 * nearest it within `SNAP_SEC` where `cuts` are known, and a last window shorter than half of one
 * folded into the one before.
 */
export function clipWindows(durationSec: number, cuts: readonly number[] | null): Shot[] {
  const bounds = [0];
  while (bounds.at(-1)! + WINDOW_SEC < durationSec - WINDOW_SEC / 2) {
    const last = bounds.at(-1)!;
    const nominal = last + WINDOW_SEC;
    let snapped: number | null = null;
    for (const cut of cuts ?? []) {
      if (cut <= last + WINDOW_SEC / 2 || cut >= durationSec - WINDOW_SEC / 2) continue;
      const off = Math.abs(cut - nominal);
      if (off <= SNAP_SEC && (snapped === null || off < Math.abs(snapped - nominal))) snapped = cut;
    }
    bounds.push(snapped ?? nominal);
  }
  bounds.push(durationSec);
  return bounds.slice(1).map((endSec, i) => ({ startSec: bounds[i]!, endSec }));
}

/** The moments a window's sheets show: one per shot, one every 5 s of a shot past 10 s. */
export function windowFrameTimes(shots: readonly Shot[], from: number, to: number): number[] {
  const times: number[] = [];
  for (const shot of shots) {
    const start = Math.max(shot.startSec, from);
    const end = Math.min(shot.endSec, to);
    if (end <= start) continue;
    if (end - start <= LONG_SHOT_SEC) {
      times.push((start + end) / 2);
      continue;
    }
    for (let t = start + LONG_SHOT_STEP_SEC / 2; t < end; t += LONG_SHOT_STEP_SEC) times.push(t);
  }
  return times;
}

// `h:mm:ss`, or `m:ss` under an hour.
function formatLength(sec: number): string {
  const whole = Math.floor(sec);
  if (whole < 3600) return formatClock(whole);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function shotsIn(shots: readonly Shot[], from: number, to: number): number {
  return shots.filter((s) => Math.min(s.endSec, to) > Math.max(s.startSec, from)).length;
}

function sheetName(stem: string, n: number): string {
  return `${stem}-${n}.jpg`;
}

// A frame is named after the original it was taken from, so a replaced file never serves an old one.
async function frameAt(src: SourceRef, probe: VideoProbeResult, sec: number): Promise<string> {
  const st = statSync(originalOf(src));
  const of = shortHash(`${st.size}:${st.mtimeMs}`);
  const out = path.join(sourceChunksDir(src), `frame-${of}-${Math.round(sec * 1000)}.png`);
  if (!existsSync(out)) {
    await extractFrameAt(
      originalOf(src),
      Math.min(sec, lastSeekableTime(probe.videoDuration, probe.fps)),
      out,
    );
  }
  return out;
}

/** The frame of a source clip at `sec`, at the file's own size, kept in its `chunks/`. */
export async function sourceClipFrameAt(
  src: SourceRef,
  sec: number,
): Promise<{ path: string; probe: VideoProbeResult }> {
  const probe = await probeClip(originalOf(src), { uncapped: true });
  if (sec < 0 || sec >= probe.videoDuration) {
    throw new KonteError(
      "INVALID_OPTION",
      `--at ${formatClipClock(sec)} is outside ${src.file}, which runs ${formatLength(probe.videoDuration)}`,
    );
  }
  return { path: await frameAt(src, probe, sec), probe };
}

/**
 * Reads the clip's cuts and heard words where the cache lacks them, and drops an `index.json` whose
 * windows were counted off the length alone, so the study that follows snaps them to the cuts.
 */
export async function prepareClipSource(
  src: SourceRef,
  progress: (line: string) => void,
): Promise<void> {
  await ensureClipReading(src, progress);
  const known = readStudyIndex(src);
  if (known?.kind === "clip" && known.notes.includes(UNSNAPPED_NOTE)) {
    await fs.rm(path.join(sourceChunksDir(src), INDEX_JSON), { force: true });
  }
}

export const CLIP_STUDY: SourceStudyKind = {
  excerptReadsChunk: false,
  kind: "clip",
  version: 1,

  async structure(src: SourceRef, _opts: StudyOptions) {
    const reading = await cachedReading(src);
    const durationSec =
      reading?.durationSec ?? (await probeClip(originalOf(src), { uncapped: true })).duration;
    const cuts = reading ? reading.shots.slice(1).map((s) => s.startSec) : null;
    const windows = clipWindows(durationSec, cuts);
    const chunks = windows.map((w, i) => {
      const id = `w${i + 1}`;
      const length = formatClock(w.endSec - w.startSec);
      return {
        id,
        title: `${formatClipClock(w.startSec)}-${formatClipClock(w.endSec)}`,
        unit: id,
        from: w.startSec,
        to: w.endSec,
        size: reading
          ? `${length} · ${shotsIn(reading.shots, w.startSec, w.endSec)} shots`
          : length,
      };
    });
    const summary = [
      formatLength(durationSec),
      `${windows.length} window${windows.length === 1 ? "" : "s"}`,
      ...(reading ? [`${reading.shots.length.toLocaleString("en-US")} shots`] : []),
      ...(reading?.heard ? [`heard ${reading.heard.lang}`] : []),
    ].join(" · ");
    return {
      summary,
      notes: reading ? [] : [UNSNAPPED_NOTE],
      names: [],
      units: chunks.map((c) => ({ id: c.id, title: c.title })),
      chunks,
    };
  },

  async writeChunk(src, index, chunk, stem) {
    const entry = index.chunks.find((c) => c.id === chunk)!;
    const reading = await ensureClipReading(src, () => {});
    const probe = await probeClip(originalOf(src), { uncapped: true });
    const studyDir = sourceChunksDir(src);
    await fs.mkdir(studyDir, { recursive: true });
    const lastFrame = lastSeekableTime(probe.videoDuration, probe.fps);
    const times = windowFrameTimes(reading.shots, entry.from, entry.to);
    const aspect = probe.width / probe.height;
    const workDir = await fs.mkdtemp(path.join(studyDir, `.${stem}-`));
    const sheets: string[] = [];
    try {
      const cells: ContactSheetCell[] = await mapConcurrent(
        times,
        FFMPEG_CONCURRENCY,
        async (t, i) => {
          const file = path.join(workDir, `f-${String(i).padStart(5, "0")}.jpg`);
          await extractFrameAt(originalOf(src), Math.min(t, lastFrame), file);
          return { label: formatClipClock(t), file, aspect };
        },
      );
      const maxCells = Math.min(SHEET_CELLS, Math.max(cells.length, 1));
      for (let at = 0; at < cells.length; at += SHEET_CELLS) {
        const page = cells.slice(at, at + SHEET_CELLS);
        const layout = planContactSheetLayout(maxCells, page.length, { aspect });
        const { bytes } = await drawContactSheet(page, layout);
        const name = sheetName(stem, sheets.length + 1);
        await fs.writeFile(path.join(studyDir, name), bytes);
        sheets.push(`${name}  ${page[0]!.label}-${page.at(-1)!.label}  ${page.length} frame(s)`);
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
    const heard = (reading.heard?.lines ?? []).filter(
      (l) => l.startSec >= entry.from && l.startSec < entry.to,
    );
    const lines = [
      `# ${chunk}  ${entry.title ?? ""}`,
      "",
      reading.heard ? `Heard (${reading.heard.lang}, ${reading.heard.from}):` : "Heard: nothing",
      ...heard.map((l) => `${formatClipClock(l.startSec)} ${l.text}`),
      "",
      "Sheets (one frame per shot, one every 5 s of a shot past 10 s, each labelled with its clock):",
      ...sheets.map((s) => `- ${s}`),
    ];
    // Last: its presence is what says the chunk is whole.
    await writeFileAtomic(path.join(studyDir, `${stem}.md`), `${lines.join("\n")}\n`);
  },

  // The sheets are listed inside the md, which is written after them.
  chunkFiles(_index, _chunk, stem) {
    return [`${stem}.md`];
  },

  async excerpt(src, _index, _chunk, _stem, at) {
    const probe = await probeClip(originalOf(src), { uncapped: true });
    const moments = at.to > at.from ? [at.from, at.to] : [at.from];
    return { images: await Promise.all(moments.map((sec) => frameAt(src, probe, sec))) };
  },
};
