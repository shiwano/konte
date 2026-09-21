import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAddressStream, type Stage } from "../address.js";
import { writeFileAtomic } from "../atomic-write.js";
import { KonteError, errorMessage } from "../errors.js";
import { withFileLock } from "../file-lock.js";
import {
  FEEDBACK_SCHEMA_VERSION,
  type FeedbackEntry,
  type FeedbackStream,
  FeedbackStreamSchema,
} from "../types/index.js";

const REVIEW_DIR = "review";
const FEEDBACK_FILE = "feedback.json";

function streamDir(videoRoot: string, stage: Stage): string {
  return path.join(videoRoot, REVIEW_DIR, stage);
}

function streamFilePath(videoRoot: string, stage: Stage): string {
  return path.join(streamDir(videoRoot, stage), FEEDBACK_FILE);
}

function emptyStream(): FeedbackStream {
  return { schemaVersion: FEEDBACK_SCHEMA_VERSION, feedback: {} };
}

export interface FeedbackLocation {
  stage: Stage;
  address: string;
  entry: FeedbackEntry;
}

/**
 * A single stage's review stream's feedback, persisted at
 * `review/<stage>/feedback.json`. Mirrors StateManager (atomic writes, file
 * lock, temp recovery) but scoped to one stream — a missing file is a valid *empty*
 * stream (feedback is additive), so no init is required.
 */
export class FeedbackManager {
  readonly videoRoot: string;
  readonly stage: Stage;
  private stream: FeedbackStream;

  private constructor(videoRoot: string, stage: Stage, stream: FeedbackStream) {
    this.videoRoot = videoRoot;
    this.stage = stage;
    this.stream = stream;
  }

  private get filePath(): string {
    return streamFilePath(this.videoRoot, this.stage);
  }

  static async withLock<T>(
    videoRoot: string,
    stage: Stage,
    fn: (manager: FeedbackManager) => Promise<T>,
  ): Promise<T> {
    // The lock file lives inside the stream dir (opened with `wx`), which may not
    // exist yet on the first write — unlike state, whose lock sits at the project root.
    await fs.mkdir(streamDir(videoRoot, stage), { recursive: true });
    const lockPath = `${streamFilePath(videoRoot, stage)}.lock`;
    return withFileLock(lockPath, async () => {
      // Under the lock, no live writer competes for the stream, so it is safe to adopt a
      // crashed writer's leftover temp. Readers (bare `load`) never do this — otherwise a
      // reader could steal an in-flight `writeFileAtomic` temp out from under a live writer,
      // since a missing feedback file is the normal (empty) case here.
      await FeedbackManager.recoverFromTemp(videoRoot, stage);
      const manager = await FeedbackManager.load(videoRoot, stage);
      const result = await fn(manager);
      await manager.save();
      return result;
    });
  }

