import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAddressStream, type Stage } from "../address.js";
import { KonteError } from "../errors.js";
import { LockedJsonFile } from "../locked-json-file.js";
import {
  FEEDBACK_SCHEMA_VERSION,
  type FeedbackEntry,
  type FeedbackStream,
  FeedbackStreamSchema,
} from "../types/index.js";

const REVIEW_DIR = "review";
const FEEDBACK_FILE = "feedback.json";

// The lock sits at the video root so taking it creates no stream directory.
function streamFile(videoRoot: string, stage: Stage): LockedJsonFile<FeedbackStream> {
  return new LockedJsonFile({
    filePath: path.join(videoRoot, REVIEW_DIR, stage, FEEDBACK_FILE),
    lockPath: path.join(videoRoot, `${REVIEW_DIR}.${stage}.feedback.lock`),
    schema: FeedbackStreamSchema,
    label: "feedback file",
    onMissing: () => ({ schemaVersion: FEEDBACK_SCHEMA_VERSION, feedback: {} }),
    readErrorCode: "FEEDBACK_READ_FAILED",
    writeErrorCode: "FEEDBACK_WRITE_FAILED",
  });
}

export interface FeedbackLocation {
  stage: Stage;
  address: string;
  entry: FeedbackEntry;
}

/**
 * A single stage's review stream's feedback, persisted at `review/<stage>/feedback.json`. A missing
 * file is an empty stream, and one left empty is never written.
 */
export class FeedbackManager {
  readonly videoRoot: string;
  readonly stage: Stage;
  private stream: FeedbackStream;
  private savedSerialized: string | null;

  private constructor(
    videoRoot: string,
    stage: Stage,
    stream: FeedbackStream,
    savedSerialized: string | null,
  ) {
    this.videoRoot = videoRoot;
    this.stage = stage;
    this.stream = stream;
    this.savedSerialized = savedSerialized;
  }

  static async withLock<T>(
    videoRoot: string,
    stage: Stage,
    fn: (manager: FeedbackManager) => Promise<T>,
  ): Promise<T> {
    return streamFile(videoRoot, stage).withLock(async () => {
      const manager = await FeedbackManager.load(videoRoot, stage);
      const result = await fn(manager);
      await manager.save();
      return result;
    });
  }

  static async load(videoRoot: string, stage: Stage): Promise<FeedbackManager> {
    const { value, saved } = await streamFile(videoRoot, stage).read();
    return new FeedbackManager(videoRoot, stage, value, saved);
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

  closeFeedback(address: string, feedbackId: string, closedAt: string): boolean {
    const entry = this.stream.feedback[address]?.find((f) => f.id === feedbackId);
    if (!entry) return false;
    entry.closedAt = closedAt;
    return true;
  }

  // Drop every comment on an address — its asset is being pruned.
  removeAddress(address: string): void {
    delete this.stream.feedback[address];
  }

  /**
   * Moves the comments on each `moves` key to its value, renames the address in the takes every
   * comment was written against and in the live hashes it recorded, passing each of those through
   * `carryHash`.
   */
  renameAddresses(
    moves: ReadonlyMap<string, string>,
    carryHash: (address: string, recorded: string) => string,
  ): void {
    for (const [from, to] of moves) {
      const entries = this.stream.feedback[from];
      if (!entries) continue;
      (this.stream.feedback[to] ??= []).push(...entries);
      delete this.stream.feedback[from];
    }
    for (const entries of Object.values(this.stream.feedback)) {
      for (const entry of entries) {
        for (const [from, to] of moves) {
          const variantId = entry.displayedVariants[from];
          if (variantId === undefined) continue;
          delete entry.displayedVariants[from];
          entry.displayedVariants[to] = variantId;
        }
        if (!entry.displayedDefinitionHashes) continue;
        entry.displayedDefinitionHashes = Object.fromEntries(
          Object.entries(entry.displayedDefinitionHashes).map(([key, hash]) => {
            const address = moves.get(key) ?? key;
            return [address, hash === null ? null : carryHash(address, hash)];
          }),
        );
      }
    }
  }

  async save(): Promise<void> {
    this.savedSerialized = await streamFile(this.videoRoot, this.stage).write(
      this.stream,
      this.savedSerialized,
    );
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
