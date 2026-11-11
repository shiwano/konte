import {
  type AssetStage,
  type Stage,
  formatReferenceAddress,
  getStage,
  isMaterializedLeafAddress,
  matchesAddressScope,
  tryParseAddress,
} from "./address.js";
import { type CheckContext, type FindingReport, waiverCoverageOf } from "./checks.js";
import { collectFramedCharacterIds } from "./direction.js";
import { directionAcceptanceView, songGateBlocking } from "./direction-acceptance.js";
import type { Character, Direction } from "./dsl/direction.js";
import { KonteError } from "./errors.js";
import {
  type Finding,
  type SpendCommand,
  findingTraits,
  formatFindingLine,
  formatFindingGroups,
  spendHold,
} from "./finding.js";
import { collectTransitiveDependents, type DependencyGraph } from "./graph.js";
import { songAddressOf } from "./song-variant.js";
import { collectUndecidedUpstreamVariants } from "./staleness.js";
import type { StateManager } from "./state/index.js";

// Sign-off a spend may build on: strict resolution's own verdict, which is what the spend then
// resolves with. It keeps the acceptance-only policy — a HUMAN accept passes however stale it has
// since become — while refusing the two an accept does not stand behind: a take that produced no
// file, and one konte accepted itself that has since gone stale.
function acceptedForSpend(manager: StateManager, address: string): boolean {
  return manager.selectVariant(address, { requireAccepted: true }) !== null;
}

// The characters some frame's lineup holds whose `reference:<id>` look anchor is not accepted yet.
export function unsatisfiedCharacters(opts: {
  manager: StateManager;
  direction: Direction | null;
}): Array<{ id: string } & Character> {
  if (!opts.direction) return [];
  const framed = collectFramedCharacterIds(opts.direction);
  const out: Array<{ id: string } & Character> = [];
  for (const [id, c] of Object.entries(opts.direction.characters ?? {})) {
    if (!framed.has(id)) continue;
    if (!acceptedForSpend(opts.manager, formatReferenceAddress(id))) out.push({ id, ...c });
  }
  return out;
}

// The cast voices whose sample is not accepted yet — every declared character voice plus the
// narrator's, each labelled by who it belongs to.
export function unsatisfiedVoices(opts: {
  manager: StateManager;
  direction: Direction | null;
}): Array<{ assetId: string; who: string }> {
  // One sample may be cast twice (a narrator who is the protagonist, twins), and it is one asset to
  // accept — so it is named once, by everyone who is cast on it.
  const whoById = new Map<string, string[]>();
  const addCast = (assetId: string, who: string) => {
    const existing = whoById.get(assetId);
    if (existing) existing.push(who);
    else whoById.set(assetId, [who]);
  };
  for (const [id, c] of Object.entries(opts.direction?.characters ?? {})) {
    if (c.voice) addCast(c.voice.id, `${c.name} (${id})`);
  }
  if (opts.direction?.narrator) addCast(opts.direction.narrator.id, "the narrator");

  const out: Array<{ assetId: string; who: string }> = [];
  for (const [assetId, who] of whoById) {
    if (!acceptedForSpend(opts.manager, formatReferenceAddress(assetId))) {
      out.push({ assetId, who: who.join(", ") });
    }
  }
  return out;
}

// The stages that can sit upstream of a spend and are reviewed by a human, in pipeline order — so
// the ones a spend below them must find accepted, and the step that clears each. `direction` is
// absent because its acceptance is per part (`directionAcceptanceView`); `video` because nothing is
// downstream of it.
const GATED_UPSTREAM: ReadonlyArray<{ stage: Stage; review: string; generate: string }> = [
  { stage: "reference", review: "konte preview reference", generate: "konte generate reference" },
  { stage: "animatic", review: "konte preview animatic", generate: "konte generate animatic" },
];

type UpstreamBlocker =
  | { kind: "unaccepted"; hasOutput: boolean }
  | { kind: "undecided"; acceptedVariantId: string; undecidedVariantId: string };

