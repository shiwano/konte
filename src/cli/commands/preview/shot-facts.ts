import { resolveLens } from "../../../core/direction-structure.js";
import { ROLE_FUNCTION_LABEL } from "../../../core/lenses.js";
import type { Direction, DirectionNode, Framing } from "../../../core/dsl/direction.js";
import { isAsideShot, isGraphicShot } from "../../../core/dsl/shot-kind.js";
import type { ShotInfo } from "../../../core/types/review-state.js";
import { scriptLinesToView, type ScriptLineView } from "../../../core/types/script.js";

// The direction facts the animatic's shot band prints beside each shot's action: its dramatic
// function, framing, and the NAME of its location. The raw `role` is deliberately left behind —
// see direction-view.ts roleFunctionOf for why the reviewer is shown the function instead. `script` is the
// shot's lines, which an undeveloped shot's tile prints in place of the panel-placed ones it has
// none of; `telop` is the unspoken text laid over the same shot. Empty when the video has no
// direction.ts, which the band then simply omits.
interface ShotFacts {
  roleFunctionLabel: string | null;
  // Both read through the shot's setup, so both are null when it is not a declared one — and on an
  // aside, which is taken from no camera and set in no place, so are the rest.
  framing: Framing | null;
  location: string | null;
  script: ScriptLineView[];
  telop: string[];
  // What an aside's span is, for the views that print a shot's line. Null on a narrative shot, whose
  // prose is its `action` and reaches the view another way.
  asideLabel: string | null;
  // The boundary into this shot. Null on an ordinary cut, a graphic shot and an aside.
  join: ShotInfo["join"];
  coverage: boolean;
}

// A shot reaches its size and its place through its setup, so every view that shows either resolves
// it here. Both are shown by the roster's own word — the location's `name` for continuity, the
// setup's for the frame — with the raw id as the fallback a `setup-unknown` direction reads like.
export function shotFrameResolver(direction: Direction): (setupId: string) => {
  framing: Framing | null;
  location: string | null;
  setupName: string;
} {
  const locationNameById = new Map(
    Object.entries(direction.locations ?? {}).map(([id, l]) => [id, l.name]),
  );
  return (setupId: string) => {
    const setup = direction.setups?.[setupId];
    return {
      framing: setup?.framing ?? null,
      location: setup ? (locationNameById.get(setup.location) ?? setup.location) : null,
      setupName: setup?.name ?? setupId,
    };
  };
}

export function shotFactsIndex(direction: Direction | null): Map<string, ShotFacts> {
  const byId = new Map<string, ShotFacts>();
  if (!direction) return byId;
  const characterNameById = new Map(
    Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.name]),
  );
  const frameOf = shotFrameResolver(direction);
  const walk = (node: DirectionNode): void => {
    for (const shot of node.shots ?? []) {
      if (isAsideShot(shot)) {
        byId.set(shot.id, {
          roleFunctionLabel: null,
          framing: null,
          location: null,
          script: [],
          telop: [...(shot.telop ?? [])],
          asideLabel: shot.label,
          join: null,
          coverage: false,
        });
        continue;
      }
      const fn = resolveLens(node.lens, direction.lenses)?.roles.find(
        (b) => b.role === shot.role,
      )?.fn;
      const own = isGraphicShot(shot) ? null : shot;
      const frame = own ? frameOf(own.setup) : null;
      byId.set(shot.id, {
        roleFunctionLabel: fn ? ROLE_FUNCTION_LABEL[fn] : null,
        framing: frame?.framing ?? null,
        location: frame?.location ?? null,
        script: scriptLinesToView(shot.script, characterNameById),
        telop: [...(shot.telop ?? [])],
        asideLabel: null,
        join: own?.join ?? null,
        coverage: own?.coverage === true,
      });
    }
    for (const child of node.sequences ?? []) walk(child);
  };
  walk(direction.sequence);
  return byId;
}
