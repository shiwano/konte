// The prompt check: the machine floor under what an author writes into a `"prompt"` or
// `"negativePrompt"` input. It reads the values a stage declared and reports the negations among
// them — a model conditions on what a prompt names, so naming what must be absent is what puts it
// in the picture, and a negation inside a negativePrompt re-admits what that input excludes. Free
// of any DSL/runtime import (like direction-check.ts) so the gate, status and unit tests can pull
// it in standalone. English only.

import type { Finding, SourceFile } from "./finding.js";

/**
 * The codes this check reports.
 *   - prompt-negation: the prompt names something to leave out.
 *   - prompt-not-yet: the prompt describes what has not happened — time talk in a still frame, or a
 *     motion prompt written as a state to hold rather than a move to make.
 *   - prompt-double-negative: a negativePrompt names an exclusion negatively ("no watermark"),
 *     which cancels it.
 */
export const PROMPT_FINDING_CODES = [
  "prompt-negation",
  "prompt-not-yet",
  "prompt-double-negative",
] as const;

export type PromptFindingCode = (typeof PROMPT_FINDING_CODES)[number];

// One `"prompt"` / `"negativePrompt"` / `"spokenText"` input's value, as declared at one address.
// `negative` marks the second kind, which reverses which phrasing is the finding; `spoken` the
// third, collected for listing but never checked. `exemptions` are the declaring adapter's
// (`promptExemptions`); `script` is the direction's spoken lines, a line quoted verbatim cut out
// before the value is read. `spokenWithin` holds the words a `"prompt"` value carries for a model
// that takes its lines there (`spokenTextPattern`) — the value stays a prompt and is checked as one.
export type PromptOccurrence = {
  address: string;
  input: string;
  value: string;
  negative?: true;
  spoken?: true;
  spokenWithin?: readonly string[];
  // The marked text each `spokenWithin` span was written inside, in the same order.
  spokenMarks?: readonly string[];
  exemptions?: readonly RegExp[];
  script?: readonly string[];
};

// The words a take at one address speaks: a `"spokenText"` input's whole value, or the spans a
// prompt-borne model's lines were marked at (`spokenTextPattern`). Read at the address itself, never
// through what it is built from: a mix or a trim carries its inputs' lines only second-hand.
export function spokenLinesAt(occurrences: readonly PromptOccurrence[], address: string): string[] {
  const out: string[] = [];
  for (const p of occurrences) {
    if (p.address !== address) continue;
    if (p.spoken) out.push(p.value);
    else out.push(...(p.spokenWithin ?? []));
  }
  return out;
}

// The unit is the phrase: one finding per address would bury the distinct phrases behind a style
// constant thirty prompts share. `addresses` is where the phrase is written, in declaration order.
export type PromptFinding = {
  code: PromptFindingCode;
  phrase: string;
  addresses: readonly string[];
};

// A clause — the unit a finding is keyed at, and what reappears verbatim across prompts.
const CLAUSE_SEPARATOR = /[,;:.!?\n]+/;

