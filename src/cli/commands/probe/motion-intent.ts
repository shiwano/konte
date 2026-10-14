import { parseAddress, patchSourceVariantIdOf } from "../../../core/address.js";
import { collectArcShots, collectShotFrames, type ShotFrame } from "../../../core/direction.js";
import { deriveShotHinges, type Direction } from "../../../core/dsl/direction.js";
import type { StateManager } from "../../../core/state/index.js";
import type { AnimaticDefinition } from "../../../core/types/index.js";
import { loadAnimatic } from "../../../core/loader.js";
import { loadDirectionIfPresent } from "../../load-definition.js";

/** One panel's declared movement out of its frame. At least one side is present. */
interface MotionMove {
  blocking: string | null;
  camera: string | null;
}

/** The boundary into a shot, where it breaks story time or place. Either side may be absent. */
export interface ShotBoundary {
  join: NonNullable<ShotFrame["join"]> | null;
  location: { from: string; to: string } | null;
}

/** What the shot behind a clip was asked to do — the half no measurement supplies. */
interface MotionIntent {
  shotId: string;
  action: string | null;
  boundary: ShotBoundary | null;
  moves: MotionMove[];
  frames?: {
    lane: ShotFrame["lane"];
    hinge: ReturnType<typeof deriveShotHinges>;
    passing: string[];
  }[];
}

// Keyed by shot id, for the shots whose boundary says anything: a declared `join`, or a setup in
// another location than the shot just before on the clock.
export function shotBoundaries(direction: Direction): Map<string, ShotBoundary> {
  const mainFrames = new Map(
    collectShotFrames(direction)
      .filter((frame) => frame.lane === "main")
      .map((frame) => [frame.shotId, frame]),
  );
  const locationOf = (shotId: string | undefined): string | undefined => {
    const frame = shotId === undefined ? undefined : mainFrames.get(shotId);
    return frame ? direction.setups?.[frame.setup]?.location : undefined;
  };

  const out = new Map<string, ShotBoundary>();
  const shots = collectArcShots(direction);
  for (const [i, shot] of shots.entries()) {
    const join = mainFrames.get(shot.id)?.join ?? null;
    const from = locationOf(shots[i - 1]?.id);
    const to = locationOf(shot.id);
    const location = from !== undefined && to !== undefined && from !== to ? { from, to } : null;
    if (join != null || location != null) out.set(shot.id, { join, location });
  }
  return out;
}

// A clip that was meant to hold still measures the same as one that failed to animate — only the shot's
// `action` and the board's `blocking`/`camera` say which came back.
//
// Best-effort by construction: a probe reports what a file does whether or not the definition that
// asked for it still loads, so an absent or broken direction.ts / animatic.tsx yields no intent
// rather than an error.
export function createMotionIntentLoader(
  videoRoot: string,
  manager: StateManager,
): (address: string) => Promise<MotionIntent | null> {
  let sources: Promise<{
    actions: Map<string, string>;
    direction: Direction | null;
    boundaries: Map<string, ShotBoundary>;
    animatic: AnimaticDefinition | null;
  }> | null = null;

  const load = (): Promise<{
    actions: Map<string, string>;
    direction: Direction | null;
    boundaries: Map<string, ShotBoundary>;
    animatic: AnimaticDefinition | null;
  }> => {
    sources ??= (async () => {
      // The shot's `action` comes from the direction, not from the stage file that injected it —
      // the same prose either way, out of the cheaper module.
      const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
      const animatic = await loadAnimatic(videoRoot).catch(() => null);
      const actions = new Map(
        direction ? collectArcShots(direction).map((s) => [s.id, s.action]) : [],
      );
      const boundaries = direction ? shotBoundaries(direction) : new Map<string, ShotBoundary>();
      return { actions, boundaries, animatic, direction };
    })();
    return sources;
  };

  return async (address) => {
    // A patch step's own address names no shot; the take it corrects does, and a correction is judged
    // against that shot's movement.
    const patchSource = patchSourceVariantIdOf(address);
    let subject = address;
    if (patchSource) {
      try {
        subject = manager.resolveVariantAddress(patchSource);
      } catch {
        return null;
      }
    }

    let shotId: string;
    try {
      const parsed = parseAddress(subject);
      if (parsed.kind !== "shot") return null; // a timeline asset stages no shot
      shotId = parsed.shotId;
    } catch {
      return null;
    }

    const { actions, boundaries, animatic, direction } = await load();
    const shot = animatic?.shots.find((s) => s.id === shotId);
    const panels = [...(shot?.panels ?? []), ...(shot?.cutin?.panels ?? [])];
    const moves = panels
      .map((panel) => ({ blocking: panel.blocking ?? null, camera: panel.camera ?? null }))
      .filter((move) => move.blocking != null || move.camera != null);
    const action = actions.get(shotId) ?? null;
    if (action == null && moves.length === 0) return null;
    const frames = direction ? collectShotFrames(direction).filter((f) => f.shotId === shotId) : [];
    const frameIntents = frames.map((frame) => ({
      lane: frame.lane,
      hinge: deriveShotHinges(direction!, action ?? "", frame.setup),
      passing: (frame.passing ?? []).map((id) => {
        const name = direction?.characters?.[id]?.name;
        return name ? `${name} (${id})` : id;
      }),
    }));
    return {
      shotId,
      action,
      boundary: boundaries.get(shotId) ?? null,
      moves,
      frames: frameIntents,
    };
  };
}

// Label-aligned lines for the advisory, matching the rest of `probe motion`'s stderr block. A
// multi-panel shot numbers its movements in panel order — each carries a different span.
export function formatMotionIntent(intent: MotionIntent): string[] {
  const lines: string[] = [];
  if (intent.action) lines.push(`  action    ${intent.action}`);
  for (const frame of intent.frames ?? []) {
    const suffix = intent.frames!.some((f) => f.lane === "cutin") ? ` (${frame.lane})` : "";
    if (frame.passing.length)
      lines.push(`  ${`passing${suffix}`.padEnd(9)} ${frame.passing.join(" | ")}`);
    if (frame.hinge.length)
      lines.push(
        `  ${`hinge${suffix}`.padEnd(9)} ${frame.hinge.map((h) => `${h.name}${h.notInSet ? " (not in set)" : ""}`).join(" | ")}`,
      );
  }
  if (intent.boundary?.join) lines.push(`  join      ${intent.boundary.join}`);
  if (intent.boundary?.location) {
    const { from, to } = intent.boundary.location;
    lines.push(`  location  ${from} → ${to}`);
  }
  for (const [i, move] of intent.moves.entries()) {
    const parts = [
      move.blocking ? `blocking: ${move.blocking}` : null,
      move.camera ? `camera: ${move.camera}` : null,
    ].filter((p) => p != null);
    const label = intent.moves.length > 1 ? `movement ${i + 1}` : "movement";
    lines.push(`  ${label.padEnd(9)} ${parts.join("  —  ")}`);
  }
  return lines;
}
