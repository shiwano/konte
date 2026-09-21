import { LANGUAGE_NAMES } from "../../typography.js";
import { formatCutTime } from "../prompt-structure.js";
import type { AdapterValidator } from "./validator.js";

/**
 * Which decode the adapter runs. R2V and R2I always take the six sections; R2A takes them only when
 * a reference is wired, and three named fields when none is.
 */
export type MinimaxH3Mode = "r2i" | "r2a" | "r2v";

export interface MinimaxH3PromptSpec {
  mode: MinimaxH3Mode;
  // The input holding the prompt. Omit it on an adapter with exactly one `"prompt"` input.
  prompt?: string;
  // The input holding the take's frame count, read at 24fps to bound the cut times. Omit it to
  // leave them unbounded.
  length?: string;
  // Every reference slot, for R2A to tell which of its two shapes applies. Ignored on the others.
  references?: readonly string[];
  // The input holding which frame of the burst is decoded, read at 24fps. R2I only: naming it is
  // what lets a description carry a cut.
  frameIndex?: string;
}

const SIX_SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;

const THREE_SECTIONS = [
  "integrated_multimodal_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;

const VISUAL_MARKERS = new Set([
  "fully_preserved",
  "partially_preserved",
  "attribute_transfer",
  "weak_reference",
]);

const AUDIO_MARKERS = new Set(["fully_copy", "partially_copy", "reference", "weak_reference"]);

// Which half of the reuse/reference choice a marker on an `<Audio N>` makes.
const COPY_MARKERS = new Set(["fully_copy", "partially_copy"]);
const REFERENCE_MARKERS = new Set(["reference", "weak_reference"]);

const AUDIO_TAG = "Audio";

/**
 * The model reads six named fields (three on a bare R2A) and everything else as prose. Written for
 * a prompt the adapter's `structure` assembles: the section headers, the task-type brackets, the
 * `[Shot N]` numbering and the cut-time format are rendered, so what is checked here is what the
 * author writes inside them, and what spans sections.
 */
export function minimaxH3Prompt(spec: MinimaxH3PromptSpec): AdapterValidator {
  const validator: AdapterValidator = (inputs, context) => {
    const promptInput = spec.prompt ?? context?.promptInput;
    if (promptInput === undefined) {
      return (
        `minimaxH3Prompt cannot tell which input holds the prompt: this adapter declares no ` +
        `\`"prompt"\` input, or more than one. Name it — \`minimaxH3Prompt({ prompt: "<input>", … })\`.`
      );
    }
    const value = inputs[promptInput];
    const prompt = typeof value === "string" ? value : "";
    // `""` is this input's own default, so it is present and no required check reaches it.
    if (prompt.trim() === "") {
      return `The prompt is empty — every mode is conditioned on it, and an empty one renders noise.`;
    }

    const { sections: expected, because } = expectedSections(spec, inputs);
    const sections = parseSections(prompt);
    const shape = checkShape(prompt, sections, expected, because);
    if (shape) return shape;

    const body = (name: string) => sections.find((s) => s.name === name)?.body ?? "";
    const sixSection = expected === SIX_SECTIONS;
    const descriptionName = sixSection
      ? "detailed_description"
      : "integrated_multimodal_description";
    const description = body(descriptionName);
    const soundscape = body("overall_soundscape");
    const music = body("non_diegetic_music");

    if (sixSection) {
      const labels = parseDeclaredLabels(body("subject_definitions"));
      const retentions = parseRetentionLines(body("retention_analysis"));

      const pairing = checkLabelPairing(labels, retentions);
      if (pairing) return pairing;

      const markers = checkMarkers(retentions);
      if (markers) return markers;

      const speaker = checkNoSpeakerIds(body("retention_analysis"));
      if (speaker) return speaker;

      const tasks = parseTaskTypes(body("summary"));
      const agreement = checkAudioAgreement(tasks, retentions);
      if (agreement) return agreement;

      const copy = checkFullyCopy(retentions, soundscape, music);
      if (copy) return copy;
    }

    const shots = checkShots(
      spec,
      description,
      sections.filter((s) => s.name !== descriptionName),
      frameCount(spec, inputs),
      inputs,
    );
    if (shots) return shots;

    return checkDialogueTags(prompt);
  };

  validator.inputs = [
    ...new Set([
      ...(spec.prompt ? [spec.prompt] : []),
      ...(spec.length ? [spec.length] : []),
      ...(spec.frameIndex ? [spec.frameIndex] : []),
      ...(spec.mode === "r2a" ? (spec.references ?? []) : []),
    ]),
  ];
  return validator;
}

/**
 * The span of an H3 prompt that names the frame a cut comes from: `[Shot 1]` of a
 * `detailed_description` that cuts to a `[Shot 2]`. Undefined where the description does not cut.
 * `promptReferenceTags`' `prevPanel.within`.
 */
export function minimaxH3CutSource(prompt: string): string | undefined {
  const description = parseSections(prompt).find((s) => s.name === "detailed_description")?.body;
  if (description === undefined) return undefined;
  const markers = [...description.matchAll(SHOT_MARKER)];
  const first = markers.find((m) => m[1] === "1");
  const second = markers.find((m) => m[1] === "2");
  if (first === undefined || second === undefined || second.index <= first.index) return undefined;
  return description.slice(first.index + first[0].length, second.index);
}

interface Section {
  name: string;
  body: string;
}

interface RetentionLine {
  label: string;
  tag: string;
  marker: string;
}

// R2A is the one mode whose shape is not fixed by the adapter, so a shape rejection there says
// which half it landed in and what moves it to the other.
function expectedSections(
  spec: MinimaxH3PromptSpec,
  inputs: Readonly<Record<string, unknown>>,
): { sections: typeof SIX_SECTIONS | typeof THREE_SECTIONS; because?: string } {
  if (spec.mode !== "r2a") return { sections: SIX_SECTIONS };
  const wired = (spec.references ?? []).filter((name) => inputs[name] !== undefined);
  if (wired.length === 0) {
    return {
      sections: THREE_SECTIONS,
      because:
        "R2A takes these three while no reference is wired. Wire one and it takes the six sections instead.",
    };
  }
  return {
    sections: SIX_SECTIONS,
    because:
      `R2A takes the six sections because a reference is wired (${wired.join(", ")}). With none it ` +
      `takes "integrated_multimodal_description", "overall_soundscape", "non_diegetic_music" instead.`,
  };
}

const SECTION_HEADER = /^([a-z][a-z_]*):[ \t]?/;

const FIELD_NAMES: ReadonlySet<string> = new Set<string>([...SIX_SECTIONS, ...THREE_SECTIONS]);

// Only the model's own field names open a section. A body line may lead with a colon of its own
// ("foreground: …"), and reading that as a seventh field would reject prose the model reads fine.
function parseSections(prompt: string): Section[] {
  const sections: Section[] = [];
  let current: { name: string; lines: string[] } | undefined;
  for (const line of prompt.split("\n")) {
    const match = SECTION_HEADER.exec(line);
    if (match && FIELD_NAMES.has(match[1]!)) {
      if (current) sections.push({ name: current.name, body: current.lines.join("\n").trim() });
      current = { name: match[1]!, lines: [line.slice(match[0].length)] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push({ name: current.name, body: current.lines.join("\n").trim() });
  return sections;
}

// A colon-led name that is not a field name but is within a typo's distance of a missing one.
function nearMisses(prompt: string, missing: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of prompt.split("\n")) {
    const match = SECTION_HEADER.exec(line);
    const name = match?.[1];
    if (name === undefined || FIELD_NAMES.has(name)) continue;
    if (missing.some((want) => editDistance(want, name) <= 2)) found.push(name);
  }
  return found;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length]!;
}

function checkShape(
  prompt: string,
  sections: readonly Section[],
  expected: readonly string[],
  because: string | undefined,
): string | undefined {
  const found = sections.map((s) => s.name);
  const shape = () =>
    `The shape is:\n${expected.map((name) => `  ${name}:`).join("\n")}` +
    (because ? `\n${because}` : "");

  const unknown = found.filter((name) => !expected.includes(name));
  if (unknown.length > 0) {
    return (
      `The prompt names ${unknown.map((n) => `"${n}"`).join(", ")}, which this model does not read — ` +
      `an unnamed field is read as prose. ${shape()}`
    );
  }

  const missing = expected.filter((name) => !found.includes(name));
  if (missing.length > 0) {
    const misspelt = nearMisses(prompt, missing);
    return (
      `The prompt is missing ${missing.map((n) => `"${n}"`).join(", ")}.` +
      (misspelt.length > 0
        ? ` It does carry ${misspelt.map((n) => `"${n}:"`).join(", ")}, which the model reads as prose.`
        : "") +
      ` ${shape()}`
    );
  }

  const duplicated = found.filter((name, i) => found.indexOf(name) !== i);
  if (duplicated.length > 0) {
    return `${[...new Set(duplicated)].map((n) => `"${n}"`).join(", ")} appears more than once — each section is written once. ${shape()}`;
  }

  if (found.join("\n") !== expected.join("\n")) {
    return `The sections are written out of order (${found.join(", ")}). ${shape()}`;
  }

  const empty = sections.filter((s) => s.body === "").map((s) => s.name);
  if (empty.length > 0) {
    return (
      `${empty.map((n) => `"${n}"`).join(", ")} ${empty.length === 1 ? "is" : "are"} empty — ` +
      `write \`N/A\` for a section this take has nothing for.`
    );
  }
}

const LABEL_AT_LINE_START = /^<\s*(Subject|Picture|Video|Audio)\s+(\d+)\s*>/;

// A label is declared by the line that opens on it. One cited mid-line — the sheet a `<Subject N>`
// takes its costume from — is a citation, and the guide gives it no line of its own.
function parseDeclaredLabels(body: string): string[] {
  const labels: string[] = [];
  for (const line of body.split("\n")) {
    const match = LABEL_AT_LINE_START.exec(line.trim());
    if (match) labels.push(`<${match[1]} ${match[2]}>`);
  }
  return labels;
}

const RETENTION_LINE =
  /^<\s*(Subject|Picture|Video|Audio)\s+(\d+)\s*>\s*(?:\([^)]*\))?\s*:\s*(\S+)/;

function parseRetentionLines(body: string): RetentionLine[] {
  const lines: RetentionLine[] = [];
  for (const line of body.split("\n")) {
    const match = RETENTION_LINE.exec(line.trim());
    if (match)
      lines.push({ label: `<${match[1]} ${match[2]}>`, tag: match[1]!, marker: match[3]! });
  }
  return lines;
}

function checkLabelPairing(
  labels: readonly string[],
  retentions: readonly RetentionLine[],
): string | undefined {
  const retained = retentions.map((r) => r.label);

  const unretained = labels.filter((label) => !retained.includes(label));
  if (unretained.length > 0) {
    const one = unretained.length === 1;
    return (
      `${unretained.join(", ")} ${one ? "is" : "are"} defined in "subject_definitions" but ` +
      `${one ? "has" : "have"} no line in "retention_analysis", which takes one line per label. ` +
      `Write what the take keeps of ${one ? "it" : "them"}, or drop the definition.`
    );
  }

  const undeclared = retained.filter((label) => !labels.includes(label));
  if (undeclared.length > 0) {
    return (
      `"retention_analysis" names ${undeclared.join(", ")}, which no line of "subject_definitions" ` +
      `defines. A label is defined by the line that opens on it — one cited inside another label's ` +
      `definition takes no line of its own, and no retention line either.`
    );
  }

  const seen = new Set<string>();
  for (const label of retained) {
    if (seen.has(label)) {
      return `"retention_analysis" gives ${label} more than one line — each label takes exactly one.`;
    }
    seen.add(label);
  }
}

function checkMarkers(retentions: readonly RetentionLine[]): string | undefined {
  for (const { label, tag, marker } of retentions) {
    const allowed = tag === AUDIO_TAG ? AUDIO_MARKERS : VISUAL_MARKERS;
    if (allowed.has(marker)) continue;
    const other = tag === AUDIO_TAG ? VISUAL_MARKERS : AUDIO_MARKERS;
    const crossed = other.has(marker)
      ? ` It is the marker set of ${tag === AUDIO_TAG ? "visible content" : "an <Audio N>"}, which this label is not.`
      : "";
    return (
      `${label} takes the marker "${marker}", which is not one ${tag === AUDIO_TAG ? "an <Audio N>" : "visible content"} ` +
      `carries: ${[...allowed].join(", ")}.${crossed}`
    );
  }
}

const SPEAKER_ID = /\(S\d+(?:\s*,\s*S\d+)*\)/;

function checkNoSpeakerIds(body: string): string | undefined {
  const match = SPEAKER_ID.exec(body);
  if (!match) return;
  return (
    `"retention_analysis" carries the speaker id ${match[0]}, which never appears there — it is ` +
    `written in "subject_definitions" and at the vocal event in the description.`
  );
}

const TASK_PREFIX = /^\[([^\]]*)\]/;

