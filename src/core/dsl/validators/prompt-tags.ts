import { tryParseAddress } from "../../address.js";
import { parsePlaceholder } from "../shot-context.js";
import type { AdapterValidator } from "./validator.js";

/**
 * The slots one prompt tag numbers, in the order the model numbers them. A plain array is
 * exhaustive: every wired slot has to be named. `exhaustive: false` drops that half — either because
 * naming a reference is the author's call (Qwen Image Edit's `image 1` need not appear in a
 * local-edit delta), or because the count is only a ceiling (a silent reference clip carries no
 * `<Audio N>`).
 */
export type PromptTagSlots = readonly string[] | { slots: readonly string[]; exhaustive: false };

export interface PromptReferenceTagsSpec {
  // The input name holding the prompt. Omit it on an adapter with exactly one `"prompt"` input —
  // that one is the default; name it only where two or more could be meant.
  prompt?: string;
  // How the model writes an ordinal. `"bracketed"` (the default) is `<Picture 1>`, counted anywhere
  // and case-sensitively, plus the bare form on the first line — the one place H3's alignment line
  // drops the brackets. `"bare"` is prose (`image 1`), counted anywhere and case-insensitively,
  // since a sentence may open on it and there is no bracket to tell it from prose.
  form?: "bracketed" | "bare";
  // Tag name as written in the prompt (`Picture` for `<Picture 1>`) → the slots it numbers.
  tags: Readonly<Record<string, PromptTagSlots>>;
  // Another shot's panel passed to one of `tag`'s slots is the frame the take cuts from. At most one
  // may be passed, and its ordinal has to appear in the span `within` returns — `undefined` when the
  // prompt has no place for that frame.
  prevPanel?: {
    tag: string;
    within: (prompt: string) => string | undefined;
  };
}

interface TagGroup {
  tag: string;
  slots: readonly string[];
  exhaustive: boolean;
}

interface SlotRun {
  // The slots of one numbered family (`image1`…`image9`), ordered by suffix.
  slots: readonly string[];
  // Their suffixes, in the same order.
  indices: readonly number[];
}

/**
 * Rejects a prompt whose reference ordinals do not match the references actually wired.
 *
 * A model that tags its references by ordinal (`<Picture N>`) numbers them by the order the wired
 * ones survive, not by slot — so an ordinal with nothing behind it silently lands on another
 * reference. Slots of one numbered family must also fill upward, since a gap renumbers everything
 * above it.
 */
export function promptReferenceTags(spec: PromptReferenceTagsSpec): AdapterValidator {
  const groups: TagGroup[] = Object.entries(spec.tags).map(([tag, entry]) => ({
    tag,
    ...normalizeSlots(entry),
  }));
  const runs = deriveRuns(groups.flatMap((g) => g.slots));
  assertContiguousRuns(runs);
  const form = spec.form ?? "bracketed";
  const prevPanel = spec.prevPanel;
  const prevPanelGroup = prevPanel && groups.find((g) => g.tag === prevPanel.tag);
  if (prevPanel && !prevPanelGroup) {
    throw new Error(`prevPanel names tag "${prevPanel.tag}", which \`tags\` does not declare`);
  }

  const validator: AdapterValidator = (inputs, context) => {
    for (const run of runs) {
      const gap = checkNoGap(run, inputs);
      if (gap) return gap;
    }
    // Which input holds the prompt is the adapter's own shape, and getting it wrong is silent: an
    // unresolvable name reads as an empty prompt, so every wired slot would be reported as unnamed.
    const promptInput = spec.prompt ?? context?.promptInput;
    if (promptInput === undefined) {
      return (
        `promptReferenceTags cannot tell which input holds the prompt: this adapter declares no ` +
        `\`"prompt"\` input, or more than one. Name it — \`promptReferenceTags({ prompt: "<input>", … })\`.`
      );
    }
    const promptValue = inputs[promptInput];
    const prompt = typeof promptValue === "string" ? promptValue : "";
    for (const group of groups) {
      const mismatch = checkOrdinals(group, prompt, inputs, form);
      if (mismatch) return mismatch;
    }
    if (prevPanel && prevPanelGroup) {
      return checkPrevPanel(
        prevPanelGroup,
        prevPanel.within,
        prompt,
        inputs,
        form,
        context?.shotId,
      );
    }
  };
  validator.inputs = [
    ...groups.flatMap((group) => group.slots),
    ...(spec.prompt ? [spec.prompt] : []),
  ];
  return validator;
}

