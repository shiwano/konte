import type {
  Direction,
  DirectionNode,
  GraphicShot,
  NarrativeShot,
  Setup,
  Shot,
  View,
} from "./dsl/direction.js";
import { isAsideShot, isGraphicShot } from "./dsl/shot-kind.js";
import type { PanelLane, ShotJoin } from "./types/definition.js";

// A shot of the arc — every kind but an aside.
export type ArcShot = NarrativeShot | GraphicShot;

// Every leaf node of the arc tree, in direction order (a branch contributes its descendants' leaves).
function collectLeaves(node: DirectionNode): DirectionNode[] {
  if (Array.isArray(node.shots)) return [node];
  return (node.sequences ?? []).flatMap(collectLeaves);
}

// Each leaf sequence's shot ids, in direction order.
export function leafSequenceShotIds(direction: Direction): string[][] {
  return collectLeaves(direction.sequence).map((leaf) => (leaf.shots ?? []).map((s) => s.id));
}

// Every shot in the direction, flattened across the arc tree in direction order.
// Every shot a leaf declares, asides included — the clock, in direction order. Readers that need
// the runtime, the id namespace or the stage's coverage take this one.
export function collectShots(direction: Direction): Shot[] {
  return collectLeaves(direction.sequence).flatMap((leaf) => leaf.shots ?? []);
}

// The shots of the arc — narrative and graphic, everything the arc, the lines and the rosters are
// about, and the default reader. An aside carries none of the fields those checks read.
export function collectArcShots(direction: Direction): ArcShot[] {
  return collectShots(direction).filter((s): s is ArcShot => !isAsideShot(s));
}

// The shots a camera takes — the narrative ones, the readers of `setup` / `lineup` / `join`.
export function collectCameraShots(direction: Direction): NarrativeShot[] {
  return collectArcShots(direction).filter((s): s is NarrativeShot => !isGraphicShot(s));
}

// One camera frame the direction declares: a narrative shot's own, or the cutin over any arc shot.
// A graphic shot contributes its cutin alone. In clock order, a shot's main frame before its cutin.
export type ShotFrame = {
  shotId: string;
  lane: PanelLane;
  setup: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  passing?: readonly string[];
  props?: readonly string[];
  join?: ShotJoin;
  // A coverage shot's main frame: its opening frame, with the camera after it the model's.
  coverage?: true;
};

/**
 * The job a keyframe does in its frame. A frame's only panel is its key — the moment the shot reads —
 * unless the frame runs on from the one before in one take, where it is that seam and opens the
 * take. Of several, the first opens and the last lands.
 */
export type PanelRole = "key" | "opening" | "landing" | "mid";

export function panelRole(index: number, of: number, continuous: boolean): PanelRole {
  if (of === 1) return continuous ? "opening" : "key";
  if (index === 1) return "opening";
  return index === of ? "landing" : "mid";
}

// The frames whose boundary in is a `continuous` seam, keyed `<shotId>/<lane>`.
export function continuousFrameKeys(direction: Direction | null): Set<string> {
  return new Set(
    (direction ? collectShotFrames(direction) : [])
      .filter((f) => f.join === "continuous")
      .map((f) => `${f.shotId}/${f.lane}`),
  );
}

export function frameLabel(frame: Pick<ShotFrame, "shotId" | "lane">): string {
  return frame.lane === "cutin"
    ? `the cutin over shot "${frame.shotId}"`
    : `shot "${frame.shotId}"`;
}

export function collectShotFrames(direction: Direction): ShotFrame[] {
  return collectArcShots(direction).flatMap(shotFrames);
}

