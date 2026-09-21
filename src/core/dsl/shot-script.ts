import type { ScriptLine } from "../types/script.js";

// The shot's lines in order. A symbol, so it cannot collide with a roster
// id, and a global-registry one for the reason `DIRECTION_KEY` is (direction.ts).
const SHOT_LINES: unique symbol = Symbol.for("konte.shot-script-lines");

const textOf = (line: ScriptLine): string => ("narration" in line ? line.narration : line.text);

// Who says a line, as the key it lands under. A mob's label is prose the direction may rewrite, so
// keying on it would break the stage file — every mob line lands under `speaker`.
const whoOf = (line: ScriptLine): string =>
  "character" in line ? line.character : "speaker" in line ? "speaker" : "narration";

type WhoOf<L> = L extends { character: infer C extends string }
  ? C
  : L extends { speaker: string }
    ? "speaker"
    : "narration";
type TextOf<L> = L extends { narration: infer N extends string }
  ? N
  : L extends { text: infer T extends string }
    ? T
    : string;

type SpeakerOf<S extends readonly unknown[]> = WhoOf<S[number]>;

// One speaker's words, in shot order, as a tuple — so an in-range index is a plain `string` under
// `noUncheckedIndexedAccess` and an out-of-range one is a type error. Tail-recursive so a long script
// does not hit TypeScript's recursion ceiling. A non-tuple `S` (a direction whose literal type was
// widened) degrades to `readonly string[]`.
type TextsBy<
  S extends readonly unknown[],
  W extends string,
  Acc extends readonly string[] = [],
> = S extends readonly [infer H, ...infer T]
  ? TextsBy<T, W, WhoOf<H> extends W ? [...Acc, TextOf<H>] : Acc>
  : S extends readonly []
    ? Acc
    : readonly string[];

/**
 * What a stage's `build`/`animatic` receives as `script`: the shot's words keyed by who says them
 * (`script.cat[0]`, `script.narration[0]`).
 */
export type ShotScript<S extends readonly ScriptLine[] = readonly ScriptLine[]> = {
  readonly [W in SpeakerOf<S>]: TextsBy<S, W>;
} & { readonly [SHOT_LINES]: readonly ScriptLine[] };

export function makeShotScript(lines: readonly ScriptLine[]): ShotScript {
  const script = Object.create(null) as Record<string, string[]>;
  for (const line of lines) {
    (script[whoOf(line)] ??= []).push(textOf(line));
  }
  Object.defineProperty(script, SHOT_LINES, { value: lines });
  return script as unknown as ShotScript;
}

export function scriptTexts(scriptById: ReadonlyMap<string, readonly ScriptLine[]>): string[] {
  return [...scriptById.values()].flat().map(textOf);
}

// The lines behind an injected script; a hand-built `ScriptLine[]` passes through as itself.
export function shotScriptLines(script: ShotScript | readonly ScriptLine[]): readonly ScriptLine[] {
  return Array.isArray(script) ? script : (script as ShotScript)[SHOT_LINES];
}
