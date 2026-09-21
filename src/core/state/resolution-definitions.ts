import * as path from "node:path";
import type { ResolutionDefinitions } from "../staleness.js";

/**
 * The loaded definitions resolution reads, per video root. A registry rather than a constructor
 * argument because a manager is made in many places — `StateManager.withLock` makes its own inside
 * the callback — and the definition axis has to be the same for every one of them.
 *
 * The CLI registers once, after loading the stage entries (`applyResolutionDefinitions`). What is
 * registered is a snapshot of files on disk, so a long-lived process re-registers on every reload.
 */
const byVideoRoot = new Map<string, ResolutionDefinitions>();

export function registerResolutionDefinitions(
  videoRoot: string,
  definitions: ResolutionDefinitions,
): void {
  byVideoRoot.set(path.resolve(videoRoot), definitions);
}

export function resolutionDefinitionsFor(videoRoot: string): ResolutionDefinitions | undefined {
  return byVideoRoot.get(path.resolve(videoRoot));
}
