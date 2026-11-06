import {
  collectShots,
  continuousFrameKeys,
  offscreenSides,
  setupHolds,
  setupView,
} from "./direction.js";
import type { OffscreenFigure } from "./direction-check.js";
import {
  type Direction,
  type View,
  deriveShotHinges,
  isAsideShot,
  isGraphicShot,
  resolveDirectionTimeline,
} from "./dsl/direction.js";
import { formatShotSpan } from "./format-duration.js";
import { loadDirectionIfPresent } from "./stage-definitions.js";

// The landmarks a setup's frame carries, left to right, labelled `<name> (<id>)`; an id the place
// does not declare stands as itself.
function holdsLabels(
  direction: Direction,
  setupId: string,
): { id: string; label: string }[] | null {
  return (
    setupHolds(direction, setupId)?.map(({ id, landmark }) => ({
      id,
      label: landmark ? `${landmark.name} (${id})` : id,
    })) ?? null
  );
}

// What a plate's setup declares of its frame — the wider frame it is a window of (null at the root
// of its own camera axis), its size, and what it holds.
export type PlateFrame = {
  within: string | null;
  framing: string;
  view: View | undefined;
  set: { id: string; label: string }[];
};

export function plateFrameOf(direction: Direction, setupId: string): PlateFrame | null {
  const setup = direction.setups?.[setupId];
  const set = holdsLabels(direction, setupId);
  if (!setup || !set) return null;
  return {
    within: setup.within ?? null,
    framing: setup.framing,
    view: setupView(direction.setups ?? {}, setupId),
    set,
  };
}

// The direction facts printed beside a stage's prompts: what each shot lands, who its frame holds
// left to right, and the lines it speaks with the acting they are to be said with. Best-effort: a
// video with no direction.ts prints prompts alone.
export interface PromptShots {
  action: Map<string, string>;
  hinge: Map<string, ReturnType<typeof deriveShotHinges>>;
  passing: Map<string, readonly string[]>;
  // Keyed as `passing` is: who stands out of the frame at its opening, and on which side.
  offscreen: Map<string, readonly OffscreenFigure[]>;
  span: Map<string, string>;
  lineup: Map<string, { lineup: readonly string[]; lineupTo: readonly string[] | null }>;
  // What the shot's frame carries of its set, left to right — the setup's `holds`, resolved to the
  // landmarks of the place it is set in. Empty on an insert, which holds nothing; absent only for a
  // shot whose setup the roster does not declare, so a reader can tell the two apart.
  set: Map<string, { id: string; label: string }[]>;
  // The shot's own camera; a graphic shot has none.
  setup: Map<string, string>;
  // The declared boundary into the shot's own frame; an ordinary one has no entry.
  join: Map<string, string>;
  // The coverage shots — one take the model cuts inside, its lineup the opening frame.
  coverage: Set<string>;
  // The frames a `continuous` seam runs into, keyed `<shotId>/<lane>`.
  continuous: Set<string>;
  // Per SETUP id, not per shot: what each plate's frame declares.
  plateFrame: Map<string, PlateFrame>;
  // Printed above the addresses only the `<Cutin>` reaches, in place of the shot's own frame.
  cutin: Map<
    string,
    {
      setup: string;
      lineup: readonly string[];
      lineupTo: readonly string[] | null;
      set: { id: string; label: string }[] | null;
      join: string | null;
    }
  >;
  script: Map<string, { speaker: string; text: string; acting: string | null }[]>;
  // `<name> (<id>)`, the form the script line's speaker uses: the prompt names a subject by its
  // roster NAME, and a reader barred from `direction.ts` has no roster to map an id through. The
  label: (id: string) => string;
}

export function formatOffscreen(
  figures: readonly OffscreenFigure[],
  label: (id: string) => string,
): string {
  return figures.map((f) => `${label(f.id)} screen ${f.side}`).join(" | ");
}

export async function loadPromptShots(videoRoot: string): Promise<PromptShots | null> {
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  if (!direction) return null;
  const nameById = new Map(
    Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.name]),
  );
  // An id the character roster does not hold is a structural error, so it is labelled as itself.
  const label = (id: string): string => {
    const name = nameById.get(id);
    return name ? `${name} (${id})` : id;
  };
  const lineup = new Map<
    string,
    { lineup: readonly string[]; lineupTo: readonly string[] | null }
  >();
  const set = new Map<string, { id: string; label: string }[]>();
  const setup = new Map<string, string>();
  const join = new Map<string, string>();
  const coverage = new Set<string>();
  const plateFrame = new Map<string, PlateFrame>(
    Object.keys(direction.setups ?? {}).flatMap((id) => {
      const frame = plateFrameOf(direction, id);
      return frame ? [[id, frame] as const] : [];
    }),
  );
  const script = new Map<string, { speaker: string; text: string; acting: string | null }[]>();
  const cutin: PromptShots["cutin"] = new Map();
  const action = new Map<string, string>();
  const hinge: PromptShots["hinge"] = new Map();
  const passing: PromptShots["passing"] = new Map();
  const span = new Map<string, string>();
  const offscreen: PromptShots["offscreen"] = new Map();
  for (const [key, figures] of offscreenSides(direction)) {
    const [shotId, lane] = key.split("/") as [string, string];
    offscreen.set(lane === "cutin" ? `${shotId}.cutin` : shotId, figures);
  }
  const timeline = resolveDirectionTimeline(direction);
  const timings = timeline.timings;
  for (const shot of collectShots(direction)) {
    if (isAsideShot(shot)) continue;
    action.set(shot.id, shot.action);
    span.set(
      shot.id,
      formatShotSpan(
        timings.get(shot.id)?.duration ?? 0,
        timeline.song ? (shot.beats ?? null) : null,
        timeline.songGrid?.beatsPerBar,
      ),
    );
    if (shot.cutin) {
      hinge.set(`${shot.id}.cutin`, deriveShotHinges(direction, shot.action, shot.cutin.setup));
      passing.set(`${shot.id}.cutin`, shot.cutin.passing ?? []);
      cutin.set(shot.id, {
        setup: shot.cutin.setup,
        lineup: shot.cutin.lineup ?? [],
        lineupTo: shot.cutin.lineupTo ?? null,
        set: holdsLabels(direction, shot.cutin.setup),
        join: shot.cutin.join ?? null,
      });
    }
    if (!isGraphicShot(shot)) {
      setup.set(shot.id, shot.setup);
      hinge.set(shot.id, deriveShotHinges(direction, shot.action, shot.setup));
      passing.set(shot.id, shot.passing ?? []);
      if (shot.join) join.set(shot.id, shot.join);
      if (shot.coverage) coverage.add(shot.id);
      if (shot.lineup) {
        lineup.set(shot.id, { lineup: shot.lineup, lineupTo: shot.lineupTo ?? null });
      }
      const held = holdsLabels(direction, shot.setup);
      if (held) set.set(shot.id, held);
    }
    const lines = (shot.script ?? []).map((line) => ({
      speaker:
        "character" in line
          ? `${nameById.get(line.character) ?? line.character} (${line.character})`
          : "speaker" in line
            ? line.speaker
            : "narration",
      text: "narration" in line ? line.narration : line.text,
      acting: line.acting ?? null,
    }));
    if (lines.length > 0) script.set(shot.id, lines);
  }
  return {
    action,
    hinge,
    passing,
    offscreen,
    span,
    lineup,
    set,
    setup,
    join,
    coverage,
    continuous: continuousFrameKeys(direction),
    plateFrame,
    cutin,
    script,
    label,
  };
}