function normalizeSlots(entry: PromptTagSlots): { slots: readonly string[]; exhaustive: boolean } {
  return "slots" in entry
    ? { slots: entry.slots, exhaustive: false }
    : { slots: entry, exhaustive: true };
}

const NUMBERED_SLOT = /^(.+?)(\d+)$/;

// The numbered families among the declared slots (`image1`…`image9`), each ordered by suffix. A
// lone member is not a family — nothing can gap.
function deriveRuns(names: readonly string[]): SlotRun[] {
  const byBase = new Map<string, { index: number; name: string }[]>();
  for (const name of new Set(names)) {
    const match = NUMBERED_SLOT.exec(name);
    if (!match) continue;
    const base = match[1]!;
    const list = byBase.get(base) ?? [];
    list.push({ index: Number(match[2]), name });
    byBase.set(base, list);
  }

  const runs: SlotRun[] = [];
  for (const list of byBase.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.index - b.index);
    runs.push({
      slots: list.map((entry) => entry.name),
      indices: list.map((entry) => entry.index),
    });
  }
  return runs;
}

// A family the adapter itself declared with a hole (`image1`, `image3`) would make the fill-upward
// check vacuous — both wired, nothing absent between them. An adapter bug, so it is raised where the
// adapter is declared, like `assertComfyInputs`. The numbering may start anywhere; only gaps are the
// error.
function assertContiguousRuns(runs: readonly SlotRun[]): void {
  for (const run of runs) {
    for (let i = 1; i < run.indices.length; i++) {
      if (run.indices[i]! === run.indices[i - 1]! + 1) continue;
      throw new Error(
        `Slots "${run.slots[i - 1]}" and "${run.slots[i]}" are declared as one numbered family but skip a number — declare every slot between them`,
      );
    }
  }
}

function checkNoGap(run: SlotRun, inputs: Readonly<Record<string, unknown>>): string | undefined {
  let firstUnwired: string | undefined;
  for (const name of run.slots) {
    if (inputs[name] === undefined) {
      firstUnwired ??= name;
      continue;
    }
    if (firstUnwired !== undefined) {
      return (
        `Reference slots fill upward with no gaps, but "${name}" is wired and "${firstUnwired}" is not. ` +
        `An omitted slot leaves the graph entirely, so "${name}" would take the ordinal "${firstUnwired}" left free. ` +
        `Move it down to "${firstUnwired}".`
      );
    }
  }
}

function checkOrdinals(
  group: TagGroup,
  prompt: string,
  inputs: Readonly<Record<string, unknown>>,
  form: "bracketed" | "bare",
): string | undefined {
  const wired = group.slots.filter((name) => inputs[name] !== undefined);
  const tagged = tagOrdinals(prompt, group.tag, form);
  const write = (n: number | "N") =>
    form === "bare" ? `${group.tag} ${n}` : `<${group.tag} ${n}>`;

  // Every ordinal above what is wired, not just the highest — `<Picture 2>` and `<Picture 5>` over
  // three references are two separate misses.
  const unbacked = [...tagged].filter((n) => n > wired.length || n < 1).sort((a, b) => a - b);
  if (unbacked.length > 0) {
    const lines = [
      `The prompt names ${unbacked.map(write).join(", ")}, but ${describeWired(group, wired, write)}`,
    ];
    if (wired.length > 0) lines.push(mapping(wired, tagged, write));
    lines.push(
      `An ordinal with no reference behind it lands on whichever reference took it. Wire another slot or renumber the prompt.`,
    );
    return lines.join("\n");
  }

  if (!group.exhaustive) return;

  // An exhaustive group's ordinals are a complete 1…n: a skipped ordinal means the prose is
  // describing a different reference than the one it will land on.
  const untagged = wired.filter((_, i) => !tagged.has(i + 1));
  if (untagged.length > 0) {
    const one = untagged.length === 1;
    return (
      `${untagged.map((name) => `"${name}"`).join(", ")} ${one ? "is" : "are"} wired, but no ` +
      `${write("N")} in the prompt reaches ${one ? "it" : "them"}:\n${mapping(wired, tagged, write)}\n` +
      `Name ${one ? "it" : "them"} in the prompt or drop the ${one ? "input" : "inputs"}.`
    );
  }
}

// A panel of a shot other than the one declaring this asset. A panel of the same shot (`first` →
// `last`) is no cut.
function otherShotPanel(value: unknown, shotId: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const address = parsePlaceholder(value);
  if (address === null) return undefined;
  const parsed = tryParseAddress(address);
  if (parsed?.stage !== "animatic" || parsed.kind !== "shot" || parsed.shotId === shotId) {
    return undefined;
  }
  return address;
}