  static async load(videoRoot: string, stage: Stage): Promise<FeedbackManager> {
    const filePath = streamFilePath(videoRoot, stage);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      // Absent file → empty stream (feedback is additive, so no init is required). Any other
      // read error (permissions, a directory in the way, transient IO) must surface, not be
      // silently swallowed as "no feedback" — otherwise a later save would erase recoverable data.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new FeedbackManager(videoRoot, stage, emptyStream());
      }
      throw new KonteError(
        "VALIDATION_FAILED",
        `Failed to read feedback file "${filePath}": ${errorMessage(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new KonteError("VALIDATION_FAILED", `Invalid JSON in feedback file "${filePath}"`);
    }

    const result = FeedbackStreamSchema.safeParse(parsed);
    if (!result.success) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `Feedback validation failed: ${result.error.message}`,
      );
    }

    return new FeedbackManager(videoRoot, stage, result.data);
  }

  // Adopt a crashed writer's leftover temp as the committed file (idempotent), then `load`
  // reads it back normally. MUST be called while holding the stream lock — see `withLock`.
  private static async recoverFromTemp(videoRoot: string, stage: Stage): Promise<void> {
    const filePath = streamFilePath(videoRoot, stage);
    // Nothing to recover if the committed file is already present.
    try {
      await fs.access(filePath);
      return;
    } catch {
      // fall through — the file is missing, look for an adoptable temp
    }

    const dir = streamDir(videoRoot, stage);
    const tempPrefix = `.${FEEDBACK_FILE}.`;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    const temps = entries.filter((e) => e.startsWith(tempPrefix) && e.endsWith(".tmp"));

    for (const name of temps) {
      const tmpPath = path.join(dir, name);
      try {
        const result = FeedbackStreamSchema.safeParse(
          JSON.parse(await fs.readFile(tmpPath, "utf-8")),
        );
        if (result.success) {
          await fs.rename(tmpPath, filePath);
          for (const other of temps) {
            if (other !== name) {
              await fs.unlink(path.join(dir, other)).catch(() => {});
            }
          }
          return;
        }
      } catch {
        // try the next candidate
      }
    }

    for (const name of temps) {
      await fs.unlink(path.join(dir, name)).catch(() => {});
    }
  }

  getFeedback(address: string): FeedbackEntry[] {
    return this.stream.feedback[address] ?? [];
  }

  list(): Array<{ address: string; entry: FeedbackEntry }> {
    const out: Array<{ address: string; entry: FeedbackEntry }> = [];
    for (const [address, entries] of Object.entries(this.stream.feedback)) {
      for (const entry of entries) out.push({ address, entry });
    }
    return out;
  }

  addFeedback(address: string, entry: FeedbackEntry): void {
    // Guard against an address landing in the wrong stream file (e.g. a UI bug submitting a
    // `animatic:…` note to the video stream), which would then never surface in its own review.
    const stream = parseAddressStream(address);
    if (stream.stage !== this.stage) {
      throw new KonteError(
        "INVALID_ADDRESS",
        `Feedback address "${address}" does not belong to the ${this.stage} stream`,
      );
    }
    (this.stream.feedback[address] ??= []).push(entry);
  }

  removeFeedback(address: string, feedbackId: string): boolean {
    const list = this.stream.feedback[address];
    if (!list) return false;
    const idx = list.findIndex((f) => f.id === feedbackId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) delete this.stream.feedback[address];
    return true;
  }

  updateFeedbackText(address: string, feedbackId: string, text: string): boolean {
    const entry = this.stream.feedback[address]?.find((f) => f.id === feedbackId);
    if (!entry) return false;
    entry.text = text;
    return true;
  }

  // Drop every comment on an address — its asset is being pruned.
  removeAddress(address: string): void {
    delete this.stream.feedback[address];
  }

  async save(): Promise<void> {
    try {
      await writeFileAtomic(this.filePath, JSON.stringify(this.stream, null, 2));
    } catch (err) {
      throw new KonteError(
        "FEEDBACK_WRITE_FAILED",
        `Failed to write feedback file: ${errorMessage(err)}`,
      );
    }
  }
}

async function listStreams(videoRoot: string): Promise<Array<{ stage: Stage }>> {
  const reviewRoot = path.join(videoRoot, REVIEW_DIR);
  let stages: string[];
  try {
    stages = await fs.readdir(reviewRoot);
  } catch {
    return [];
  }
  const out: Array<{ stage: Stage }> = [];
  for (const stage of stages) {
    try {
      await fs.access(path.join(reviewRoot, stage, FEEDBACK_FILE));
      out.push({ stage: stage as Stage });
    } catch {
      // not a feedback stream
    }
  }
  return out;
}

// Every feedback entry across all streams (for `feedback list` with no scope / `find`).
export async function listAllFeedback(videoRoot: string): Promise<FeedbackLocation[]> {
  const out: FeedbackLocation[] = [];
  for (const { stage } of await listStreams(videoRoot)) {
    const manager = await FeedbackManager.load(videoRoot, stage);
    for (const { address, entry } of manager.list()) {
      out.push({ stage, address, entry });
    }
  }
  return out;
}

export async function findFeedback(
  videoRoot: string,
  feedbackId: string,
): Promise<FeedbackLocation | null> {
  for (const { stage } of await listStreams(videoRoot)) {
    const manager = await FeedbackManager.load(videoRoot, stage);
    const hit = manager.list().find((x) => x.entry.id === feedbackId);
    if (hit) return { stage, address: hit.address, entry: hit.entry };
  }
  return null;
}
