// Where an animatic shot's keyframes are gathered while its composition renders. `<Panel>` is a
// component, so it only runs inside `renderToHtml` — the same pass `asset()`'s prompts are collected
// in, and for the same reason: only that pass knows the document order the panels are cut in.
//
// `blocking`/`camera` are kept off the HTML: emitting them would put a review prerequisite into the
// composition's definition hash, so rewriting a move after the take came back would ask for a
// re-accept.

import type { PanelLane } from "../types/definition.js";

// One `<Panel>` as declared, before the windows are resolved across the shot.
export interface PanelOccurrence {
  // The frame it keys: the shot's own picture, or its `<Cutin>`.
  lane: PanelLane;
  assetName: string;
  assetPath: string;
  // The declared `start` in shot-local seconds, or null when the panel takes its share of the shot.
  start: number | null;
  blocking?: string;
  camera?: string;
}

let sink: PanelOccurrence[] | null = null;

// Begins a collection, discarding whatever a previous one leaked (a build that threw mid-render
// never ends its scope, and the next shot must not inherit its panels).
export function beginPanelCollection(): void {
  sink = [];
}

export function endPanelCollection(): PanelOccurrence[] {
  const collected = sink ?? [];
  sink = null;
  return collected;
}

// A no-op outside a collection — every later render pass re-runs the same build, and only
// `defineAnimatic`'s own pass describes the definition.
export function recordPanel(occurrence: PanelOccurrence): void {
  sink?.push(occurrence);
}

// Whether this render is the pass that describes the definition. Only there is a panel's `src` still
// an address, so only there can it be checked: a later render sees a served file.
export function isCollectingPanels(): boolean {
  return sink !== null;
}

// Which keyframe of the shot is rendering, per lane. By the real render a panel's `src` is a served
// URL rather than an address, so the cursor — not the part name — pairs it with the entry the
// definition recorded. `Composition` resets both as each shot begins, and panels render in document
// order within their lane.
const cursors: Record<PanelLane, number> = { main: 0, cutin: 0 };

export function resetPanelCursor(): void {
  cursors.main = 0;
  cursors.cutin = 0;
}

export function nextPanelIndex(lane: PanelLane): number {
  return cursors[lane]++;
}
