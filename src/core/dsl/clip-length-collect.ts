import type { AdapterInputGrid } from "./comfy-asset.js";

// How far a cue may end past its shot before it counts as cut.
export const OVERFLOW_FLOOR = 0.1;

/**
 * How long a clip each declared asset asks its model for, gathered while a stage is built.
 *
 * An AssetDefinition's inputs are keyed by workflow target and carry no type, so nothing downstream
 * can tell a frame count from any other number, nor what clock it counts on. Collected here as
 * `asset()` runs — the pass that still has the adapter in hand — and read once the stage is built:
 * by the check that a cue fits its shot, and by the pass that tightens a count konte derived from
 * the words to the window the cue actually plays in.
 *
 * Kept off the AssetDefinition for the reason the prompts are: it would move every definition hash
 * to carry a number already written in `inputs`.
 */
export interface ClipLength {
  // The definition's own inputs record. Held by reference: the tightening pass writes the corrected
  // count back through it, and it doubles as the definition's identity — a cue is matched to its
  // record by it, so no address has to be threaded through `createDefinition`.
  inputs: Record<string, unknown>;
  // The `<nodeId>.<field>` keys the length was written to, `also` targets included.
  targets: string[];
  // How the adapter spells the length: a frame count on its own clock, or seconds. Decides how a
  // corrected value is rounded and how it is named back to the author.
  unit: "frames" | "seconds";
  // Units per second of clip — the model's clock for `"frames"`, 1 for `"seconds"`.
  perSecond: number;
  grid?: AdapterInputGrid;
  length: number;
  // The frame an anchored end image lands on (see `AdapterInputDef.pin`), in the same units.
  anchorFrame?: number;
  // The seconds the words were estimated at, before the grid — present only when konte derived the
  // count rather than the caller declaring one. What lets the tightening pass re-decide.
  wantSec?: number;
  // Runs the adapter's `validators` over a corrected length, so they judge the value that is
  // actually submitted rather than the one `createDefinition` first resolved. Throws as they do.
  revalidate?: (length: number) => void;
}

let sink: ClipLength[] | null = null;

// Begins a collection, discarding whatever a previous one leaked — a build that threw never ends
// its scope. Called from `beginPromptCollection`, which every build entry already runs: the two
// collections span exactly the same pass.
export function beginClipLengthCollection(): void {
  sink = [];
}

export function recordClipLength(entry: ClipLength): void {
  sink?.push(entry);
}

// The length the asset built from `inputs` asks its model for, while its collection is open.
export function clipLengthOf(inputs: Record<string, unknown>): ClipLength | undefined {
  return sink?.find((c) => c.inputs === inputs);
}

export function endClipLengthCollection(): ClipLength[] {
  const collected = sink ?? [];
  sink = null;
  return collected;
}