function parseTaskTypes(summary: string): string[] {
  const match = TASK_PREFIX.exec(summary.trim());
  return match ? match[1]!.split("+").map((t) => t.trim()) : [];
}

// The guide writes the reuse/reference choice in three places; the two mechanical ones are checked
// here.
function checkAudioAgreement(
  tasks: readonly string[],
  retentions: readonly RetentionLine[],
): string | undefined {
  const audio = retentions.filter((r) => r.tag === AUDIO_TAG);
  const copies = audio.filter((r) => COPY_MARKERS.has(r.marker));
  const references = audio.filter((r) => REFERENCE_MARKERS.has(r.marker));
  const reuse = tasks.includes("audio reuse");
  const reference = tasks.includes("audio reference");

  if (reuse && copies.length === 0) {
    return (
      `"summary" claims "audio reuse", but no <Audio N> is marked ${[...COPY_MARKERS].join(" or ")} — ` +
      `reuse hands back the passed recording, and its marker is what says so.`
    );
  }
  if (reference && references.length === 0) {
    return (
      `"summary" claims "audio reference", but no <Audio N> is marked ${[...REFERENCE_MARKERS].join(" or ")} — ` +
      `a reference take is spoken by the model in the passed timbre, and its marker is what says so.`
    );
  }
  if (copies.length > 0 && !reuse) {
    return (
      `${copies.map((r) => r.label).join(", ")} is marked "${copies[0]!.marker}", which reuses the ` +
      `passed recording — so "summary" takes "audio reuse" alongside its other task types.`
    );
  }
  if (references.length > 0 && !reference) {
    return (
      `${references.map((r) => r.label).join(", ")} is marked "${references[0]!.marker}", which takes ` +
      `the timbre and lets the model speak the line — so "summary" takes "audio reference" alongside ` +
      `its other task types.`
    );
  }
}

