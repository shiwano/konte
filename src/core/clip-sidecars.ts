import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { type ClipPageInfo, ClipPageInfoSchema } from "./types/index.js";

// What yt-dlp leaves beside a clip `<dir>/<stem>.<ext>`: `<stem>.info.json` and one
// `<stem>.<lang>.vtt` per subtitle track, an auto-generated one in the clip's own language named
// `<lang>-orig`.

export interface SubtitleTrack {
  key: string;
  auto: boolean;
}

export interface SubtitleCue {
  startSec: number;
  text: string;
}

function clipStem(file: string): string {
  return path.join(path.dirname(file), path.basename(file, path.extname(file)));
}

export function clipInfoFile(file: string): string {
  return `${clipStem(file)}.info.json`;
}

export function clipSubtitleFile(file: string, key: string): string {
  return `${clipStem(file)}.${key}.vtt`;
}

function baseLang(key: string): string {
  return key.split("-")[0]!.toLowerCase();
}

/**
 * The track a study reads: one in the clip's `language`, a human's over an auto-generated one;
 * where the language is unknown, the one language the tracks are in. Null where none fits.
 */
export function pickSubtitleTrack(
  tracks: readonly SubtitleTrack[],
  language: string | null,
): SubtitleTrack | null {
  const fitting = language
    ? tracks.filter((t) => baseLang(t.key) === baseLang(language))
    : new Set(tracks.map((t) => baseLang(t.key))).size === 1
      ? tracks
      : [];
  return (
    [...fitting].sort((a, b) => Number(a.auto) - Number(b.auto) || a.key.localeCompare(b.key))[0] ??
    null
  );
}

/** The tracks `info` offers: every human one, and the auto-generated one in the clip's language. */
export function offeredSubtitleTracks(info: ClipPageInfo): SubtitleTrack[] {
  return [
    ...Object.keys(info.subtitles ?? {})
      .filter((key) => key !== "live_chat")
      .map((key) => ({ key, auto: false })),
    ...Object.keys(info.automatic_captions ?? {})
      .filter((key) => key.endsWith("-orig"))
      .map((key) => ({ key, auto: true })),
  ];
}

export function readClipPageInfo(file: string): ClipPageInfo | null {
  try {
    const parsed = ClipPageInfoSchema.safeParse(
      JSON.parse(readFileSync(clipInfoFile(file), "utf-8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function vttSeconds(stamp: string): number {
  const parts = stamp.split(":").map(Number);
  return parts.reduce((sec, part) => sec * 60 + part, 0);
}

function vttText(line: string): string {
  return line
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * The cues of a WebVTT file. A `rolling` track — an auto-generated one — repeats the line before at
 * the top of each cue, and that repeat is dropped.
 */
export function parseVtt(vtt: string, rolling: boolean): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let last = "";
  for (const block of vtt.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    const start = /^\s*([\d:.]+)/.exec(lines[timing]!)?.[1];
    if (!start) continue;
    const fresh: string[] = [];
    for (const line of lines.slice(timing + 1).map(vttText)) {
      if (line === "" || (rolling && line === last)) continue;
      fresh.push(line);
      last = line;
    }
    if (fresh.length > 0) cues.push({ startSec: vttSeconds(start), text: fresh.join(" ") });
  }
  return cues;
}

/** The subtitle track beside `file` a study reads, and its cues; null where none fits. */
export function readClipSubtitle(
  file: string,
  language: string | null,
): { lang: string; auto: boolean; cues: SubtitleCue[] } | null {
  const stem = path.basename(file, path.extname(file));
  let entries: string[];
  try {
    entries = readdirSync(path.dirname(file));
  } catch {
    return null;
  }
  const tracks = entries.flatMap((entry) => {
    const key = /^(.+)\.vtt$/.exec(entry.slice(stem.length + 1))?.[1];
    return entry.startsWith(`${stem}.`) && key && !key.includes(".")
      ? [{ key, auto: key.endsWith("-orig") }]
      : [];
  });
  const track = pickSubtitleTrack(tracks, language);
  if (!track) return null;
  const cues = parseVtt(readFileSync(clipSubtitleFile(file, track.key), "utf-8"), track.auto);
  return cues.length > 0 ? { lang: baseLang(track.key), auto: track.auto, cues } : null;
}
