import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VideoRoots } from "../../roots.js";

export interface Workspace {
  root: string;
  /** The two roots for each video created, keyed by video name. */
  videos: Record<string, VideoRoots>;
  cleanup: () => Promise<void>;
}

export interface MakeWorkspaceOptions {
  videos?: string[];
  config?: Record<string, unknown>;
  /**
   * Seed each video's `konte.state.json`. Turn it off for a test that calls `StateManager.init`
   * itself — that one refuses to overwrite existing state.
   */
  seedState?: boolean;
}

/**
 * A temporary workspace: `konte.config.json` at the root, one directory per video under `videos/`.
 * This is the on-disk shape commands resolve their roots from, so a fixture built here exercises
 * the real two-root split instead of a single directory that happens to hold both markers.
 */
export async function makeWorkspace(opts: MakeWorkspaceOptions = {}): Promise<Workspace> {
  // realpath: macOS resolves os.tmpdir() through a /var → /private/var symlink, and konte compares
  // resolved paths (root containment, video-name derivation).
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "konte-ws-")));
  await fs.writeFile(
    path.join(root, "konte.config.json"),
    `${JSON.stringify(opts.config ?? {}, null, 2)}\n`,
  );

  const videos: Record<string, VideoRoots> = {};
  for (const name of opts.videos ?? []) {
    const video = path.join(root, "videos", name);
    await fs.mkdir(path.join(video, ".konte"), { recursive: true });
    if (opts.seedState !== false) {
      await fs.writeFile(path.join(video, "konte.state.json"), `{"schemaVersion":1,"assets":{}}\n`);
    }
    videos[name] = { workspace: root, video };
  }

  return {
    root,
    videos,
    // maxRetries: a daemon-style test may still be creating a .konte/ dir as the tree is removed.
    cleanup: () => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}
