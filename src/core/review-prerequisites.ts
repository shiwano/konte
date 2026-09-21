import { type Stage, tryParseAddress } from "./address.js";
import { KonteError } from "./errors.js";
import { STAGE_ENTRY_FILE } from "./roots.js";
import { selectResolvedVariant } from "./staleness.js";
import type { KonteState } from "./types/index.js";
import type { AnimaticDefinition } from "./types/animatic.js";

// A review prerequisite is a definition field that no backend consumes, that a human needs beside
// the media to review it, and that cannot be written until the media exists. It is therefore absent
// by design until output lands, and owed from the moment it does — which is why it is a gate at
// `konte preview` / `konte accept` rather than a check at discovery.
export interface UnmetPrerequisite {
  stage: Stage;
  address: string;
  /** The definition fields still to be written. */
  missing: readonly string[];
  /** The file they are written in, so a step can name where to go. */
  writeIn: string;
  /** The shot the target belongs to, where it has one. */
  shotId?: string;
}

interface PrerequisiteDefinitions {
  animatic?: AnimaticDefinition | null;
}

type Collector = (
  defs: PrerequisiteDefinitions,
  state: KonteState,
  addresses?: ReadonlySet<string>,
) => UnmetPrerequisite[];

// A stage absent here has no prerequisites — `reference` and `video` today. Giving one to another
// stage means writing its collector and widening `PrerequisiteDefinitions` (plus what the gates
// pass into it); the gates' own logic stays put, since they only ever ask by stage.
const COLLECTORS: Partial<Record<Stage, Collector>> = {
  animatic: collectPanelMovement,
};

export function findUnmetPrerequisites(
  stage: Stage,
  defs: PrerequisiteDefinitions,
  state: KonteState,
  addresses?: ReadonlySet<string>,
): UnmetPrerequisite[] {
  return COLLECTORS[stage]?.(defs, state, addresses) ?? [];
}

// Every stage's collectors at once. This — not the per-stage form — is what an accept must ask:
// which stage REVIEWS a target is not the stage that owns its address. A `reference:` asset used as
// an animatic panel is reviewed on the board, so its accept is the board's to answer for, and the
// reference stage alone would wave it through.
export function findAllUnmetPrerequisites(
  defs: PrerequisiteDefinitions,
  state: KonteState,
  addresses?: ReadonlySet<string>,
): UnmetPrerequisite[] {
  return Object.values(COLLECTORS).flatMap((collect) => collect(defs, state, addresses));
}

// An address does not always identify the target: a shared timeline/reference asset used as a panel
// in several shots owes its prerequisite once per shot, under the one address they share. Null when the
// address already carries the shot (`…:shot.01.first`), so the common case reads unqualified.
export function prerequisiteShot(u: UnmetPrerequisite): string | null {
  const parsed = tryParseAddress(u.address);
  const carriesShot = parsed?.kind === "shot" && parsed.shotId === u.shotId;
  return u.shotId && !carriesShot ? `shot ${u.shotId}` : null;
}

export function assertPrerequisitesMet(unmet: readonly UnmetPrerequisite[], blocked: string): void {
  if (unmet.length === 0) return;
  const lines = unmet.map((u) => {
    const shot = prerequisiteShot(u);
    return `  ${u.address}${shot ? ` (${shot})` : ""} — no ${u.missing.join(", no ")}`;
  });
  const writeIn = [...new Set(unmet.map((u) => u.writeIn))].join(", ");
  throw new KonteError(
    "REVIEW_PREREQUISITE_MISSING",
    `${blocked} — ${unmet.length} target(s) have output but are missing what their review needs:\n` +
      `${lines.join("\n")}\n` +
      `Write each in ${writeIn}, from the output it now has.`,
  );
}

// animatic — a panel's `blocking`/`camera`: the transit out of that frame, written from the take.
// A panel with no resolved variant has nothing to write them from, so it is unbuilt rather than
// unmet and never reported. The landing frame of a multi-panel shot is exempt (nothing moves out of
// it) — unless the next shot runs on from this frame in one take, when the last panel owes its
// transit like any other. An undeveloped `pendingShot` has no panel at all.
function collectPanelMovement(
  defs: PrerequisiteDefinitions,
  state: KonteState,
  addresses?: ReadonlySet<string>,
): UnmetPrerequisite[] {
  const animatic = defs.animatic;
  if (!animatic) return [];

  const unmet: UnmetPrerequisite[] = [];
  for (const shot of animatic.shots) {
    // Each frame's keyframes are their own run: a cutin's landing frame is exempt within the cutin.
    for (const lane of ["main", "cutin"] as const) {
      const panels = (lane === "main" ? shot.panels : shot.cutin?.panels) ?? [];
      const total = panels.length;
      const continued = shot.continuedBy?.[lane] !== undefined;
      for (const [i, p] of panels.entries()) {
        if (total > 1 && i === total - 1 && !continued) continue;
        if (addresses && !addresses.has(p.assetPath)) continue;
        const missing = [
          p.blocking === undefined ? "blocking" : null,
          p.camera === undefined ? "camera" : null,
        ].filter((n) => n !== null);
        if (missing.length === 0) continue;
        if (!selectResolvedVariant(state, p.assetPath, { includeStale: true })) continue;
        unmet.push({
          stage: "animatic",
          address: p.assetPath,
          missing,
          writeIn: STAGE_ENTRY_FILE.animatic,
          shotId: shot.id,
        });
      }
    }
  }
  return unmet;
}
