import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  PAGE_INFO_FILE,
  offeredSubtitleTracks,
  pickSubtitleTrack,
  readClipPageInfo,
  subtitleFileName,
} from "./clip-sidecars.js";
import { KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import {
  MAX_CLIP_SEC,
  clipSha256,
  clipStudyDir,
  formatClock,
  probeClip,
  studiesDir,
} from "./study-clip.js";
import { ClipSourceSchema } from "./types/index.js";

export function isClipUrl(arg: string): boolean {
  return /^https?:\/\//i.test(arg);
}

const SOURCE_FILE = "source.json";

const VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
};

/**
 * Downloads the clip at `url` into its study directory and returns its path; a URL downloaded
 * before is not downloaded again. With yt-dlp on PATH any page it reads is a clip, one past
 * `MAX_CLIP_SEC` is refused before any download, and the page's info and the subtitle track a study
 * reads are kept with it; without it only a URL answering with a video file is.
 */
export async function downloadClip(
  url: string,
  workspaceRoot: string,
  progress: (line: string) => void,
): Promise<string> {
  const known = downloadedClip(workspaceRoot, url);
  if (known) return known;
  progress(`downloading ${url}`);
  await fs.mkdir(studiesDir(workspaceRoot), { recursive: true });
  const workDir = await fs.mkdtemp(path.join(studiesDir(workspaceRoot), "download-"));
  try {
    const ytDlp = Bun.which("yt-dlp");
    const file = ytDlp
      ? await downloadWithYtDlp(ytDlp, url, workDir)
      : await fetchClip(url, workDir);
    return await keepDownload(workspaceRoot, url, file);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** The clip downloaded from `url` before, or null. */
export function downloadedClip(workspaceRoot: string, url: string): string | null {
  const root = studiesDir(workspaceRoot);
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    if (!entry.startsWith("clip-")) continue;
    const dir = path.join(root, entry);
    try {
      const source = ClipSourceSchema.parse(
        JSON.parse(readFileSync(path.join(dir, SOURCE_FILE), "utf-8")),
      );
      const file = path.join(dir, source.file);
      if (source.link === url && existsSync(file)) return file;
    } catch {}
  }
  return null;
}

/**
 * Moves the clip `file` yt-dlp or a fetch saved, and what was saved beside it, into the study
 * directory of its content, and records `url` as where it came from.
 */
export async function keepDownload(
  workspaceRoot: string,
  url: string,
  file: string,
): Promise<string> {
  const dir = clipStudyDir(workspaceRoot, await clipSha256(file));
  await fs.mkdir(dir, { recursive: true });
  const name = path.basename(file);
  const stem = path.basename(file, path.extname(file));
  for (const entry of await fs.readdir(path.dirname(file))) {
    const key = entry.startsWith(`${stem}.`)
      ? /^([^.]+)\.vtt$/.exec(entry.slice(stem.length + 1))?.[1]
      : undefined;
    const kept =
      entry === name
        ? name
        : entry === `${stem}.info.json`
          ? PAGE_INFO_FILE
          : key
            ? subtitleFileName(key)
            : null;
    if (kept) await fs.rename(path.join(path.dirname(file), entry), path.join(dir, kept));
  }
  await fs.writeFile(
    path.join(dir, SOURCE_FILE),
    `${JSON.stringify({ link: url, file: name }, null, 2)}\n`,
  );
  return path.join(dir, name);
}

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
      "%(extractor_key)s-%(id)s.%(ext)s",
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

// A track that fails to download stays missing: the study hears the voice instead.
async function downloadSubtitle(ytDlp: string, file: string): Promise<void> {
  const stem = path.join(path.dirname(file), path.basename(file, path.extname(file)));
  const info = readClipPageInfo(`${stem}.info.json`);
  if (!info) return;
  const track = pickSubtitleTrack(offeredSubtitleTracks(info), info.language ?? null);
  if (!track) return;
  await execFileAsync(ytDlp, [
    "--load-info-json",
    `${stem}.info.json`,
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
    "-o",
    `${stem}.%(ext)s`,
  ]).catch(() => {});
}

async function fetchClip(url: string, dir: string): Promise<string> {
  const file = await fetchVideoFile(url, dir);
  if (!file) {
    throw new KonteError(
      "CLIP_DOWNLOAD_FAILED",
      `${url} is a page, not a video file; download the clip and pass its file`,
    );
  }
  await probeClip(file);
  return file;
}

/**
 * Saves the video file `url` answers with into `dir`, named after the URL's last path segment, and
 * returns its path; null where it answers with anything but a video.
 */
export async function fetchVideoFile(url: string, dir: string): Promise<string | null> {
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
  const segment = path.posix.basename(new URL(url).pathname);
  const ext = path.extname(segment).replace(/[^A-Za-z0-9.]/g, "");
  const stem = path.basename(segment, path.extname(segment)).replace(/[^A-Za-z0-9_-]/g, "_");
  const file = path.join(
    dir,
    `${stem || "clip"}${ext.length > 1 ? ext : (VIDEO_EXTENSIONS[type] ?? ".video")}`,
  );
  try {
    await Bun.write(file, res);
  } catch (err) {
    throw new KonteError("CLIP_DOWNLOAD_FAILED", `Could not download ${url}: ${errorMessage(err)}`);
  }
  return file;
}
