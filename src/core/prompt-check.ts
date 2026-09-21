// The prompt check: the machine floor under what an author writes into a `"prompt"` or
// `"negativePrompt"` input. It reads the values a stage declared and reports the negations among
// them — a model conditions on what a prompt names, so naming what must be absent is what puts it
// in the picture, and a negation inside a negativePrompt re-admits what that input excludes. Free
// of any DSL/runtime import (like direction-check.ts) so the gate, status and unit tests can pull
// it in standalone. English only.

import { KonteError } from "./errors.js";
import {
  STAGE_FINDING_CODES,
  unknownWaiverKeys,
  waiverKey,
  type StageFindingCode,
} from "./waiver-keys.js";

/**
 * The classes this check reports, its slice of the waiver namespace (see waiver-keys.ts).
 *   - prompt-negation: the prompt names something to leave out.
 *   - prompt-not-yet: the prompt describes what has not happened — time talk in a still frame, or a
 *     motion prompt written as a state to hold rather than a move to make.
 *   - prompt-double-negative: a negativePrompt names an exclusion negatively ("no watermark"),
 *     which cancels it.
 */
export type PromptFindingCode = Extract<StageFindingCode, `prompt-${string}`>;

const FINDING_CODES: readonly PromptFindingCode[] = STAGE_FINDING_CODES.filter(
  (code): code is PromptFindingCode => code.startsWith("prompt-"),
);

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
  key: string;
  phrase: string;
  addresses: readonly string[];
};

type PromptStaleWaiver = { key: string; reason: string };

type PromptCheckResult = {
  active: PromptFinding[];
  waived: PromptFinding[];
  // A waiver whose phrase is gone — the prompt was rewritten and the reason now cancels nothing.
  staleWaivers: PromptStaleWaiver[];
  // A key whose code half names no finding class: a typo that can never cancel anything.
  unknownWaivers: string[];
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

// Keyed on the phrase with its casing and spacing taken out — one waiver covers every way it was
// typed.
export function promptWaiverKey(code: PromptFindingCode, phrase: string): string {
  return waiverKey(code, phrase.toLowerCase().replace(/\s+/g, " ").trim());
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

// Reports findings; it never throws and never decides severity — the caller (the spend gate,
// status) owns waivers and abort policy.
export function checkPrompts(
  occurrences: readonly PromptOccurrence[],
  waivers: Readonly<Record<string, string>> = {},
): PromptCheckResult {
  const byKey = new Map<string, PromptFinding & { addresses: string[] }>();
  for (const occurrence of occurrences) {
    if (occurrence.spoken) continue;
    for (const { code, phrase } of findingsIn(occurrence)) {
      const key = promptWaiverKey(code, phrase);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.addresses.includes(occurrence.address)) {
          existing.addresses.push(occurrence.address);
        }
        continue;
      }
      byKey.set(key, { code, key, phrase, addresses: [occurrence.address] });
    }
  }

  const active: PromptFinding[] = [];
  const waived: PromptFinding[] = [];
  for (const finding of byKey.values()) {
    (finding.key in waivers ? waived : active).push(finding);
  }

  const unknownWaivers = unknownWaiverKeys(waivers);
  const staleWaivers: PromptStaleWaiver[] = [];
  for (const [key, reason] of Object.entries(waivers)) {
    // Another check's class, not this one's: its own gate answers for it.
    if (!FINDING_CODES.includes(key.slice(0, key.indexOf(":")) as PromptFindingCode)) continue;
    if (!byKey.has(key)) staleWaivers.push({ key, reason });
  }

  return { active, waived, staleWaivers, unknownWaivers };
}

const PHRASE_DISPLAY_LIMIT = 80;
const ADDRESS_DISPLAY_LIMIT = 3;

export function formatPromptFinding(finding: PromptFinding): string {
  const phrase =
    finding.phrase.length > PHRASE_DISPLAY_LIMIT
      ? `${finding.phrase.slice(0, PHRASE_DISPLAY_LIMIT - 1)}…`
      : finding.phrase;
  const shown = finding.addresses.slice(0, ADDRESS_DISPLAY_LIMIT).join(", ");
  const hidden = finding.addresses.length - ADDRESS_DISPLAY_LIMIT;
  return `"${phrase}" — ${shown}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

// What a stage or a patch declares for the check to read: the prompt values it built, and the
// waivers standing against them.
export type PromptCheckSubject = {
  prompts?: readonly PromptOccurrence[];
  waivers?: Readonly<Record<string, string>>;
};

// What to do about a finding, by the polarity of the input it was written in.
const REMEDY: Record<PromptFindingCode, string> = {
  "prompt-negation":
    "a model conditions on what the prompt names, so describe what occupies the space instead of naming what to leave out",
  "prompt-not-yet":
    "a model conditions on what the prompt names, so describe the state the frame is in instead of what has not happened",
  "prompt-double-negative":
    "a negativePrompt is already the exclusion, so a negation inside it re-admits what it names — keep the term, drop the negation",
};

// The gate: abort with PROMPT_CHECK_FAILED when a prompt about to be spent on still names an
// exclusion. `where` is the file that holds both the prompts and their waivers.
export function assertPromptGate(subject: PromptCheckSubject, where: string): void {
  const { active, unknownWaivers } = checkPrompts(subject.prompts ?? [], subject.waivers ?? {});

  if (unknownWaivers.length > 0) {
    throw new KonteError(
      "PROMPT_CHECK_FAILED",
      `${where} declares ${unknownWaivers.length} waiver(s) whose key names no finding class — ` +
        `a key is the one \`status\` prints, \`<code>:<hash>\`:\n${unknownWaivers
          .map((key) => `  [${key}]`)
          .join("\n")}`,
    );
  }

  if (active.length === 0) return;

  // Grouped by remedy, in the fixed order of the finding contract, so a stage mixing the two
  // polarities is told both things once rather than per line.
  const blocks = FINDING_CODES.flatMap((code) => {
    const findings = active.filter((f) => f.code === code);
    if (findings.length === 0) return [];
    return [
      `  ${REMEDY[code]}:\n${findings
        .map((f) => `    [${f.key}] ${formatPromptFinding(f)}`)
        .join("\n")}`,
    ];
  });

  throw new KonteError(
    "PROMPT_CHECK_FAILED",
    `${where} has ${active.length} unresolved prompt finding(s). Fix each, or add a reason to ` +
      `\`waivers\` in ${where} when the phrasing is how this model is meant to be written:\n` +
      blocks.join("\n"),
  );
}