export function shotFrames(s: ArcShot): ShotFrame[] {
  const frames: ShotFrame[] = [];
  if (!isGraphicShot(s)) {
    frames.push({
      shotId: s.id,
      lane: "main",
      setup: s.setup,
      lineup: s.lineup,
      ...(s.lineupTo ? { lineupTo: s.lineupTo } : {}),
      ...(s.passing ? { passing: s.passing } : {}),
      ...(s.props ? { props: s.props } : {}),
      ...(s.join ? { join: s.join } : {}),
      ...(s.coverage ? { coverage: true as const } : {}),
    });
  }
  if (s.cutin) {
    frames.push({
      shotId: s.id,
      lane: "cutin",
      setup: s.cutin.setup,
      lineup: s.cutin.lineup,
      ...(s.cutin.lineupTo ? { lineupTo: s.cutin.lineupTo } : {}),
      ...(s.cutin.passing ? { passing: s.cutin.passing } : {}),
      ...(s.cutin.props ? { props: s.cutin.props } : {}),
      ...(s.cutin.join ? { join: s.cutin.join } : {}),
    });
  }
  return frames;
}

// False means the direction declares no shots — direction.ts is still the unwritten template.
export function directionHasShots(direction: Direction): boolean {
  return collectShots(direction).length > 0;
}

// Each camera frame with the boundary into it, per lane: the shot before it ON THE CLOCK (asides
// included, since an eyecatch dropped between two shots is a cut the narrative-only walk cannot
// see), that shot's frame in the same lane, and the frame this one could run on from in one unbroken
// take — that same frame, when it is on the same DECLARED setup. A main frame runs on only from a
// narrative shot that is no coverage shot, a cutin only from a cutin. An undeclared setup yields none: `setup-unknown`
// owns that frame, and two frames naming one missing id are not two frames of anything.
type JoinBoundary = {
  frame: ShotFrame;
  previous: Shot | undefined;
  previousFrame: ShotFrame | undefined;
  runOn: ShotFrame | undefined;
};

export function joinBoundaries(direction: Direction): JoinBoundary[] {
  const out: JoinBoundary[] = [];
  let previous: Shot | undefined;
  let previousFrames: ShotFrame[] = [];
  for (const shot of collectShots(direction)) {
    const frames = isAsideShot(shot) ? [] : shotFrames(shot);
    for (const frame of frames) {
      const previousFrame = previousFrames.find((f) => f.lane === frame.lane);
      const runOn =
        previousFrame !== undefined &&
        previousFrame.setup === frame.setup &&
        !previousFrame.coverage &&
        direction.setups?.[frame.setup] !== undefined
          ? previousFrame
          : undefined;
      out.push({ frame, previous, previousFrame, runOn });
    }
    previous = shot;
    previousFrames = frames;
  }
  return out;
}

export const frameKey = (frame: Pick<ShotFrame, "shotId" | "lane">): string =>
  `${frame.shotId}/${frame.lane}`;

/**
 * Each frame the shot after it runs on from in one take, keyed `<shotId>/<lane>`, to that shot's id.
 * Only where the take is possible (`runOn`): a `continuous` written anywhere else is
 * `join-impossible`, not a seam.
 */
export function continuedFrames(direction: Direction): Map<string, string> {
  const out = new Map<string, string>();
  for (const { frame, runOn } of joinBoundaries(direction)) {
    if (frame.join === "continuous" && runOn) out.set(frameKey(runOn), frame.shotId);
  }
  return out;
}

// The root of a setup's `within` chain — the widest frame it is a window of, and the id of the camera
// axis it stands on. A setup declaring `within: null` is its own root, and so is one whose chain
// leaves the roster. Guarded against a ring (`within-cyclic` reports it; this must still answer).
export function withinRoot(
  setups: Readonly<Record<string, Setup>>,
  id: string,
): string | undefined {
  const seen = new Set<string>();
  let at = id;
  while (setups[at] !== undefined && !seen.has(at)) {
    seen.add(at);
    // An omitted `within` is a root as much as an explicit `null`: it is legal only where no wider
    // frame could hold this one, which is what being the root of an axis means.
    const parent = setups[at]!.within;
    if (parent == null) return at;
    at = parent;
  }
  // A chain that leaves the roster (`within-impossible`) or rings (`within-cyclic`) names no axis.
  return undefined;
}

// The way a setup's camera faces: its own `view`, or a window's root's. Undefined where the chain
// names no root or the root declares none (both structural errors).
export function setupView(setups: Readonly<Record<string, Setup>>, id: string): View | undefined {
  const root = withinRoot(setups, id);
  return root === undefined ? undefined : (setups[root]?.view ?? undefined);
}
