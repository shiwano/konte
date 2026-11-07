import { isNarrationStemAddress, isOffFrameStemAddress, tryParseAddress } from "./address.js";
import type { CueKind } from "./audio-level.js";
import { type DirectionIndex, framedCharacterIds } from "./dsl/direction.js";
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
export function carriedSpelling(
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

// The board stem a line's cue is mixed into: `#stem` for a mouth the frame holds and for the mob,
// `#narrationStem` for narration, `#offFrameStem` for a character the frame does not hold.
type LineStem = "stem" | "narration" | "offFrame";

// The characters a shot's frames hold, or null where konte does not split lines by frame: a graphic
// or coverage shot, an aside, and every shot of a piece cut to its song.
function framedCharacters(index: DirectionIndex, shotId: string): ReadonlySet<string> | null {
  if (index.timeline.song || index.graphicIds.has(shotId) || index.coverageIds.has(shotId)) {
    return null;
  }
  return index.lineupById.has(shotId) ? framedCharacterIds(index, shotId) : null;
}

function lineStemOf(index: DirectionIndex, shotId: string): (line: ScriptLine) => LineStem {
  const framed = framedCharacters(index, shotId);
  return (line) =>
    "narration" in line
      ? "narration"
      : "character" in line && framed && !framed.has(line.character)
        ? "offFrame"
        : "stem";
}

// The stem a board stem placed in the video stands for.
function placedLineStem(ref: string): LineStem | null {
  return isNarrationStemAddress(ref) ? "narration" : isOffFrameStemAddress(ref) ? "offFrame" : null;
}

/**
 * Each of a shot's audio cues, as the mix sees it. The direction decides: a cue carrying a
 * `{ speaker }` line is a `mob`, one carrying a `{ narration }` line `narration`, one carrying a
 * `{ character }` line a `voice`, and one with no words an `sfx`. A board's `#narrationStem` placed
 * in the video is `narration`, its `#offFrameStem` a `voice`.
 *
 * The exception is the OPAQUE cue — a recording, which konte can read no words out of. When a shot
 * has lines and not one of its cues carries words, those cues ARE the recording of them, so they
 * are voices — narration when every line is; the same test `assertScriptVoiced` makes before
 * falling back to its whole-shot rule. Only the lines a placed `#narrationStem` / `#offFrameStem`
 * leaves are owed a recording. Mixed with a readable cue the reasoning is gone, and a wordless cue
 * beside a TTS take is far more often a door slam than a second recorded line
 * (`assertLinesAttributable` refuses the board shot where it could be a line mixed apart).
 *
 * Every unresolved case lands on `voice` — the level and the ducking a line already gets, so a
 * misread leaves the mix where it stands today instead of sinking a cue that should carry.
 */
function classifyShotCues(
  definition: StageDefinition,
  shotId: string,
  stemRefs: readonly string[],
  lines: readonly ScriptLine[],
  lineStem: (line: ScriptLine) => LineStem,
): Map<string, CueKind> {
  const wordsByRef = new Map(stemRefs.map((ref) => [ref, spokenTextsUnder(definition, [ref])]));
  const anyReadable = [...wordsByRef.values()].some((words) => words.length > 0);
  const placed = new Set(stemRefs.map(placedLineStem));
  const owed = lines.filter((line) => !placed.has(lineStem(line)));
  const recordingKind: CueKind = owed.every((line) => "narration" in line) ? "narration" : "voice";
  const out = new Map<string, CueKind>();
  for (const [ref, words] of wordsByRef) {
    const stem = placedLineStem(ref);
    if (stem) {
      out.set(ref, stem === "narration" ? "narration" : "voice");
      continue;
    }
    if (words.length === 0) {
      out.set(ref, owed.length > 0 && !anyReadable ? recordingKind : "sfx");
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
export function attachCueKinds(definition: StageDefinition, index: DirectionIndex): void {
  for (const shot of definition.shots) {
    const stemRefs = shot.stemRefs ?? [];
    if (stemRefs.length === 0) continue;
    const kinds = classifyShotCues(
      definition,
      shot.id,
      stemRefs,
      index.scriptById.get(shot.id) ?? [],
      lineStemOf(index, shot.id),
    );
    shot.cueKinds = Object.fromEntries(kinds);
  }
}

/**
 * Move each board shot's cues saying lines no mouth in its frame speaks out of `#stem`, the mix a
 * motion model takes: narration into `#narrationStem`, a character the frame does not hold into
 * `#offFrameStem` unless nothing else would be left in `#stem`. Runs after `attachCueKinds`, on a
 * stage `assertLinesAttributable` let through, so a cue saying lines of two stems never reaches
 * it. A wordless voice is the recording of every line the shot gives.
 */
export function splitHeardStems(definition: StageDefinition, index: DirectionIndex): void {
  for (const shot of definition.shots) {
    const cues = shot.stemRefs ?? [];
    if (cues.length === 0) continue;
    const lines = index.scriptById.get(shot.id) ?? [];
    const lineStem = lineStemOf(index, shot.id);
    const stemOf = (ref: string): LineStem => {
      const kind = shot.cueKinds?.[ref];
      if (kind === "narration") return "narration";
      if (kind !== "voice") return "stem";
      const words = spokenTextsUnder(definition, [ref]);
      const said = words.length > 0 ? linesSaid(definition, shot.id, words, lines) : lines;
      return said.length > 0 && said.every((line) => lineStem(line) === "offFrame")
        ? "offFrame"
        : "stem";
    };
    const byStem = Map.groupBy(cues, stemOf);
    const narration = byStem.get("narration");
    const offFrame = byStem.has("stem") ? byStem.get("offFrame") : undefined;
    if (!narration && !offFrame) continue;
    shot.stemRefs = cues.filter((ref) => !narration?.includes(ref) && !offFrame?.includes(ref));
    if (narration) shot.narrationStemRefs = narration;
    if (offFrame) shot.offFrameStemRefs = offFrame;
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
 * Refuse a board shot whose lines mixed apart konte cannot find. Its cues split by the line they say
 * into `#stem`, `#narrationStem` and `#offFrameStem`, and a recording beside such a line no readable
 * take carries may be that line or a sound in the frame — a guess that, wrong, hands words no mouth
 * in the frame speaks to the motion model. The shot whose every line goes to one stem apart and every
 * cue is a recording is the recording of them, and stands. One take saying lines of two stems cannot
 * go to either, unless the two read alike.
 */
export function assertLinesAttributable(definition: StageDefinition, index: DirectionIndex): void {
  for (const shot of definition.shots) {
    if (shot.pending) continue;
    const lines = index.scriptById.get(shot.id) ?? [];
    const lineStem = lineStemOf(index, shot.id);
    const apart = lines.filter((line) => lineStem(line) !== "stem");
    if (apart.length === 0) continue;
    const wordsByRef = (shot.stemRefs ?? []).map(
      (ref) => [ref, spokenTextsUnder(definition, [ref])] as const,
    );
    for (const [ref, words] of wordsByRef) {
      // Two lines of one text tie: the take says one of them, and `splitHeardStems` keeps it in
      // `#stem`.
      const [first, ...rest] = linesSaid(definition, shot.id, words, lines);
      const other =
        first &&
        rest.find(
          (line) => lineStem(line) !== lineStem(first) && lineText(line) !== lineText(first),
        );
      if (!first || !other) continue;
      throw new KonteError(
        "CUE_UNATTRIBUTED",
        `Animatic shot "${shot.id}" plays ${ref}, one take carrying both ` +
          `\u201c${lineText(first)}\u201d (${STEM_NAME[lineStem(first)]}) and ` +
          `\u201c${lineText(other)}\u201d (${STEM_NAME[lineStem(other)]}). ` +
          `Voice them as separate takes.`,
      );
    }
    const opaque = wordsByRef.filter(([, words]) => words.length === 0).map(([ref]) => ref);
    if (opaque.length === 0) continue;
    const readable = wordsByRef.flatMap(([, words]) => words);
    if (readable.length === 0 && new Set(lines.map(lineStem)).size === 1) continue;
    const unmatched = apart.find((line) => !saysLine(definition, shot.id, readable, line));
    if (!unmatched) continue;
    throw new KonteError(
      "CUE_UNATTRIBUTED",
      `Animatic shot "${shot.id}" plays ${opaque.join(", ")}, a recording konte reads no words ` +
        `from, and no take it can read carries the line \u201c${lineText(unmatched)}\u201d. ` +
        `konte cannot tell whether the recording is that line (mixed into ` +
        `${STEM_NAME[lineStem(unmatched)]}, kept away from the motion model) or a sound in the ` +
        `frame (mixed into #stem). Voice the line with an adapter whose spoken-text input ` +
        `carries its words.`,
    );
  }
}

const STEM_NAME: Record<LineStem, string> = {
  stem: "#stem",
  narration: "#narrationStem",
  offFrame: "#offFrameStem",
};
