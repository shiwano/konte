import type { KeepGraphInfo } from "../types.js";

// The Keep-or-regenerate model: which accepted takes an accept on this page leaves standing against
// the upstream it changes, and what the reviewer answered for each.

export type KeepDecision = "keep" | "regenerate";
export type KeepStage = "reference" | "animatic" | "video";

/** One unit an accept is about to settle, with the take it will stand on per address. */
export interface KeepOrigin {
  unit: string;
  chosen: Record<string, string>;
}

/** One accepted take, as the page saw it. */
export interface KeepTake {
  address: string;
  variantId: string;
}

/** An accepted unit made from what the accept changes: one row of the prompt, answered on its own. */
export interface KeepTarget {
  unit: string;
  // Its accepted rerollable takes the change stales: what Keep keeps and Regenerate redoes.
  takes: KeepTake[];
  decision: KeepDecision;
  // Accepted units in its stage made from it, rows excepted, that one `generate` re-makes with it.
  follows: KeepFollow[];
  // The nearest rows it is made from, in any stage: what its own answer's consequence hangs on.
  madeFrom: string[];
}

export interface KeepFollow {
  unit: string;
  takes: KeepTake[];
}

/** What a Keep asks the submit to record for one take. */
export interface KeepEntry extends KeepTake {
  // Per upstream, what the take is kept against: the output hash the page read, or `via:<upstream>=
  // <hash>,…` for an input konte re-makes from those upstream takes.
  inputs: Record<string, string>;
}

/** One origin's share of a prompt. */
export interface KeepPromptEntry {
  origin: string;
  targets: KeepTarget[];
  // Per address a Keep would record, what it keeps.
  keep: Record<string, KeepEntry>;
}

export interface KeepChoice extends KeepPromptEntry {
  seq: number;
}

export interface KeepContext {
  graph: KeepGraphInfo;
  // Whether the take at an address stands accepted, with the marks the accept being asked about
  // would leave.
  takeAccepted: (address: string) => boolean;
  // The take an address stands on, this session's picks included; null when it has none.
  takeOf: (address: string) => string | null;
  choices: readonly KeepChoice[];
}

export const EMPTY_KEEP_GRAPH: KeepGraphInfo = { addresses: {}, units: {} };

const VIA = "via:";