function checkFullyCopy(
  retentions: readonly RetentionLine[],
  soundscape: string,
  music: string,
): string | undefined {
  const copied = retentions.find((r) => r.marker === "fully_copy");
  if (!copied) return;
  const written = [
    ...(isNotApplicable(soundscape) ? [] : ["overall_soundscape"]),
    ...(isNotApplicable(music) ? [] : ["non_diegetic_music"]),
  ];
  if (written.length === 0) return;
  return (
    `${copied.label} is marked "fully_copy", which claims the whole delivered track — so nothing ` +
    `else sounds, and ${written.map((n) => `"${n}"`).join(" and ")} ${written.length === 1 ? "is" : "are"} ` +
    `written. Take "partially_copy" for a copy with room tone, a score or a second voice around it.`
  );
}

function isNotApplicable(body: string): boolean {
  return body.trim() === "N/A";
}

const SHOT_MARKER = /\[Shot (\d+)\]\s*(At (\d+):(\d{2})\.(\d{3}),)?/g;

const SHOT_REFERENCE = /\[Shot (\d+)\]/g;

function checkShots(
  spec: MinimaxH3PromptSpec,
  description: string,
  otherSections: readonly Section[],
  frames: number | undefined,
  inputs: Readonly<Record<string, unknown>>,
): string | undefined {
  const shots = [...description.matchAll(SHOT_MARKER)].map((m) => ({
    number: Number(m[1]),
    at: m[2] ? Number(m[3]) * 60 + Number(m[4]) + Number(m[5]) / 1000 : undefined,
  }));

  // The rendered markers run 1, 2, 3 …, so one out of step is one the author wrote into a shot.
  const stray = shots.find((shot, i) => shot.number !== i + 1);
  if (stray) {
    return (
      `A shot's text carries \`[Shot ${stray.number}]\`. Every \`[Shot N]\` in the description opens a ` +
      `shot, so one written to refer to another reads as that shot beginning again — name it in ` +
      `words instead ("the frame it cuts from").`
    );
  }

  for (const section of otherSections) {
    for (const match of section.body.matchAll(SHOT_REFERENCE)) {
      if (Number(match[1]) <= shots.length) continue;
      return (
        `"${section.name}" names \`[Shot ${match[1]}]\`, and the description has ` +
        `${shots.length} shot${shots.length === 1 ? "" : "s"}.`
      );
    }
  }

  let previous = 0;
  for (const shot of shots.slice(1)) {
    if (shot.at === undefined) {
      return `\`[Shot ${shot.number}]\` carries no cut time konte can read — \`at\` is seconds into the take.`;
    }
    if (shot.at <= previous) {
      return (
        `\`[Shot ${shot.number}]\` cuts at ${formatCutTime(shot.at)}, which is not after ` +
        `${formatCutTime(previous)} — the cut times rise strictly through the take.`
      );
    }
    previous = shot.at;
    if (frames !== undefined && shot.at >= frames / 24) {
      return (
        `\`[Shot ${shot.number}]\` cuts at ${formatCutTime(shot.at)}, and this take runs ` +
        `${formatCutTime(frames / 24)} (${frames} frames at 24fps) — a cut the take never reaches.`
      );
    }
  }

  if (spec.mode === "r2i" && shots.length > 1)
    return checkKeptFrameIsPastCut(spec, previous, frames, inputs);
}