// The reviewed upstream work a spend would build on, mapped to what holds each back — the
// cross-stage twin of the direction's acceptance. A stale accepted upstream still passes, staleness
// having its own reporting. `stage` is the stage doing the
// spending: its own nodes are walked through (so a `animatic → video → video` chain cannot slip
// past by targeting the far end), as are the deterministic ones. The walk stops at every gated
// upstream node — its own upstreams were reviewed as part of it, which is why accepting a board
// does not re-ask for the sheets under it. `extraRefs` carries addresses consumed by something with
// no graph node of its own, i.e. a patch definition's refs. `redone` names upstreams this same run
// makes a fresh take of, which the spend builds on in place of the undecided one.
function unacceptedUpstreamDeps(opts: {
  manager: StateManager;
  graph: DependencyGraph;
  addresses: Iterable<string>;
  stage: Stage;
  extraRefs?: Iterable<string>;
  redone?: ReadonlySet<string>;
}): Map<string, UpstreamBlocker> {
  const blocking = new Map<string, UpstreamBlocker>();
  const seen = new Set<string>();
  const queue: string[] = [...(opts.extraRefs ?? [])];
  for (const address of opts.addresses) {
    queue.push(...(opts.graph.dependencies.get(address) ?? []));
  }

  while (queue.length > 0) {
    const dep = queue.pop()!;
    if (seen.has(dep)) continue;
    seen.add(dep);
    const stage = getStage(dep);
    if (stage === opts.stage || !GATED_UPSTREAM.some((u) => u.stage === stage)) {
      queue.push(...(opts.graph.dependencies.get(dep) ?? []));
      continue;
    }
    if (acceptedForSpend(opts.manager, dep)) {
      if (opts.redone?.has(dep)) continue;
      const [variant] = collectUndecidedUpstreamVariants(
        opts.manager.getState(),
        [dep],
        opts.manager.stalenessCache(),
      );
      if (variant) {
        blocking.set(dep, {
          kind: "undecided",
          acceptedVariantId: variant.acceptedVariantId,
          undecidedVariantId: variant.undecidedVariantId,
        });
      }
      continue;
    }
    const variants = Object.values(opts.manager.getState().assets[dep]?.variants ?? {});
    blocking.set(dep, {
      kind: "unaccepted",
      // A dismissed take is not output awaiting a verdict: that upstream needs regenerating.
      hasOutput: variants.some((v) => v.file && v.status !== "dismissed"),
    });
  }
  return blocking;
}

