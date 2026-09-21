import { runTimelineInDiscoveryMode } from "../../dsl/shot-context.js";

// Runs `fn` as a video timeline build runs, where `animatic.shot()` may be called.
export function inBuild<T>(fn: () => T): T {
  return runTimelineInDiscoveryMode("video", fn).result as T;
}