/**
 * R2I decodes the whole burst and keeps one frame of it, so a description that carries a cut is
 * only meaningful when the kept frame lands past the last one.
 */
function checkKeptFrameIsPastCut(
  spec: MinimaxH3PromptSpec,
  lastCut: number,
  frames: number | undefined,
  inputs: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!spec.frameIndex) {
    return (
      `The description carries a cut, and R2I keeps one frame of the burst — so which frame that ` +
      `is has to be checked against the cut, and this adapter names no frame input. Declare it — ` +
      `\`minimaxH3Prompt({ frameIndex: "<input>", … })\` — or write the instant as a single \`[Shot 1]\`.`
    );
  }
  const value = inputs[spec.frameIndex];
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  // The index is clamped to the burst's last frame, so an index past the end keeps a frame EARLIER
  // than the one asked for — reading the request rather than the clamp would pass a cut nothing
  // lands after.
  const last = frames === undefined ? undefined : frames - 1;
  const kept = last === undefined ? value : Math.min(value, last);
  if (kept / 24 > lastCut) return;

  const asked = kept === value ? "" : ` (\`${spec.frameIndex}: ${value}\` clamps to it)`;
  if (last !== undefined && last / 24 <= lastCut) {
    return (
      `The last cut is at ${formatCutTime(lastCut)}, and this take's last frame is ${last} ` +
      `(${formatCutTime(last / 24)}) — no frame of the burst lands after that cut. Move the cut ` +
      `earlier, or take the next \`length\` rung up.`
    );
  }
  // The first frame the cut has passed. A 22-frame burst also names where to land; on any other
  // length the author picks.
  const first = Math.floor(lastCut * 24) + 1;
  const take =
    frames === 22 && first < 20
      ? `Take \`${spec.frameIndex}: 20\`, or any frame from ${first} up`
      : `Take a frame from ${first} up`;
  return (
    `\`${spec.frameIndex}\` keeps frame ${kept}${asked} (${formatCutTime(kept / 24)}), and the last ` +
    `cut is at ${formatCutTime(lastCut)} — that frame is still in the shot the take cuts away from. ` +
    `${take}.`
  );
}