// The upstream-most blockers alone: accepting a board built on an unaccepted sheet is not the fix,
// so naming both would send the human at the wrong one. GATED_UPSTREAM is in pipeline order, so the
// first entry with a blocker is the upstream-most.
function upstreamMostBlockers(blocking: Map<string, UpstreamBlocker>): {
  upstream: (typeof GATED_UPSTREAM)[number];
  lines: string[];
} | null {
  const upstream = GATED_UPSTREAM.find(({ stage }) =>
    [...blocking.keys()].some((address) => getStage(address) === stage),
  );
  if (!upstream) return null;
  const lines = [...blocking]
    .filter(([address]) => getStage(address) === upstream.stage)
    .map(
      ([address, blocker]) =>
        `  ${address} — ${
          blocker.kind === "undecided"
            ? `${blocker.undecidedVariantId} is undecided beside accepted ` +
              `${blocker.acceptedVariantId} — review it in \`${upstream.review}\``
            : isMaterializedLeafAddress(address)
              ? `run \`konte accept ${address}\`, which materializes it`
              : blocker.hasOutput
                ? `review and accept it in \`${upstream.review}\``
                : `nothing generated yet — run \`${upstream.generate}\` first`
        }`,
    );
  return { upstream, lines };
}

// One spend as the gate judges it. `addresses` is what it would submit: a whole-stage spend
// (`targeted: false`) leaves out what an `edge` finding or an unaccepted upstream holds and goes on
// with the rest; a targeted one (`reroll`, `patch apply`) asked for every asset it names, so any
// hold refuses it.
export type SpendRequest = {
  command: SpendCommand;
  stage: AssetStage;
  addresses: readonly string[];
  targeted: boolean;
  // The take whose patch script is applied.
  patch?: string;
  // Addresses the spend consumes that have no graph node of their own (a patch's refs).
  extraRefs?: readonly string[];
  // Upstreams this same run makes a fresh take of.
  redone?: ReadonlySet<string>;
};

// What has not been accepted, ranked by how far upstream it sits: only the upstream-most rank is
// named.
type Unaccepted = { rank: number; headline: string; lines: string[] };

type SpendVerdict = {
  // Findings that hold the whole spend.
  findings: Finding[];
  // Findings that hold only their `edge` assets.
  edgeFindings: Finding[];
  unaccepted: Unaccepted[];
  // Assets left out of a whole-stage spend, each with the lines saying what holds it.
  held: Map<string, string[]>;
};

export function judgeSpend(
  ctx: CheckContext,
  report: FindingReport,
  req: SpendRequest,
): SpendVerdict {
  const op = { command: req.command, stage: req.stage, ...(req.patch ? { patch: req.patch } : {}) };
  const findings: Finding[] = [];
  const edgeFindings: Finding[] = [];
  const named = (f: Finding) =>
    req.addresses.some((address) => {
      const parsed = tryParseAddress(address);
      return (
        parsed?.kind !== "shot" ||
        (f.targets ?? []).some((target) => matchesAddressScope(address, target))
      );
    });
  for (const f of report.findings) {
    const hold = spendHold(f, op);
    if (req.targeted && findingTraits(f.code).holds.spend?.named && !named(f)) continue;
    if (hold === "whole") findings.push(f);
    else if (hold === "edge" && (req.targeted || (f.targets ?? []).length > 0))
      edgeFindings.push(f);
  }

  const unaccepted: Unaccepted[] = [];
  const held = new Map<string, string[]>();
  const hold = (address: string, line: string) => {
    const lines = held.get(address) ?? [];
    if (!lines.includes(line)) lines.push(line);
    held.set(address, lines);
  };

  for (const f of edgeFindings) {
    const line = `  ${formatFindingLine(f)}`;
    for (const target of f.targets ?? []) {
      hold(target, line);
      if (!ctx.graph) continue;
      for (const dependent of collectTransitiveDependents(ctx.graph, target)) hold(dependent, line);
    }
    if (!req.targeted) continue;
    for (const address of f.signedOff ?? []) {
      if (req.addresses.includes(address)) hold(address, line);
    }
  }

  if (ctx.manager && ctx.direction && req.stage === "reference") {
    const song = songAddressOf(ctx.direction);
    if (song !== null && req.addresses.includes(song)) {
      const blocking = songGateBlocking(ctx.direction, ctx.manager.getDirectionAcceptance());
      if (blocking.length > 0) {
        unaccepted.push({
          rank: 0,
          headline:
            `${song} is generated from the direction's brief, policy and lyrics — accept them ` +
            "first: `konte preview direction`, or `konte accept <part>...`",
          lines: blocking.map(({ address, status }) => `  ${address} — ${partStatus(status)}`),
        });
      }
    }
  }

  if (ctx.manager && req.stage !== "reference") {
    unaccepted.push(...directionUnaccepted(ctx, ctx.manager));
    unaccepted.push(...castUnaccepted(ctx, ctx.manager));
    if (ctx.graph) {
      const upstreamOpts = {
        manager: ctx.manager,
        graph: ctx.graph,
        stage: req.stage,
        ...(req.redone ? { redone: req.redone } : {}),
      };
      if (req.targeted) {
        const blocking = unacceptedUpstreamDeps({
          ...upstreamOpts,
          addresses: req.addresses,
          ...(req.extraRefs ? { extraRefs: req.extraRefs } : {}),
        });
        const named = upstreamMostBlockers(blocking);
        if (named) unaccepted.push(upstreamUnaccepted(req.stage, named));
      } else {
        for (const address of req.addresses) {
          const blocking = unacceptedUpstreamDeps({ ...upstreamOpts, addresses: [address] });
          for (const line of upstreamMostBlockers(blocking)?.lines ?? []) hold(address, line);
        }
      }
    }
  }

  const top = Math.min(...unaccepted.map((u) => u.rank));
  return {
    findings,
    edgeFindings,
    unaccepted: unaccepted.filter((u) => u.rank === top),
    held,
  };
}

function partStatus(status: string): string {
  return status === "stale"
    ? "changed since it was accepted"
    : status === "deleted"
      ? "deleted since it was accepted"
      : "never accepted";
}

