import { isNarrationStemAddress, tryParseAddress } from "./address.js";
import type { CueKind } from "./audio-level.js";
import { KonteError } from "./errors.js";
import { extractRefs } from "./graph.js";
import type { AssetDefinition, StageDefinition } from "./types/index.js";
import type { ScriptLine } from "./types/script.js";
import { lineText } from "./types/script.js";
import { spellingsOf } from "./dsl/respell.js";

/**
 * The WORDS reachable from a set of asset addresses: each one's own `"spokenText"` values plus
 * those of everything it is built from, so a trim or a mix over a TTS take still answers for the
 * line inside it. A whole `"prompt"` is not read — on an audio asset it describes the treatment
 * ("a clean studio read"), and counting it as words would call a recording readable and then refuse
 * the lines it holds. Only the span an adapter marks as its model's lines (`spokenTextPattern`) is.
 */
export function spokenTextsUnder(definition: StageDefinition, refs: readonly string[]): string[] {
  const byAddress = new Map<string, string[]>();
  for (const p of definition.prompts ?? []) {
    const words = p.spoken ? [p.value] : (p.spokenWithin ?? []);
    if (words.length === 0) continue;
    byAddress.set(p.address, [...(byAddress.get(p.address) ?? []), ...words]);
  }
  const plates = ("plates" in definition ? definition.plates : undefined) as
    | Record<string, AssetDefinition>
    | undefined;
  const assetsOf = (address: string): AssetDefinition | undefined => {
    const parsed = tryParseAddress(address);
    if (!parsed || parsed.stage !== definition.stage) return undefined;
    if (parsed.kind === "timeline") return definition.topLevelAssets?.[parsed.assetName];
    if (parsed.kind === "plate") return plates?.[parsed.assetName];
    if (parsed.kind === "shot") {
      return definition.shots.find((s) => s.id === parsed.shotId)?.assets[parsed.assetName];
    }
    return undefined;
  };
  const seen = new Set<string>();
  const stack = [...refs];
  const out: string[] = [];
  while (stack.length > 0) {
    const address = stack.pop()!;
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(...(byAddress.get(address) ?? []));
    const entry = assetsOf(address);
    if (entry) stack.push(...extractRefs(entry));
  }
  return out;
}

// The longest spelling of a line that the words carry, or null for none — a `respell()` may be
// shorter or longer than the words it stands for.
function carriedSpelling(
  definition: StageDefinition,
  shotId: string,
  words: readonly string[],
  line: ScriptLine,
): string | null {
  const carried = spellingsOf(definition.respellings, shotId, lineText(line)).filter((spelling) =>
    words.some((value) => value.includes(spelling)),
  );
  return carried.reduce<string | null>(
    (longest, spelling) => (spelling.length > (longest?.length ?? 0) ? spelling : longest),
    null,
  );
}

const matchedLength = (
  definition: StageDefinition,
  shotId: string,
  words: readonly string[],
  line: ScriptLine,
): number => carriedSpelling(definition, shotId, words, line)?.length ?? 0;

// Whether a set of words carries a line, in any spelling that answers for it inside this shot.
export const saysLine = (
  definition: StageDefinition,
  shotId: string,
  words: readonly string[],
  line: ScriptLine,
): boolean => matchedLength(definition, shotId, words, line) > 0;

const lineKind = (line: ScriptLine): CueKind =>
  "speaker" in line ? "mob" : "narration" in line ? "narration" : "voice";

/**
 * Each of a shot's audio cues, as the mix sees it. The direction decides: a cue carrying a
 * `{ speaker }` line is a `mob`, one carrying a `{ narration }` line `narration`, one carrying a
 * `{ character }` line a `voice`, and one with no words an `sfx`. A board's `#narrationStem` placed
 * in the video is `narration`.
 *
 * The exception is the OPAQUE cue — a recording, which konte can read no words out of. When a shot
 * has lines and not one of its cues carries words, those cues ARE the recording of them, so they
 * are voices — narration when every line is; the same test `assertScriptVoiced` makes before
 * falling back to its whole-shot rule. Mixed with a readable cue the reasoning is gone, and a
 * wordless cue beside a TTS take is far more often a door slam than a second recorded line
 * (`assertNarrationAttributable` refuses the board shot where it could be the narration).
 *
 * Every unresolved case lands on `voice` — the level and the ducking a line already gets, so a
 * misread leaves the mix where it stands today instead of sinking a cue that should carry.
 */
