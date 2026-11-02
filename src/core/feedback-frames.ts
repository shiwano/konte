import { existsSync } from "node:fs";
import * as path from "node:path";
import { addressToCacheSegments, formatCompositionAddress } from "./address.js";
import {
  atFrameName,
  captureCompositionFrames,
  COMPOSITION_FRAME_FORMAT,
  COMPOSITION_FRAME_QUALITY,
  resolveCompositionCacheDir,
} from "./composition-capture.js";
import { KonteError, errorMessage } from "./errors.js";
import type { ThumbnailInfo } from "./frame-extract.js";
import { isWithinRoot } from "./path-containment.js";
import { shotById } from "./shot-index.js";

// A note id is a path component of its pin frame, and it comes off schema-validated JSON that is a
// text file a human can edit — so it is checked for the shape `generateFeedbackId` mints, not
// trusted. A note that fails this simply gets no pin frame.
const SAFE_FEEDBACK_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The marked twin of a captured frame — the reticle burned in, beside the plain capture rather than
 * over it. The plain frame is shared by every note at that instant, so the twin carries the note id
 * that fixes where the pin sits.
 */
function annotatedFramePath(file: string, feedbackId: string): string {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}-pin-${feedbackId}${ext}`;
}

/**
 * Where a shot's note frames cache: the shot composition's own thumbnail dir, the one
 * `probe reel-thumbnails` fills, so a frame is shared by every note standing at that instant and
 * `clean` / `prune` reclaim it as the composition cache it is.
 *
 * Null when the shot has no composition of its own, or when the shot id would take the dir out of
 * the cache tree — it reaches here off a review record, which is editable text.
 *
 * A shot with no `shotFn` renders a fallback (its board frame), and `probe reel-thumbnails` refuses
 * those for the same reason this does: the address is not a live composition, so `prune` reads its
 * cache as orphaned, and the fallback source is outside what the cache key fingerprints.
 */
export function shotFrameDir(
  video: import("./types/index.js").StageDefinition,
  videoRoot: string,
  shotId: string,
): string | null {
  if (!shotById(video.shots, shotId)?.shotFn) return null;
  const root = path.join(videoRoot, ".konte", "cache", "thumbnails");
  const dir = path.join(
    root,
    ...addressToCacheSegments(formatCompositionAddress(video.stage, shotId)),
  );
  return isWithinRoot(dir, root) ? dir : null;
}

export interface FeedbackFrameOptions {
  video: import("./types/index.js").StageDefinition;
  manager: import("./state/index.js").StateManager;
  videoRoot: string;
  feedbackId: string;
  shotId: string;
  localTime: number;
  annotation?: import("./types/feedback.js").FeedbackAnnotation | null;
}

/**
 * Where a note's frame lives for the composition as it stands now — the whole of what used to be
 * recorded on the note, derived instead. Null when the shot no longer composes or draws nothing at
 * all, which is also the answer to "may this be rendered"; a partly-resolved picture still yields a
 * frame. Returns the videoRoot-relative path, the `-pin-<id>` twin for a pinned note.
 */
export async function feedbackFramePath(options: FeedbackFrameOptions): Promise<string | null> {
  const { videoRoot, feedbackId, shotId, localTime, annotation } = options;
  const outputDir = shotFrameDir(options.video, videoRoot, shotId);
  if (!outputDir) return null;
  let cacheDir: string;
  try {
    ({ cacheDir } = await resolveCompositionCacheDir({
      video: options.video,
      manager: options.manager,
      shotId,
      outputDir,
      format: COMPOSITION_FRAME_FORMAT,
      quality: COMPOSITION_FRAME_QUALITY,
    }));
  } catch {
    return null;
  }
  const file = path.join(cacheDir, atFrameName(Math.max(0, localTime), "jpg"));
  if (annotation?.kind !== "pin") return path.relative(videoRoot, file);
  if (!SAFE_FEEDBACK_ID.test(feedbackId)) return null;
  return path.relative(videoRoot, annotatedFramePath(file, feedbackId));
}

/**
 * Why a note has no frame. `unavailable` is the expected answer — the shot left the definition, its
 * refs no longer resolve, the note addresses nothing inside the cache tree — and says the record is
 * simply older than the piece. `failed` is the rendering machinery breaking (no Chromium, no disk,
 * a capture session dying), which a reader must be told about rather than read as the first.
 */
export type FeedbackFrameResult =
  | { kind: "frame"; file: string }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

/** One shot's notes, as `resolveShotFeedbackFrames` takes them. */
export interface FeedbackFrameNote {
  feedbackId: string;
  /** Offset within the shot, which is what a composition capture takes. */
  localTime: number;
  annotation?: import("./types/feedback.js").FeedbackAnnotation | null;
}

/**
 * The composition frames for one shot's notes — rendered on demand and cached, never recorded. In
 * one capture session for the whole shot: the notes of a review cluster on the shots it flagged,
 * and a session per note would pay Chromium's startup for each.
 *
 * The cache dir is keyed on the composition hash (the definition plus every resolved input's
 * content fingerprint), so a hit is by construction a frame of the composition as it stands now; a
 * changed shot is a miss, not a stale frame served as current.
 *
 * Returns one result per note, in the order given. A frame's path is videoRoot-relative.
 */
export async function resolveShotFeedbackFrames(options: {
  video: import("./types/index.js").StageDefinition;
  manager: import("./state/index.js").StateManager;
  videoRoot: string;
  shotId: string;
  notes: readonly FeedbackFrameNote[];
}): Promise<FeedbackFrameResult[]> {
  const { video, manager, videoRoot, shotId, notes } = options;
  const outputDir = shotFrameDir(video, videoRoot, shotId);
  if (!outputDir) return notes.map(() => ({ kind: "unavailable" }) as const);

  const timestamps = notes.map((n) => Math.max(0, n.localTime));
  let frames: ThumbnailInfo[];
  try {
    frames = await captureCompositionFrames({
      video,
      manager,
      shotId,
      videoRoot,
      outputDir,
      captureOptions: {
        timestamps,
        format: COMPOSITION_FRAME_FORMAT,
        quality: COMPOSITION_FRAME_QUALITY,
        // The same sweep `probe reel-thumbnails` does on this dir: only the current hash survives.
        pruneSuperseded: true,
      },
    });
  } catch (err) {
    // The one expected failure: the shot no longer composes. Everything else is the rendering
    // machinery, and reporting it as "this note has no frame" would hide a broken install.
    const result: FeedbackFrameResult =
      err instanceof KonteError && err.code === "COMPOSITION_BUILD_FAILED"
        ? { kind: "unavailable" }
        : { kind: "failed", message: errorMessage(err) };
    return notes.map(() => result);
  }

  const results: FeedbackFrameResult[] = [];
  for (const [i, note] of notes.entries()) {
    const file = frames[i]?.file;
    if (!file) {
      results.push({ kind: "unavailable" });
      continue;
    }
    if (note.annotation?.kind !== "pin") {
      results.push({ kind: "frame", file });
      continue;
    }
    if (!SAFE_FEEDBACK_ID.test(note.feedbackId)) {
      results.push({ kind: "frame", file });
      continue;
    }
    const source = path.resolve(videoRoot, file);
    const marked = annotatedFramePath(source, note.feedbackId);
    if (!existsSync(marked)) {
      const { annotateFrameWithPin } = await import("./annotate-frame.js");
      const ok = await annotateFrameWithPin({
        sourceFile: source,
        outputFile: marked,
        x: note.annotation.x,
        y: note.annotation.y,
      });
      // A reticle that would not burn in is cosmetic; the frame under it is still the evidence.
      if (!ok) {
        results.push({ kind: "frame", file });
        continue;
      }
    }
    results.push({ kind: "frame", file: path.relative(videoRoot, marked) });
  }
  return results;
}