function parseVia(value: string | undefined): Record<string, string> | null {
  if (!value?.startsWith(VIA)) return null;
  const out: Record<string, string> = {};
  for (const pair of value.slice(VIA.length).split(",")) {
    const at = pair.lastIndexOf("=");
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

function formatVia(upstreams: Record<string, string>): string {
  return (
    VIA +
    Object.keys(upstreams)
      .sort()
      .map((address) => `${address}=${upstreams[address]}`)
      .join(",")
  );
}

// Two answers about one input: markers naming upstreams merge, a plain hash is the later's.
function mergeInput(prior: string | undefined, next: string): string {
  const a = parseVia(prior);
  const b = parseVia(next);
  return a && b ? formatVia({ ...a, ...b }) : next;
}

const bySeq = (a: KeepChoice, b: KeepChoice) => a.seq - b.seq;

interface Touch {
  choice: KeepChoice;
  target: KeepTarget;
  // Set when the unit is a follow of `target` rather than the row itself.
  follow: KeepFollow | null;
}

// Per unit, the last choice that touched it, as a row or as a follow of one: the answer that
// stands for it.
function lastTouchByUnit(choices: readonly KeepChoice[]): Map<string, Touch> {
  const out = new Map<string, Touch>();
  for (const choice of [...choices].sort(bySeq)) {
    for (const target of choice.targets) {
      out.set(target.unit, { choice, target, follow: null });
      for (const follow of target.follows) out.set(follow.unit, { choice, target, follow });
    }
  }
  return out;
}

/** One unit standing to be regenerated: its takes, and why. */
export interface KeepRegenerate {
  takes: KeepTake[];
  // The unit whose accept asked.
  origin: string;
  // The row this unit follows, when the answer was given there rather than on it.
  follows: string | null;
}

export function regenerateByUnit(choices: readonly KeepChoice[]): Map<string, KeepRegenerate> {
  const out = new Map<string, KeepRegenerate>();
  for (const [unit, { choice, target, follow }] of lastTouchByUnit(choices)) {
    if (target.decision !== "regenerate") continue;
    out.set(unit, {
      takes: follow ? follow.takes : target.takes,
      origin: choice.origin,
      follows: follow ? target.unit : null,
    });
  }
  return out;
}

export function regenerateDecisions(choices: readonly KeepChoice[]): KeepTake[] {
  const out = new Map<string, KeepTake>();
  for (const { takes } of regenerateByUnit(choices).values()) {
    for (const take of takes) out.set(take.address, take);
  }
  return [...out.values()];
}

/**
 * What every Keep standing for its unit records. Keeps answered since the unit's last Regenerate
 * all stand, each for the upstream it was asked about, so their inputs merge.
 */
export function keepDecisions(choices: readonly KeepChoice[]): KeepEntry[] {
  const sorted = [...choices].sort(bySeq);
  const lastRegenerate = new Map<string, number>();
  for (const choice of sorted) {
    for (const target of choice.targets) {
      if (target.decision !== "regenerate") continue;
      lastRegenerate.set(target.unit, choice.seq);
      for (const follow of target.follows) lastRegenerate.set(follow.unit, choice.seq);
    }
  }
  const out = new Map<string, KeepEntry>();
  for (const choice of sorted) {
    for (const target of choice.targets) {
      if (target.decision !== "keep") continue;
      if (choice.seq < (lastRegenerate.get(target.unit) ?? -Infinity)) continue;
      for (const { address } of target.takes) {
        const entry = choice.keep[address];
        if (!entry) continue;
        const prior = out.get(address);
        const inputs =
          prior?.variantId === entry.variantId
            ? { ...prior.inputs }
            : ({} as Record<string, string>);
        for (const [dep, value] of Object.entries(entry.inputs)) {
          inputs[dep] = mergeInput(inputs[dep], value);
        }
        out.set(address, { ...entry, inputs });
      }
    }
  }
  return [...out.values()];
}

/**
 * The answers left once `units` are decided again directly — accepted, taken back, or shown another
 * take: the answers their own accepts asked for go, and so does every other answer about them.
 */
export function withoutUnits(
  choices: readonly KeepChoice[],
  units: readonly string[],
): KeepChoice[] {
  const drop = new Set(units);
  return choices.flatMap((choice) => {
    if (drop.has(choice.origin)) return [];
    const touched = choice.targets.some(
      (t) =>
        drop.has(t.unit) ||
        t.follows.some((f) => drop.has(f.unit)) ||
        t.madeFrom.some((u) => drop.has(u)),
    );
    if (!touched) return [choice];
    const targets = choice.targets
      .filter((t) => !drop.has(t.unit))
      .map((t) => ({
        ...t,
        follows: t.follows.filter((f) => !drop.has(f.unit)),
        madeFrom: t.madeFrom.filter((u) => !drop.has(u)),
      }));
    if (targets.length === 0) return [];
    const addresses = new Set(targets.flatMap((t) => t.takes.map((take) => take.address)));
    const keep = Object.fromEntries(Object.entries(choice.keep).filter(([a]) => addresses.has(a)));
    return [{ ...choice, targets, keep }];
  });
}

/**
 * The answers a change to `unit`'s own answer implies: a row set back to Keep, wherever it is one.
 * Its follows go with it, since they only ever follow the row.
 */
export function keepingUnit(choices: readonly KeepChoice[], unit: string): KeepChoice[] {
  return choices.map((choice) =>
    choice.targets.some((t) => t.unit === unit && t.decision === "regenerate")
      ? {
          ...choice,
          targets: choice.targets.map((t) =>
            t.unit === unit ? { ...t, decision: "keep" as const } : t,
          ),
        }
      : choice,
  );
}

/**
 * The prompt the accept of `origins` owes, one entry per origin that owes one. An origin owes one
 * when the accept changes a take that an accepted take was made from — directly, or through a take
 * konte re-makes on its own — and that accepted take would no longer match. Each such unit is a row;
 * what a Regenerate of it re-makes with it (`follows`) and the rows it is made from (`madeFrom`) are
 * read once over every entry's rows together.
 */
export function keepPromptFor(ctx: KeepContext, origins: readonly KeepOrigin[]): KeepPromptEntry[] {
  const kept = new Map(keepDecisions(ctx.choices).map((entry) => [entry.address, entry]));
  const entries = origins.flatMap((origin) => {
    const entry = promptEntry(ctx, kept, origin);
    return entry ? [entry] : [];
  });
  if (entries.length === 0) return entries;

  const rows = new Set(entries.flatMap((e) => e.targets.map((t) => t.unit)));
  const originUnits = new Set(origins.map((o) => o.unit));
  const follows = new Map<string, KeepFollow[]>();
  const madeFrom = new Map<string, string[]>();
  for (const unit of rows) {
    const reach = reachOf(ctx, unit, rows, originUnits);
    follows.set(unit, reach.follows);
    for (const row of reach.rows) madeFrom.set(row, [...(madeFrom.get(row) ?? []), unit]);
  }
  return entries.map((entry) => ({
    ...entry,
    targets: entry.targets.map((t) => ({
      ...t,
      follows: follows.get(t.unit) ?? [],
      madeFrom: madeFrom.get(t.unit) ?? [],
    })),
  }));
}

function promptEntry(
  ctx: KeepContext,
  kept: Map<string, KeepEntry>,
  origin: KeepOrigin,
): KeepPromptEntry | null {
  const { graph } = ctx;
  const changed = new Map<string, string>();
  for (const [address, variantId] of Object.entries(origin.chosen)) {
    const info = graph.addresses[address];
    const hash = info?.takes[variantId]?.outputHash;
    if (info && hash && variantId !== info.acceptedVariantId) changed.set(address, hash);
  }
  if (changed.size === 0) return null;

  const takeOf = (address: string): string | null => origin.chosen[address] ?? ctx.takeOf(address);

  const stale = new Map<string, Record<string, string>>();
  for (const [upstream, hash] of changed) {
    for (const { address, via } of graph.addresses[upstream]!.consumers) {
      const variantId = takeOf(address);
      const inputs = variantId
        ? graph.addresses[address]?.takes[variantId]?.inputs[via]
        : undefined;
      if (!inputs) continue;
      const keptInput = kept.get(address)?.inputs[via];
      const current =
        via === upstream
          ? inputs.includes(hash) || keptInput === hash
          : [...inputs, keptInput].some((value) => parseVia(value)?.[upstream] === hash);
      if (current) continue;
      const out = stale.get(address) ?? {};
      out[via] = via === upstream ? hash : mergeInput(out[via], formatVia({ [upstream]: hash }));
      stale.set(address, out);
    }
  }

  const byUnit = new Map<string, KeepTake[]>();
  const keep: KeepPromptEntry["keep"] = {};
  for (const [address, inputs] of stale) {
    const info = graph.addresses[address];
    const variantId = takeOf(address);
    if (!info?.rerollable || variantId === null || !ctx.takeAccepted(address)) continue;
    byUnit.set(info.unit, [...(byUnit.get(info.unit) ?? []), { address, variantId }]);
    keep[address] = { address, variantId, inputs };
  }
  if (byUnit.size === 0) return null;
  return {
    origin: origin.unit,
    targets: [...byUnit].map(([unit, takes]) => ({
      unit,
      takes,
      decision: "keep",
      follows: [],
      madeFrom: [],
    })),
    keep,
  };
}

/**
 * What lies downstream of one row. Its follows are the accepted units of its own stage made from it
 * through anything but another row or an origin: one `generate` re-makes them with it. A take in
 * another stage waits on an accept of what it is made from, so the walk stops at a stage boundary,
 * and stops at a row, which answers for itself, noting it as made from this one.
 */
function reachOf(
  ctx: KeepContext,
  unit: string,
  rows: ReadonlySet<string>,
  origins: ReadonlySet<string>,
): { follows: KeepFollow[]; rows: string[] } {
  const { graph } = ctx;
  const stage = graph.units[unit]?.stage;
  const queue = Object.keys(graph.addresses).filter((a) => graph.addresses[a]!.unit === unit);
  const seen = new Set(queue);
  const follows = new Map<string, KeepTake[]>();
  const madeFrom = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const { address } of graph.addresses[node]?.consumers ?? []) {
      const info = graph.addresses[address];
      if (!info || seen.has(address)) continue;
      seen.add(address);
      if (info.unit === unit) {
        queue.push(address);
        continue;
      }
      if (rows.has(info.unit)) {
        madeFrom.add(info.unit);
        continue;
      }
      if (origins.has(info.unit) || graph.units[info.unit]?.stage !== stage) continue;
      queue.push(address);
      const variantId = ctx.takeOf(address);
      if (info.rerollable && variantId !== null && ctx.takeAccepted(address)) {
        follows.set(info.unit, [...(follows.get(info.unit) ?? []), { address, variantId }]);
      }
    }
  }
  return {
    follows: [...follows].map(([unit, takes]) => ({ unit, takes })),
    rows: [...madeFrom],
  };
}

