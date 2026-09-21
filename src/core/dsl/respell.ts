import { KonteError } from "../errors.js";
import type { Respelling } from "../types/definition.js";
import type { ScriptLine } from "../types/script.js";
import { lineText } from "../types/script.js";
import { recordSpokenLine } from "./prompt-collect.js";
import { getShotContext } from "./shot-context.js";

// What `respell()` declared while a stage builds. Module state for the reason `prompt-collect`'s
// sink is: only the build pass knows which shot a call was made inside.
let sink: Respelling[] | null = null;

// Begins a collection, discarding whatever a previous one leaked (a definition that threw mid-build
// never ends its scope). Only the two composition stages open one — every other build that collects
// prompts closes it instead, so a leak can never reach a scope that stores no respelling.
export function beginRespellCollection(): void {
  sink = [];
}

export function endRespellCollection(): Respelling[] | undefined {
  const collected = sink;
  sink = null;
  return collected && collected.length > 0 ? collected : undefined;
}

/**
 * The line as one model has to be spelled it: `respell(script.ane[0], "かあちゃん、飴玉ちょうだい。")`
 * returns the second string and files it as standing for the first.
 *
 * The respelling is written at the take that needs it: two takes of one line may spell it
 * differently, and swapping a speech model never touches `direction.ts`, which keeps the words a
 * subtitle and every review surface show. The voiced check then accepts either spelling, the mix
 * reads the cue as that line's voice, and the prompt check skips it as the line quoted verbatim.
 * No hash reads it.
 */
export function respell(line: string, as: string): string {
  if (line.trim() === "" || as.trim() === "") {
    throw new KonteError(
      "INVALID_RESPELL",
      `respell() takes the shot's line and the spelling this model needs, both non-empty — ` +
        `respell(script.<who>[n], "…").`,
    );
  }
  if (sink) {
    const shot = getShotContext()?.shotId;
    if (!sink.some((r) => r.shot === shot && r.line === line && r.as === as)) {
      sink.push({ ...(shot === undefined ? {} : { shot }), line, as });
    }
    // The respelling is a line of the piece as much as the direction's own copy is, so the prompt
    // check skips it wherever a model takes its words in the prompt body.
    recordSpokenLine(as);
  }
  return as;
}

/**
 * Every spelling that answers for a line inside one shot: the words the direction wrote, plus what
 * a `respell()` in that shot — or on the timeline, whose cues any shot may play — declared for them.
 */
export function spellingsOf(
  respellings: readonly Respelling[] | undefined,
  shotId: string,
  line: string,
): string[] {
  const declared = (respellings ?? [])
    .filter((r) => r.line === line && (r.shot === undefined || r.shot === shotId))
    .map((r) => r.as);
  return [line, ...declared];
}

/**
 * Every `respell()` a stage made stands for a line of the shot it was written inside — the words are
 * what file it, since a stage names no line ids. So a paraphrase, a retyped copy, a line lifted from
 * another shot, or one edited in `direction.ts` since leaves the respelling pointing at nothing: the
 * take it was written for would then be judged against the ordinary notation, and the prompt check
 * would skip a phrase no one says.
 *
 * A spelling that is itself another line of the shot is refused too — one cue carrying it would
 * answer for both, and a two-hander would pass on a single take.
 */
export function assertRespellings(
  respellings: readonly Respelling[] | undefined,
  scriptById: ReadonlyMap<string, readonly ScriptLine[]>,
): void {
  if (!respellings || respellings.length === 0) return;
  const linesOf = (shot: string | undefined): Set<string> =>
    shot === undefined
      ? new Set([...scriptById.values()].flat().map(lineText))
      : new Set((scriptById.get(shot) ?? []).map(lineText));
  for (const { shot, line, as } of respellings) {
    const lines = linesOf(shot);
    if (!lines.has(line)) {
      throw new KonteError(
        "INVALID_RESPELL",
        `respell() was given “${line}”, which is not a line direction.ts gives ` +
          `${shot === undefined ? "any shot" : `shot "${shot}"`}. Pass the injected words — ` +
          `respell(script.<who>[n], "…") — so the respelling follows an edit to the line rather ` +
          `than being left behind by it.`,
      );
    }
    if (lines.has(as)) {
      throw new KonteError(
        "INVALID_RESPELL",
        `respell() was told to spell “${line}” as “${as}”, which is another ` +
          `line of the same shot. One take carrying it would answer for both, and the shot's other ` +
          `line would never be recorded.`,
      );
    }
  }
}