const NEGATION =
  /\b(?:no|not|never|without|nothing|nobody|none|neither|nor|cannot|(?:free|empty|devoid)\s+of|\w+n['’]t)\b/i;

// "not yet" and the perfect it is usually written in ("has not moved", "Neither has moved yet").
const NOT_YET = /\byet\b/i;
const PERFECT_NEGATIVE = /\b(?:has|have|had)\s+not\b|\b(?:has|have|had)n['’]t\b/i;

// A size limit: `no longer than 4 seconds` bounds a value. Cut before the vocabulary runs, so the
// rest of the clause is still scanned.
const COMPARATIVE =
  /\bno\s+(?:bigger|taller|longer|wider|smaller|shorter|more|less|later|further)\s+than\b/gi;

// A set phrase whose negation word excludes nothing: `not only X but also Y`, `no matter the weather`.
const IDIOM = /\bnot\s+only\b|\bno\s+(?:matter|doubt)\b/gi;

// Everything an exemption, the comparative or the idiom rule takes out of a clause before the vocabulary reads
// it. Each pattern is rebuilt global: an adapter's `/does not move/` must clear every occurrence,
// not the first.
function strip(clause: string, patterns: readonly RegExp[]): string {
  let out = clause;
  for (const pattern of patterns) {
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    out = out.replace(global, " ");
  }
  return out;
}

// One line as it may be written into a prompt: its own words, tolerant of the rewrapping a prompt
// puts them through. Null for a blank line, which would match everywhere.
function linePattern(line: string): RegExp | null {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(pattern, "g");
}

// A quoted line is the model's words rather than the author's, so it is cut before the clause split
// — but only out of the spans the adapter marks as where its model's lines are written
// (`spokenTextPattern`), and spliced back through the MARKED text so a one-word line is cut where it
// is quoted and nowhere else. Cutting it from the value at large is what makes a line like "no" or
// "wait" strip that word out of every prompt in the stage, spoken or not. A model whose lines konte
// cannot locate marks nothing and gets no cut: the words are the author's until an adapter says
// where its model's are.
function cutScript(occurrence: PromptOccurrence): string {
  const marks = occurrence.spokenMarks ?? occurrence.spokenWithin ?? [];
  const script = occurrence.script ?? [];
  if (marks.length === 0 || script.length === 0) return occurrence.value;
  let out = occurrence.value;
  for (const mark of marks) {
    const cleaned = script.reduce((text, line) => {
      const pattern = linePattern(line);
      return pattern ? text.replace(pattern, " ") : text;
    }, mark);
    if (cleaned !== mark) out = out.split(mark).join(cleaned);
  }
  return out;
}

// One finding per phrase, with its casing and spacing taken out — every way it was typed.
function phraseKey(code: PromptFindingCode, phrase: string): string {
  return `${code}:${phrase.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

// The clauses of one prompt value that a negation survives, each with the class it falls in.
function findingsIn(
  occurrence: PromptOccurrence,
): Array<{ code: PromptFindingCode; phrase: string }> {
  const out: Array<{ code: PromptFindingCode; phrase: string }> = [];
  const exemptions = [COMPARATIVE, IDIOM, ...(occurrence.exemptions ?? [])];
  const value = cutScript(occurrence);
  for (const clause of value.split(CLAUSE_SEPARATOR)) {
    const phrase = clause.replace(/\s+/g, " ").trim();
    if (phrase === "") continue;
    const scanned = strip(phrase, exemptions);
    if (!NEGATION.test(scanned)) continue;
    const code: PromptFindingCode = occurrence.negative
      ? "prompt-double-negative"
      : NOT_YET.test(scanned) || PERFECT_NEGATIVE.test(scanned)
        ? "prompt-not-yet"
        : "prompt-negation";
    out.push({ code, phrase });
  }
  return out;
}

// Reports findings; it never throws and never decides severity — the gates own that.
export function checkPrompts(occurrences: readonly PromptOccurrence[]): PromptFinding[] {
  const byKey = new Map<string, PromptFinding & { addresses: string[] }>();
  for (const occurrence of occurrences) {
    if (occurrence.spoken) continue;
    for (const { code, phrase } of findingsIn(occurrence)) {
      const key = phraseKey(code, phrase);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.addresses.includes(occurrence.address)) {
          existing.addresses.push(occurrence.address);
        }
        continue;
      }
      byKey.set(key, { code, phrase, addresses: [occurrence.address] });
    }
  }
  return [...byKey.values()];
}

const PHRASE_DISPLAY_LIMIT = 80;
const ADDRESS_DISPLAY_LIMIT = 3;

function displayPhrase(phrase: string): string {
  return phrase.length > PHRASE_DISPLAY_LIMIT
    ? `${phrase.slice(0, PHRASE_DISPLAY_LIMIT - 1)}…`
    : phrase;
}

function formatAddresses(addresses: readonly string[]): string {
  const shown = addresses.slice(0, ADDRESS_DISPLAY_LIMIT).join(", ");
  const hidden = addresses.length - ADDRESS_DISPLAY_LIMIT;
  return `${shown}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

export function formatPromptFinding(finding: PromptFinding): string {
  return `"${displayPhrase(finding.phrase)}" — ${formatAddresses(finding.addresses)}`;
}

// What a stage or a patch declares for the check to read: the prompt values it built.
export type PromptCheckSubject = {
  prompts?: readonly PromptOccurrence[];
};

// What to do about a finding, by the polarity of the input it was written in.
const REMEDY: Record<PromptFindingCode, string> = {
  "prompt-negation": "describe what occupies the space instead of naming what to leave out",
  "prompt-not-yet": "describe the state the frame is in instead of what has not happened",
  "prompt-double-negative":
    "a negativePrompt is already the exclusion — keep the term, drop the negation",
};

// The findings in the prompts `subject` declares, fixed in `fixIn` — the file that writes them.
// `signedOff` is whether an address's accepted take was drawn from its definition as it stands.
export function promptFindings(
  subject: PromptCheckSubject,
  fixIn: SourceFile,
  signedOff: (address: string) => boolean = () => false,
): Finding[] {
  return checkPrompts(subject.prompts ?? []).map((f) => {
    const accepted = fixIn.patch === undefined ? f.addresses.filter(signedOff) : [];
    const live = f.addresses.filter((address) => !accepted.includes(address));
    return {
      code: f.code,
      subject: `"${displayPhrase(f.phrase)}"`,
      fixIn,
      message:
        live.length > 0
          ? `${formatAddresses(live)} — ${REMEDY[f.code]}`
          : `${formatAddresses(accepted)} — accepted as drawn; ${REMEDY[f.code]} before drawing it again`,
      // A patch's prompt is the patch's alone.
      targets: fixIn.patch === undefined ? live : [],
      ...(accepted.length > 0 ? { signedOff: accepted } : {}),
    };
  });
}
