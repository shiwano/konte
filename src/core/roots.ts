import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { KonteError } from "./errors.js";

// Which root a piece of code belongs to, in one rule:
//
//   konte.config.json / konte.credentials.json / konte.version / adapters/ / tsconfig.json / node_modules/ /
//   .konte/{mod.ts,template.lock.json,tools,current-video}   → workspaceRoot
//
//   konte.state.json / .konte/{jobs,logs,cache,frame-src} / assets/ / dist/ / review/ /
//   the definition files (direction.ts, animatic.tsx, video.tsx, reference.tsx) → videoRoot
//
// Only `resolveBackend` and `ComfyUIBackend` — and the call paths that reach them — need both.

export const WORKSPACE_MARKER = "konte.config.json";
export const VIDEO_MARKER = "konte.state.json";
export const VIDEOS_DIR = "videos";
const CURRENT_VIDEO_FILE = path.join(".konte", "current-video");

// The entry file each stage is authored in, at the video root.
export const STAGE_ENTRY_FILE = {
  direction: "direction.ts",
  reference: "reference.tsx",
  animatic: "animatic.tsx",
  video: "video.tsx",
} as const;

export function stageEntryPath(videoRoot: string, stage: keyof typeof STAGE_ENTRY_FILE): string {
  return path.resolve(videoRoot, STAGE_ENTRY_FILE[stage]);
}

/** A video name is a path segment written into the workspace, so it must not escape it. */
export const VIDEO_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export type VideoSelection =
  | { kind: "selected"; root: string; name: string }
  | { kind: "not-selected" }
  | { kind: "not-found"; name: string };

export interface KonteRoots {
  workspace: string;
  video: VideoSelection;
}

/** The pair a backend needs: both roots, with the video one known to exist. */
export interface VideoRoots {
  workspace: string;
  video: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// A raw fs.access, not loadKonteConfig — that one falls back to defaults on ENOENT, so it can
// never tell "no workspace here" from "a workspace with no settings".
async function findUp(from: string, marker: string, stopAt?: string): Promise<string | null> {
  let dir = path.resolve(from);
  for (;;) {
    if (await exists(path.join(dir, marker))) return dir;
    if (stopAt && dir === path.resolve(stopAt)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findWorkspaceRoot(from: string): Promise<string | null> {
  return findUp(from, WORKSPACE_MARKER);
}

/** Upward search for a video root, stopping at (and including) the workspace root. */
function findVideoRoot(from: string, stopAt: string): Promise<string | null> {
  return findUp(from, VIDEO_MARKER, stopAt);
}

/**
 * The workspace's videos: the direct children of `videos/` that carry a state file and whose name
 * is a legal video name. The name filter is what keeps this list, `video use` and `resolveRoots`
 * agreeing on one definition of "a video" — a directory this rejects must not be selectable, or
 * `video use` would accept a name that root resolution then refuses to honour.
 */
export async function listVideos(workspace: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (
      await fsp.readdir(path.join(workspace, VIDEOS_DIR), { withFileTypes: true })
    ).flatMap((e) => (e.isDirectory() && VIDEO_NAME_PATTERN.test(e.name) ? [e.name] : []));
  } catch {
    return [];
  }

  const videos: string[] = [];
  for (const name of entries.sort()) {
    if (!(await exists(path.join(workspace, VIDEOS_DIR, name, VIDEO_MARKER)))) continue;
    if (!(await isRealVideoDir(workspace, name))) continue;
    videos.push(name);
  }
  return videos;
}

/**
 * The recorded current video, or null when there is none.
 *
 * The name is validated on the way out, not just on the way in: this file is plain text a human
 * (or a stale tool) can edit, and it is about to become a path segment. A `../…` in it would
 * otherwise resolve a "video" outside the workspace entirely.
 */
export async function readCurrentVideo(workspace: string): Promise<string | null> {
  try {
    const name = (await fsp.readFile(path.join(workspace, CURRENT_VIDEO_FILE), "utf-8")).trim();
    return VIDEO_NAME_PATTERN.test(name) ? name : null;
  } catch {
    return null;
  }
}

export async function writeCurrentVideo(workspace: string, name: string): Promise<void> {
  const filePath = path.join(workspace, CURRENT_VIDEO_FILE);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${name}\n`, "utf-8");
}

/**
 * The workspace, and which video the command applies to.
 *
 * The video is whichever one cwd sits inside; failing that, the workspace's current video. There
 * is deliberately no "auto-select when there is only one video" rule — a selection that changes
 * shape with the number of videos is a selection nobody can predict. `konte video new` makes the
 * video it creates current, so a one-video workspace never has to choose.
 */
export async function resolveRoots(cwd: string): Promise<KonteRoots> {
  const workspace = await findWorkspaceRoot(cwd);
  if (!workspace) {
    throw new KonteError(
      "NOT_A_KONTE_WORKSPACE",
      `Not a konte workspace (${WORKSPACE_MARKER} not found in "${cwd}" or any parent). Run "konte workspace new" to create one.`,
    );
  }

  const enclosing = await findVideoRoot(cwd, workspace);
  const name = enclosing ? videoName(workspace, enclosing) : null;
  if (enclosing && name && (await isRealVideoDir(workspace, name))) {
    return { workspace, video: { kind: "selected", root: enclosing, name } };
  }

  const current = await readCurrentVideo(workspace);
  if (!current) return { workspace, video: { kind: "not-selected" } };

  const root = path.join(workspace, VIDEOS_DIR, current);
  if ((await exists(path.join(root, VIDEO_MARKER))) && (await isRealVideoDir(workspace, current))) {
    return { workspace, video: { kind: "selected", root, name: current } };
  }
  return { workspace, video: { kind: "not-found", name: current } };
}

/**
 * Is `videos/<name>` a real directory of this workspace, rather than a symlink pointing elsewhere?
 *
 * Everything downstream confines a video's file access to its own root, and it does so by
 * comparing resolved paths. A symlinked video root would move that boundary wherever the link
 * points — aim it at the workspace root and `assets/files/../../konte.credentials.json` becomes "inside the video".
 * It would also break the workspace's containment promise, since deleting the workspace would
 * leave the real directory behind. So a video is a real directory under `videos/`, or it is not a
 * video.
 */
async function isRealVideoDir(workspace: string, name: string): Promise<boolean> {
  const real = await fsp.realpath(path.join(workspace, VIDEOS_DIR, name)).catch(() => null);
  if (real === null) return false;
  const realWorkspace = await fsp.realpath(workspace).catch(() => path.resolve(workspace));
  return real === path.join(realWorkspace, VIDEOS_DIR, name);
}

/**
 * The video's name, or null when `videoRoot` is not a video of this workspace.
 *
 * A video is exactly `<workspace>/videos/<name>` — nothing else, however plausible it looks. A
 * stray `konte.state.json` deeper in the tree (a copied-in old project, or one left at the
 * workspace root by the pre-workspace layout) must not be adopted as a video: it is invisible to
 * `video list` and unselectable by `video use`, so honouring it would give a video that only the
 * cwd can reach and that no command can name.
 */
function videoName(workspace: string, videoRoot: string): string | null {
  const rel = path.relative(path.join(workspace, VIDEOS_DIR), videoRoot);
  return VIDEO_NAME_PATTERN.test(rel) ? rel : null;
}