function checkPrevPanel(
  group: TagGroup,
  within: (prompt: string) => string | undefined,
  prompt: string,
  inputs: Readonly<Record<string, unknown>>,
  form: "bracketed" | "bare",
  shotId: string | undefined,
): string | undefined {
  const write = (n: number) => (form === "bare" ? `${group.tag} ${n}` : `<${group.tag} ${n}>`);
  const carried = group.slots
    .filter((name) => inputs[name] !== undefined)
    .flatMap((name, i) => {
      const panel = otherShotPanel(inputs[name], shotId);
      return panel === undefined ? [] : [{ name, panel, ordinal: i + 1 }];
    });
  if (carried.length === 0) return;
  if (carried.length > 1) {
    return (
      `${carried.map((c) => `"${c.name}" takes ${c.panel}`).join(", ")} — panels of other shots, ` +
      `and a cut comes from one frame. The model places one as the frame it cuts from and reads the ` +
      `rest as unplaced pictures. Pass one.`
    );
  }
  const { name, panel, ordinal } = carried[0]!;
  const span = within(prompt);
  if (span === undefined) {
    return (
      `"${name}" takes ${panel}, another shot's panel, so this take cuts from it — but the prompt ` +
      `has no place for the frame a cut comes from. Write the cut the adapter's guide describes, ` +
      `naming ${write(ordinal)} as that frame.`
    );
  }
  if (!namesOrdinal(span, group.tag, form, ordinal)) {
    return (
      `"${name}" takes ${panel}, another shot's panel, so this take cuts from it — but ` +
      `${write(ordinal)} is not named where the prompt places the frame a cut comes from:\n` +
      `  ${span.trim()}\n` +
      `A panel passed without that place is read as one more picture, not as the frame it cuts from.`
    );
  }
}

function namesOrdinal(text: string, tag: string, form: "bracketed" | "bare", n: number): boolean {
  const escaped = escapeRegExp(tag);
  const pattern =
    form === "bare"
      ? new RegExp(`\\b${escaped}\\s+${n}\\b`, "i")
      : new RegExp(`<\\s*${escaped}\\s+${n}\\s*>`);
  return pattern.test(withoutQuotedText(text));
}

function describeWired(
  group: TagGroup,
  wired: readonly string[],
  write: (n: number | "N") => string,
): string {
  if (wired.length === 0) {
    return group.slots.length === 0
      ? `this adapter takes no ${write("N")} reference.`
      : `no ${write("N")} slot is wired (available: ${group.slots.join(", ")}).`;
  }
  return `only ${wired.length} ${wired.length === 1 ? "is" : "are"} wired:`;
}

function mapping(
  wired: readonly string[],
  tagged: ReadonlySet<number>,
  write: (n: number | "N") => string,
): string {
  return wired
    .map((name, i) => `  ${name} → ${write(i + 1)}${tagged.has(i + 1) ? "" : "  (unnamed)"}`)
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Every ordinal the prompt spends on this tag.
//
// A bracketed model writes `<Picture 2>`, which counts anywhere. Its bare form counts only on the
// first line — where the alignment line drops the brackets, and the one place it appears. Elsewhere
// a bare `Video 1` is prose: a label the shot is asked to render. A bare model has no bracket to
// tell the two apart, so its ordinals count anywhere and case-insensitively, since a sentence may
// open on one.
function tagOrdinals(prompt: string, tag: string, form: "bracketed" | "bare"): Set<number> {
  const found = new Set<number>();
  const escaped = escapeRegExp(tag);
  const text = withoutQuotedText(prompt);
  if (form === "bare") {
    collectOrdinals(text, new RegExp(`\\b${escaped}\\s+(\\d+)\\b`, "gi"), found);
    return found;
  }
  collectOrdinals(text, new RegExp(`<\\s*${escaped}\\s+(\\d+)\\s*>`, "g"), found);
  const newline = text.indexOf("\n");
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  collectOrdinals(firstLine, new RegExp(`\\b${escaped}\\s+(\\d+)\\b`, "g"), found);
  return found;
}

const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;

// Text in English double quotes is the convention for what the shot renders — a sign, a caption, a
// label — so a quoted span never contributes an ordinal in either written form.
function withoutQuotedText(prompt: string): string {
  return prompt.replace(QUOTED, "");
}

function collectOrdinals(text: string, pattern: RegExp, into: Set<number>): void {
  for (const match of text.matchAll(pattern)) {
    into.add(Number(match[1]));
  }
}
