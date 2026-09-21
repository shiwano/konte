import { parseAddress, patchSourceVariantIdOf } from "../../../core/address.js";
import { collectArcShots } from "../../../core/direction.js";
import type { StateManager } from "../../../core/state/index.js";
import type { AnimaticDefinition } from "../../../core/types/index.js";
import { loadAnimatic } from "../../../core/loader.js";
import { loadDirectionIfPresent } from "../../load-definition.js";

/** One panel's declared movement out of its frame. At least one side is present. */
interface MotionMove {
  blocking: string | null;
  camera: string | null;
}

/** What the shot behind a clip was asked to do — the half no measurement supplies. */
interface MotionIntent {
  shotId: string;
  action: string | null;
  moves: MotionMove[];
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
    animatic: AnimaticDefinition | null;
  }> | null = null;

  const load = (): Promise<{
    actions: Map<string, string>;
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
      return { actions, animatic };
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

    const { actions, animatic } = await load();
    const shot = animatic?.shots.find((s) => s.id === shotId);
    const panels = [...(shot?.panels ?? []), ...(shot?.cutin?.panels ?? [])];
    const moves = panels
      .map((panel) => ({ blocking: panel.blocking ?? null, camera: panel.camera ?? null }))
      .filter((move) => move.blocking != null || move.camera != null);
    const action = actions.get(shotId) ?? null;
    if (action == null && moves.length === 0) return null;
    return { shotId, action, moves };
  };
}

// Label-aligned lines for the advisory, matching the rest of `probe motion`'s stderr block. A
// multi-panel shot numbers its movements in panel order — each carries a different span.
export function formatMotionIntent(intent: MotionIntent): string[] {
  const lines: string[] = [];
  if (intent.action) lines.push(`  action    ${intent.action}`);
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
