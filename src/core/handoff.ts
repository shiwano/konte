import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KonteError, errorMessage } from "./errors.js";
import { type Handoff, HandoffSchema } from "./types/handoff.js";

const HANDOFF_FILENAME_RE = /\.json$/;

/**
 * Returns the newest `*.json` handoff file for the active review stream, or null when none exists
 * or `shown` names its id — a review already submitted it, and no older one supersedes it.
 * Handoffs nest per stream under `<reviewDir>/<stage>/handoffs/`, so only that directory is read.
 * The file's own `stage` is still verified — a hand-edited file disagreeing with its location is
 * skipped, not shown under the wrong stream — and an invalid file is skipped so a mid-edit file
 * doesn't mask an earlier valid one.
 */
export async function findLatestHandoff(
  reviewDir: string,
  stage: "animatic" | "video" | "reference" | "direction",
  shown?: (id: string) => Promise<boolean>,
): Promise<{ path: string; handoff: Handoff } | null> {
  const dir = path.join(reviewDir, stage, "handoffs");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const files = entries
    .filter((e) => HANDOFF_FILENAME_RE.test(e))
    .sort()
    .reverse();

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const handoff = await loadHandoff(filePath);
      if (handoff.stage !== stage) continue;
      return (await shown?.(handoff.id)) ? null : { path: filePath, handoff };
    } catch {
      continue;
    }
  }

  return null;
}

/** Loads a handoff JSON file. Throws on missing/unparsable/invalid file. */
export async function loadHandoff(filePath: string): Promise<Handoff> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (err) {
    throw new KonteError(
      "LOAD_FAILED",
      `Failed to load handoff "${filePath}": ${errorMessage(err)}`,
    );
  }

  const result = HandoffSchema.safeParse({
    ...(parsed as object),
    id: path.basename(filePath, ".json"),
  });
  if (!result.success) {
    throw new KonteError("VALIDATION_FAILED", `Handoff validation failed: ${result.error.message}`);
  }

  return result.data;
}
