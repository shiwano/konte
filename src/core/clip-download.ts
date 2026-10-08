import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  clipInfoFile,
  clipSubtitleFile,
  offeredSubtitleTracks,
  pickSubtitleTrack,
  readClipPageInfo,
} from "./clip-sidecars.js";
import { KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import { MAX_CLIP_SEC, formatClock, probeClip } from "./study-clip.js";

export function isClipUrl(arg: string): boolean {
  return /^https?:\/\//i.test(arg);
}

const VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
};

/**
 * Downloads the clip at `url` into `dir` and returns its path; a clip already there is not
 * downloaded again. With yt-dlp on PATH any page it reads is a clip, one past `MAX_CLIP_SEC` is
 * refused before any download, and the page's info and the subtitle track a study reads are saved
 * beside it; without it only a URL answering with a video file is.
 */
export async function downloadClip(url: string, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const ytDlp = Bun.which("yt-dlp");
  if (ytDlp) return downloadWithYtDlp(ytDlp, url, dir);
  const file = await fetchVideoFile(url, dir);
  if (!file) {
    throw new KonteError(
      "CLIP_DOWNLOAD_FAILED",
      `${url} is a page, not a video file; download the clip and pass its file`,
    );
  }
  try {
    await probeClip(file);
  } catch (err) {
    await fs.rm(file, { force: true });
    throw err;
  }
  return file;
}

const YT_DLP_OUTPUT = "%(extractor_key)s-%(id)s.%(ext)s";

async function downloadWithYtDlp(ytDlp: string, url: string, dir: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ytDlp, [
      "--no-playlist",
      "--no-progress",
      "--restrict-filenames",
      "--match-filter",
      `duration <=? ${MAX_CLIP_SEC}`,
      "-S",
      "res:1080",
      "--ffmpeg-location",
      await ffmpegBin(),
      "-P",
      dir,
      "-o",
      YT_DLP_OUTPUT,
      "--write-info-json",
      "--print",
      "after_move:filepath",
      url,
    ]));
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    const reason =
      stderr
        .split("\n")
        .filter((l) => l.startsWith("ERROR: "))
        .at(-1)
        ?.slice("ERROR: ".length) ?? errorMessage(err);
    throw new KonteError("CLIP_DOWNLOAD_FAILED", `yt-dlp could not download ${url}: ${reason}`);
  }
  const file = stdout.trim().split("\n").at(-1);
  if (!file) {
    throw new KonteError(
      "CLIP_TOO_LONG",
      `${url} runs past the ${formatClock(MAX_CLIP_SEC)} a study reads`,
    );
  }
  await downloadSubtitle(ytDlp, file);
  return file;
}

// The track missing beside `file` stays missing: the study hears the voice instead.
async function downloadSubtitle(ytDlp: string, file: string): Promise<void> {
  const info = readClipPageInfo(file);
  if (!info) return;
  const track = pickSubtitleTrack(offeredSubtitleTracks(info), info.language ?? null);
  if (!track || existsSync(clipSubtitleFile(file, track.key))) return;
  await execFileAsync(ytDlp, [
    "--load-info-json",
    clipInfoFile(file),
    "--skip-download",
    track.auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    track.key,
    "--sub-format",
    "vtt/best",
    "--convert-subs",
    "vtt",
    "--ffmpeg-location",
    await ffmpegBin(),
    "-P",
    path.dirname(file),
    "-o",
    YT_DLP_OUTPUT,
  ]).catch(() => {});
}

/**
 * Saves the video file `url` answers with into `dir`, named after the URL's last path segment and a
 * hash of the URL, and returns its path; null where it answers with anything but a video.
 */
export async function fetchVideoFile(url: string, dir: string): Promise<string | null> {
  const segment = path.posix.basename(new URL(url).pathname);
  const ext = path.extname(segment).replace(/[^A-Za-z0-9.]/g, "");
  const stem = path.basename(segment, path.extname(segment)).replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `${stem || "clip"}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
  const kept = (await fs.readdir(dir)).find(
    (entry) => entry.startsWith(`${name}.`) && !entry.endsWith(".part"),
  );
  if (kept) return path.join(dir, kept);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new KonteError("CLIP_DOWNLOAD_FAILED", `Could not download ${url}: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new KonteError("CLIP_DOWNLOAD_FAILED", `Could not download ${url}: HTTP ${res.status}`);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type.startsWith("video/")) {
    await res.body?.cancel();
    return null;
  }
  const file = path.join(
    dir,
    `${name}${ext.length > 1 ? ext : (VIDEO_EXTENSIONS[type] ?? ".video")}`,
  );
  const partial = `${file}.part`;
  try {
    await Bun.write(partial, res);
    await fs.rename(partial, file);
  } catch (err) {
    await fs.rm(partial, { force: true });
    throw new KonteError("CLIP_DOWNLOAD_FAILED", `Could not download ${url}: ${errorMessage(err)}`);
  }
  return file;
}
