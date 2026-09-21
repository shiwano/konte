import { KonteError } from "../core/errors.js";
import type { KonteRoots, VideoRoots } from "../core/roots.js";

// One process runs one command, so the resolved roots are process state. The CLI preAction sets
// them before any action runs; every command reads them from here instead of re-deriving a root
// from process.cwd().

let roots: KonteRoots | null = null;

export function setRoots(next: KonteRoots | null): void {
  roots = next;
}

export function currentRoots(): KonteRoots | null {
  return roots;
}

export function requireWorkspaceRoot(): string {
  if (!roots) {
    throw new KonteError("NOT_A_KONTE_WORKSPACE", "No konte workspace is in scope");
  }
  return roots.workspace;
}

export function requireVideoRoots(): VideoRoots {
  const workspace = requireWorkspaceRoot();
  const video = roots!.video;

  switch (video.kind) {
    case "selected":
      return { workspace, video: video.root };
    case "not-selected":
      throw new KonteError(
        "VIDEO_NOT_SELECTED",
        `No video selected. Run "konte video list" to see this workspace's videos, then "konte video use <name>" to pick one (or cd into the video's directory).`,
      );
    case "not-found":
      throw new KonteError(
        "VIDEO_NOT_FOUND",
        `The current video "${video.name}" no longer exists. Run "konte video list" and "konte video use <name>" to pick another.`,
      );
  }
}

export function requireVideoRoot(): string {
  return requireVideoRoots().video;
}