export function classifyShotCues(
  definition: StageDefinition,
  shotId: string,
  stemRefs: readonly string[],
  lines: readonly ScriptLine[],
): Map<string, CueKind> {
  const wordsByRef = new Map(stemRefs.map((ref) => [ref, spokenTextsUnder(definition, [ref])]));
  const anyReadable = [...wordsByRef.values()].some((words) => words.length > 0);
  const recordingKind: CueKind = lines.every((line) => "narration" in line) ? "narration" : "voice";
  const out = new Map<string, CueKind>();
  for (const [ref, words] of wordsByRef) {
    if (isNarrationStemAddress(ref)) {
      out.set(ref, "narration");
      continue;
    }
    if (words.length === 0) {
      out.set(ref, lines.length > 0 && !anyReadable ? recordingKind : "sfx");
      continue;
    }
    // Longest match first: a cue carrying "Yes, sir" contains "Yes" too, and the line it is really
    // reading is the longer one. Lines that tie — a character and the mob given the same words —
    // settle nothing, so the cue takes the safe reading rather than whichever was written first.
    const matched = lines
      .map((line) => ({ line, length: matchedLength(definition, shotId, words, line) }))
      .filter((m) => m.length > 0)
      .sort((x, y) => y.length - x.length);
    const best = matched[0];
    const ties = best ? matched.filter((m) => m.length === best.length) : [];
    const kinds = new Set(ties.map(({ line }) => lineKind(line)));
    out.set(ref, kinds.size === 1 ? [...kinds][0]! : "voice");
  }
  return out;
}

/**
 * File every shot's cues by kind, in place, once the stage is built and the direction's lines are
 * still at hand. A shot with no cues gets no record.
 */
export function attachCueKinds(
  definition: StageDefinition,
  scriptById: ReadonlyMap<string, readonly ScriptLine[]>,
): void {
  for (const shot of definition.shots) {
    const stemRefs = shot.stemRefs ?? [];
    if (stemRefs.length === 0) continue;
    const kinds = classifyShotCues(definition, shot.id, stemRefs, scriptById.get(shot.id) ?? []);
    shot.cueKinds = Object.fromEntries(kinds);
  }
}

// The lines a cue's words say, dropping one whose words only occur inside a longer line it says (a
// narration quoting a character's "はい").
function linesSaid(
  definition: StageDefinition,
  shotId: string,
  words: readonly string[],
  lines: readonly ScriptLine[],
): ScriptLine[] {
  const matched = lines.flatMap((line) => {
    const spelling = carriedSpelling(definition, shotId, words, line);
    return spelling === null ? [] : [{ line, spelling }];
  });
  return matched
    .filter(
      (m) =>
        !matched.some(
          (other) =>
            other.spelling.length > m.spelling.length && other.spelling.includes(m.spelling),
        ),
    )
    .map((m) => m.line);
}

/**
 * Refuse a board shot whose narration konte cannot find. Its cues split by kind into `#stem` and
 * `#narrationStem`, and a recording beside a narration line no readable take carries may be either
 * that narration or a sound in the frame — a guess that, wrong, hands the narrator's words to the
 * motion model. The shot whose every line is narration and every cue a recording is the recording
 * of them, and stands. One take saying both a narration and another line cannot go to either stem.
 */
export function assertNarrationAttributable(
  definition: StageDefinition,
  scriptById: ReadonlyMap<string, readonly ScriptLine[]>,
): void {
  for (const shot of definition.shots) {
    if (shot.pending) continue;
    const lines = scriptById.get(shot.id) ?? [];
    const narration = lines.filter((line) => "narration" in line);
    if (narration.length === 0) continue;
    const wordsByRef = (shot.stemRefs ?? []).map(
      (ref) => [ref, spokenTextsUnder(definition, [ref])] as const,
    );
    for (const [ref, words] of wordsByRef) {
      const said = linesSaid(definition, shot.id, words, lines);
      const narrated = said.find((line) => "narration" in line);
      const spoken = said.find((line) => !("narration" in line));
      if (!narrated || !spoken) continue;
      throw new KonteError(
        "NARRATION_UNATTRIBUTED",
        `Animatic shot "${shot.id}" plays ${ref}, one take carrying both the narration ` +
          `\u201c${lineText(narrated)}\u201d and the line \u201c${lineText(spoken)}\u201d. The ` +
          `narration is mixed into #narrationStem, kept away from the motion model, and the line ` +
          `into #stem, so one take cannot go to both. Voice them as separate takes.`,
      );
    }
    const opaque = wordsByRef.filter(([, words]) => words.length === 0).map(([ref]) => ref);
    if (opaque.length === 0) continue;
    const readable = wordsByRef.flatMap(([, words]) => words);
    if (readable.length === 0 && narration.length === lines.length) continue;
    const unmatched = narration.find((line) => !saysLine(definition, shot.id, readable, line));
    if (!unmatched) continue;
    throw new KonteError(
      "NARRATION_UNATTRIBUTED",
      `Animatic shot "${shot.id}" plays ${opaque.join(", ")}, a recording konte reads no words ` +
        `from, and no take it can read carries the narration \u201c${lineText(unmatched)}\u201d. ` +
        `konte cannot tell whether the recording is that narration (mixed into #narrationStem, ` +
        `kept away from the motion model) or a sound in the frame (mixed into #stem). Voice the ` +
        `narration with an adapter whose spoken-text input carries its words.`,
    );
  }
}