const STAGES: readonly KeepStage[] = ["reference", "animatic", "video"];

/** The names a unit's takes go by on screen: the address past the unit, none for the unit itself. */
export function takeNames(unit: string, takes: readonly KeepTake[]): string[] {
  return takes.flatMap(({ address }) =>
    address.startsWith(`${unit}.`)
      ? [address.slice(unit.length + 1)]
      : address === unit
        ? []
        : [address],
  );
}

/** A unit named from `from`'s stage: its label, with its stage when that is another one. */
export function unitLabel(graph: KeepGraphInfo, unit: string, from: KeepStage): string {
  const info = graph.units[unit];
  if (!info) return unit;
  return info.stage === from ? info.label : `${info.label} (${info.stage})`;
}

/** One row of the prompt, as shown. */
export interface KeepPromptRow {
  unit: string;
  label: string;
  // The names of its takes the answer is about, when the unit holds more than one address.
  takes: string[];
  // What a Regenerate re-makes with it, by label.
  follows: string[];
  // The rows it is made from.
  madeFrom: Array<{ unit: string; label: string; stage: KeepStage }>;
}

export interface KeepPromptStage {
  stage: KeepStage;
  rows: KeepPromptRow[];
}

export interface KeepPrompt {
  // The units whose accept asks, by label.
  origins: string[];
  stages: KeepPromptStage[];
}