const DIALOGUE = /<d>([\s\S]*?)<\/d>/g;

// The words of a `<d>`, its language tag dropped — declared as an H3 adapter's `spokenTextPattern`.
// The tag is mandatory (`checkDialogueTags`), so an untagged `<d>` never reaches this.
export const minimaxH3Dialogue = /<d>\s*\[[^\]]+\]\s*([\s\S]*?)<\/d>/g;
const DIALOGUE_OPEN = /<d>/g;
const LANGUAGE_TAG = /^\s*\[([^\]]+)\]\s*\S/;

// The tag names its language in English, and the set it names from is the one `policy.lang` offers
// — a line konte cannot typeset is not one to voice either. Eleven of them are the model's stable
// ones and the rest carry to varying degrees; the guide says which.
const LANGUAGE_NAME_LIST = Object.values(LANGUAGE_NAMES).sort();
const LANGUAGE_NAME_SET: ReadonlySet<string> = new Set(LANGUAGE_NAME_LIST);

function checkDialogueTags(prompt: string): string | undefined {
  const spoken = [...prompt.matchAll(DIALOGUE)];
  const opened = [...prompt.matchAll(DIALOGUE_OPEN)];
  if (opened.length !== spoken.length) {
    return `A \`<d>\` in the prompt is never closed — a spoken line is written \`<d>[English] …</d>\`.`;
  }
  for (const line of spoken) {
    const tag = LANGUAGE_TAG.exec(line[1]!);
    if (!tag) {
      return (
        `The spoken line \`<d>${line[1]!.trim()}</d>\` carries no language tag — a \`<d>\` holds the ` +
        `language and the words, and nothing else: \`<d>[English] …</d>\`.`
      );
    }
    const language = tag[1]!.trim();
    if (LANGUAGE_NAME_SET.has(language)) continue;
    return (
      `The spoken line \`<d>[${language}] …</d>\` names no language konte carries. The tag is one ` +
      `of: ${LANGUAGE_NAME_LIST.join(", ")}.`
    );
  }
}

function frameCount(
  spec: MinimaxH3PromptSpec,
  inputs: Readonly<Record<string, unknown>>,
): number | undefined {
  if (!spec.length) return undefined;
  const value = inputs[spec.length];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