// The direction must be reviewed and accepted by a human before any animatic/video spend. Which
// parts it demands narrows once the piece has been signed off end to end.
function directionUnaccepted(ctx: CheckContext, manager: StateManager): Unaccepted[] {
  if (!ctx.direction) return [];
  const { gateBlocking, gateSatisfied } = directionAcceptanceView(
    ctx.direction,
    manager.getDirectionAcceptance(),
    waiverCoverageOf(ctx),
  );
  if (gateSatisfied) return [];
  const clear = "`konte preview direction`, or `konte accept <part>...`";
  if (gateBlocking.length === 0) {
    // Nothing live is blocking, so what re-blocked the gate is a part deleted since it was accepted.
    return [
      {
        rank: 0,
        headline: `The direction lost a part that was accepted — review and re-accept it: ${clear} (\`--off\` clears a deleted part's sign-off)`,
        lines: [],
      },
    ];
  }
  return [
    {
      rank: 0,
      headline: `${gateBlocking.length} part(s) of the direction to review and accept — ${clear}`,
      lines: gateBlocking.map(({ address, status }) => `  ${address} — ${partStatus(status)}`),
    },
  ];
}

// The cast: a character a lineup holds needs its look accepted before either shot stage spends, a
// cast voice its sample.
function castUnaccepted(ctx: CheckContext, manager: StateManager): Unaccepted[] {
  const opts = { manager, direction: ctx.direction, reference: ctx.reference };
  const hint = (id: string) =>
    ctx.reference?.topLevelAssets?.[id]?.kind === "file"
      ? "place its file under assets/files/, then accept it in `konte preview reference`"
      : "review and accept it in `konte preview reference`";
  const lines = [
    ...unsatisfiedCharacters(opts).map((c) => `  reference:${c.id} — ${hint(c.id)}`),
    ...unsatisfiedVoices(opts).map(
      (v) => `  reference:${v.assetId} — ${v.who}: ${hint(v.assetId)}`,
    ),
  ];
  if (lines.length === 0) return [];
  return [
    {
      rank: 1,
      headline:
        `${lines.length} cast reference(s) to accept — a look or a voice is never accepted ` +
        "implicitly through a shot that uses it",
      lines,
    },
  ];
}

function upstreamUnaccepted(
  stage: AssetStage,
  named: NonNullable<ReturnType<typeof upstreamMostBlockers>>,
): Unaccepted {
  return named.upstream.stage === "reference"
    ? {
        rank: 1,
        headline: `${named.lines.length} reference asset(s) this ${stage} spend conditions on to accept first`,
        lines: named.lines,
      }
    : {
        rank: 2,
        headline: `${named.lines.length} animatic asset(s) this video spend builds on to accept first`,
        lines: named.lines,
      };
}

// The refusal a verdict amounts to, or null when the spend may go on with what is not held.
export function spendHeldError(req: SpendRequest, verdict: SpendVerdict): KonteError | null {
  const allHeld =
    req.addresses.length > 0 && req.addresses.every((address) => verdict.held.has(address));
  const targetedHeld = req.targeted && req.addresses.some((address) => verdict.held.has(address));
  if (
    verdict.findings.length === 0 &&
    verdict.unaccepted.length === 0 &&
    !allHeld &&
    !targetedHeld
  ) {
    return null;
  }
  const findings = [...verdict.findings, ...(allHeld || targetedHeld ? verdict.edgeFindings : [])];
  const waivable = findings.some((f) => findingTraits(f.code).clears === "waive");
  const lines = [
    ...(findings.length > 0
      ? [
          `  Fix each finding in the file it is listed under${waivable ? ", or waive a waivable one by its key in direction.waivers" : ""}:`,
          ...formatFindingGroups(findings).map((l) => `  ${l}`),
        ]
      : []),
    ...verdict.unaccepted.flatMap((u) => [`  ${u.headline}:`, ...u.lines.map((l) => `  ${l}`)]),
    ...(allHeld || targetedHeld
      ? [
          "  Held:",
          ...[...verdict.held]
            .filter(([address]) => req.addresses.includes(address))
            .flatMap(([address, why]) => [`    ${address}`, ...why.map((l) => `    ${l}`)]),
        ]
      : []),
  ];
  const what = req.patch ? `patch ${req.patch}` : `${req.command} ${req.stage}`;
  return new KonteError("SPEND_HELD", `Cannot ${what} — it is held`, lines);
}