/** What the prompt shows: its origins, and the rows it asks about per stage in pipeline order. */
export function keepPrompt(
  graph: KeepGraphInfo,
  entries: readonly KeepPromptEntry[],
  from: KeepStage,
): KeepPrompt {
  const rows = new Map<
    string,
    { takes: Set<string>; follows: Set<string>; madeFrom: Set<string> }
  >();
  for (const entry of entries) {
    for (const target of entry.targets) {
      const row = rows.get(target.unit) ?? {
        takes: new Set(),
        follows: new Set(),
        madeFrom: new Set(),
      };
      for (const name of takeNames(target.unit, target.takes)) row.takes.add(name);
      for (const f of target.follows) row.follows.add(f.unit);
      for (const u of target.madeFrom) row.madeFrom.add(u);
      rows.set(target.unit, row);
    }
  }
  const stageOf = (unit: string) => graph.units[unit]?.stage;
  return {
    origins: entries.map((e) => unitLabel(graph, e.origin, from)),
    stages: STAGES.map((stage) => ({
      stage,
      rows: [...rows]
        .filter(([unit]) => stageOf(unit) === stage)
        .map(([unit, row]) => ({
          unit,
          label: unitLabel(graph, unit, stage),
          takes: [...row.takes],
          follows: [...row.follows].map((u) => unitLabel(graph, u, stage)),
          madeFrom: [...row.madeFrom].map((u) => ({
            unit: u,
            label: unitLabel(graph, u, stage),
            stage: stageOf(u) ?? stage,
          })),
        })),
    })).filter((s) => s.rows.length > 0),
  };
}

/** One unit the review will regenerate, with those that go with it, as the reviewer names them. */
export interface RegenerateSummary {
  label: string;
  takes: string[];
  with: Array<{ label: string; takes: string[] }>;
}

/** What the submit dialog lists: every Regenerate standing, the rows first and their follows under them. */
export function regenerateSummary(
  graph: KeepGraphInfo,
  choices: readonly KeepChoice[],
  from: KeepStage,
): RegenerateSummary[] {
  const byUnit = regenerateByUnit(choices);
  const out = new Map<string, RegenerateSummary>();
  const rowOf = (unit: string): RegenerateSummary => {
    let row = out.get(unit);
    if (!row) {
      row = { label: unitLabel(graph, unit, from), takes: [], with: [] };
      out.set(unit, row);
    }
    return row;
  };
  for (const [unit, { takes, follows }] of byUnit) {
    const names = takeNames(unit, takes);
    if (follows === null) rowOf(unit).takes = names;
    else rowOf(follows).with.push({ label: unitLabel(graph, unit, from), takes: names });
  }
  return [...out.values()];
}
