import { type FSWatcher, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyCredentials } from "../core/credentials.js";
import { errorMessage } from "../core/errors.js";
import { closeJobDatabase } from "../core/job-manager.js";
import { listVideos, VIDEOS_DIR } from "../core/roots.js";
import type { WorkerLog } from "./worker-log.js";
import { JobWatcher, type StaleDefinitionsInfo } from "./job-watcher.js";

// fs.watch misses events under WSL2 (and on some network filesystems), so every watcher in konte
// pairs it with a slow reconcile poll. Same discipline here: the poll is what makes the worker
// eventually correct, and fs.watch is what makes it feel instant.
const RECONCILE_INTERVAL_MS = 5_000;

/**
 * Keeps one job watcher alive per video in the workspace, following videos as they are created and
 * removed — an agent running `konte video new` mid-session is the normal flow, and its jobs must be
 * watched without restarting the worker.
 */
export class VideoRegistry {
  private readonly workspaceRoot: string;
  private readonly onStaleDefinitions: (video: string, info: StaleDefinitionsInfo) => void;
  private readonly reconcileIntervalMs: number;
  private readonly log: WorkerLog | undefined;
  private readonly watchers = new Map<string, JobWatcher>();
  // Watchers stopped with jobs possibly still in flight.
  private readonly retiring = new Set<JobWatcher>();
  private readonly starting = new Map<JobWatcher, Promise<void>>();

  private videosWatcher: FSWatcher | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private refreshing = false;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    workspaceRoot: string,
    hooks: {
      onStaleDefinitions?: (video: string, info: StaleDefinitionsInfo) => void;
      reconcileIntervalMs?: number;
      log?: WorkerLog;
    } = {},
  ) {
    this.workspaceRoot = workspaceRoot;
    this.onStaleDefinitions = hooks.onStaleDefinitions ?? (() => {});
    this.reconcileIntervalMs = hooks.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    this.log = hooks.log;
  }

  async start(): Promise<void> {
    const videosDir = path.join(this.workspaceRoot, VIDEOS_DIR);
    // Create it up front so fs.watch can attach even to a workspace with no video yet.
    await fs.mkdir(videosDir, { recursive: true });

    await applyCredentials(this.workspaceRoot);
    await this.reconcile();
    if (this.stopped) return;

    try {
      this.videosWatcher = watch(videosDir, () => void this.reconcile());
    } catch {
      // The poll below covers it.
    }

    this.reconcileTimer = setInterval(() => {
      void this.refreshCredentials();
      void this.reconcile();
    }, this.reconcileIntervalMs);
  }

  videos(): string[] {
    return [...this.watchers.keys()].sort();
  }

  /** Stops watching at once; settles when the jobs already running have finished. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.videosWatcher?.close();
    this.videosWatcher = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const watcher of this.watchers.values()) this.retiring.add(watcher);
    const retiring = [...this.watchers.values()].map((watcher) => this.retire(watcher));
    this.watchers.clear();
    this.stopPromise = Promise.all(retiring).then(() => {});
    return this.stopPromise;
  }

  /** Drops every run lease the watchers hold, including those of a registry already stopped. */
  async releaseLeases(): Promise<void> {
    const watchers = new Set([...this.watchers.values(), ...this.retiring]);
    await Promise.allSettled([...watchers].map((watcher) => watcher.releaseLeases()));
  }

  private async retire(watcher: JobWatcher): Promise<void> {
    watcher.stop();
    await this.starting.get(watcher);
    watcher.stop();
    await watcher.settled();
    this.retiring.delete(watcher);
    closeJobDatabase(watcher.videoRoot);
  }

  /**
   * Re-read the workspace's credentials into the environment. The CLI loads them once at startup,
   * which is the whole life of a worker — so a key set, rotated or deleted in `konte settings`
   * would otherwise never reach the submissions this worker makes.
   *
   * Workspace-level, so it runs here rather than per video: `applyCredentials` reports a change
   * once, and every watcher's backend cache has to hear about it.
   */
  private async refreshCredentials(): Promise<void> {
    // Serialized like reconcile: two passes overlapping on a slow filesystem could apply the older
    // read last, leaving the environment a version behind what is on disk.
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      if (!(await applyCredentials(this.workspaceRoot))) return;
      for (const watcher of this.watchers.values()) {
        watcher.dropBackendCache();
      }
    } catch {
      // An unreadable credentials file is the CLI's error to report; the worker keeps what it has.
    } finally {
      this.refreshing = false;
    }
  }

  // Bring the watcher set in line with what is on disk: start one per new video, drop the ones
  // whose video is gone. Serialized, because fs.watch fires several times for one mkdir.
  private async reconcile(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      const present = new Set(await listVideos(this.workspaceRoot));
      // A stop() during the readdir above must not resurrect a watcher on a directory the caller
      // is already tearing down.
      if (this.stopped) return;

      for (const [name, watcher] of this.watchers) {
        if (present.has(name)) continue;
        void this.retire(watcher);
        this.watchers.delete(name);
        this.log?.write("info", { video: name, event: "video_unwatched" });
      }

      for (const name of present) {
        if (this.stopped) return;
        if (this.watchers.has(name)) continue;
        const roots = {
          workspace: this.workspaceRoot,
          video: path.join(this.workspaceRoot, VIDEOS_DIR, name),
        };
        const jobs = new JobWatcher(roots, name, {
          onStaleDefinitions: (info) => this.onStaleDefinitions(name, info),
          log: this.log,
        });
        this.watchers.set(name, jobs);
        this.log?.write("info", { video: name, event: "video_watched" });
        this.starting.set(jobs, this.startWatcher(name, jobs));
      }
    } catch {
      // Best-effort: a transient readdir failure is retried on the next poll.
    } finally {
      this.reconciling = false;
    }
  }

  // Not awaited by reconcile: a start runs the video's first submit pass, which must not hold up
  // the other videos. A watcher that failed to start leaves the set, so the next poll retries it.
  private async startWatcher(name: string, jobs: JobWatcher): Promise<void> {
    let failed = false;
    try {
      await jobs.start();
    } catch (err) {
      failed = true;
      this.log?.write("warning", {
        video: name,
        event: "video_watch_failed",
        error: errorMessage(err),
      });
    } finally {
      this.starting.delete(jobs);
    }
    if (this.watchers.get(name) !== jobs) {
      jobs.stop();
      return;
    }
    if (!failed) return;
    this.watchers.delete(name);
    this.retiring.add(jobs);
    await this.retire(jobs);
  }
}
