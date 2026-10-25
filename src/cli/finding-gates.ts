// The two gates: the spend gate in front of every `generate` / `reroll` / `patch apply` / `export`,
// the review gate in front of `preview <stage>` and every accept. Each asks the one finding registry
// (`collectFindings`) what holds the operation, beside — for a spend — what the human has not
// accepted yet, and names every reason in one refusal.

import { type AssetStage, matchesAddressScope, tryParseAddress } from "../core/address.js";
import {
  type CheckContext,
  type FindingReport,
  type PatchSubject,
  collectFindings,
} from "../core/checks.js";
import {
  directionAcceptanceView,
  isDirectionSpendGateSatisfied,
  songGateBlocking,
} from "../core/direction-acceptance.js";
import type { Direction } from "../core/dsl/direction.js";
import { KonteError } from "../core/errors.js";
import {
  type Finding,
  type ReviewOp,
  type SpendCommand,
  findingTraits,
  formatFindingLine,
  groupByFixIn,
  reviewHold,
  spendHold,
} from "../core/finding.js";
import {
  buildDependencyGraph,
  collectTransitiveDependents,
  type DependencyGraph,
} from "../core/graph.js";
import { loadAnimatic, loadReference } from "../core/loader.js";
import { songAddressOf } from "../core/song-take.js";
import { StateManager } from "../core/state/index.js";
import type {
  AnimaticDefinition,
  ReferenceDefinition,
  VideoDefinition,
} from "../core/types/index.js";
import {
  animaticSetupState,
  loadDirectionIfPresent,
  loadVideoAndAnimatic,
  songTakeState,
  stagingStageState,
  unacceptedUpstreamDeps,
  unsatisfiedCharacters,
  unsatisfiedVoices,
  upstreamMostBlockers,
} from "./load-definition.js";

type StageDefs = {
  reference: ReferenceDefinition | null;
  animatic: AnimaticDefinition | null;
  video: VideoDefinition | null;
};

// What the checks read, loaded once. Whatever the caller already holds is handed in; the rest is
// read here, tolerantly — a stage that will not load leaves the findings it feeds unevaluated, and
// the command that needs it fails on it in its own words.
export async function loadCheckContext(opts: {
  videoRoot: string;
  definitions?: StageDefs;
  direction?: Direction | null;
  manager?: StateManager | null;
  graph?: DependencyGraph | null;
  patches?: readonly PatchSubject[];
}): Promise<CheckContext> {
  const { videoRoot } = opts;
  const direction =
    opts.direction !== undefined ? opts.direction : await loadDirectionIfPresent(videoRoot);
  const defs = opts.definitions ?? (await loadStageDefsTolerant(videoRoot));
  const manager =
    opts.manager !== undefined
      ? opts.manager
      : await StateManager.load(videoRoot).catch(() => null);
  const graph = opts.graph !== undefined ? opts.graph : tryGraph(defs);
  const { reference, animatic, video } = defs;
  return {
    videoRoot,
    direction,
    directionAccepted:
      direction !== null &&
      isDirectionSpendGateSatisfied(direction, manager?.getDirectionAcceptance() ?? null),
    reference,
    animatic,
    video,
    manager,
    graph,
    patches: opts.patches ?? [],
    lang: video?.typography.lang ?? direction?.policy.lang ?? null,
    ...(direction && animatic
      ? {
          animaticSetups: animaticSetupState(direction, animatic, reference),
          stagingStage: stagingStageState(direction, animatic, video, manager),
        }
      : {}),
    ...(direction && manager ? { songTake: songTakeState(manager, direction) } : {}),
  };
}

export async function loadStageDefsTolerant(videoRoot: string): Promise<StageDefs> {
  const reference = await loadReference(videoRoot).catch(() => null);
  const shots = await loadVideoAndAnimatic(videoRoot).catch(() => null);
  if (shots) return { reference, ...shots };
  return { reference, animatic: await loadAnimatic(videoRoot).catch(() => null), video: null };
}

// Over whichever stages loaded, so a board reviewed before video.tsx exists still has its edges.
function tryGraph(defs: StageDefs): DependencyGraph | null {
  if (!defs.video && !defs.animatic && !defs.reference) return null;
  try {
    return buildDependencyGraph(defs.video, defs.animatic, defs.reference);
  } catch {
    return null;
  }
}

// --- spend ---

// One spend as the gate judges it. `assetPaths` is what it would submit: a whole-stage spend
// (`targeted: false`) leaves out what an `edge` finding or an unaccepted upstream holds and goes on
// with the rest; a targeted one (`reroll`, `patch apply`) asked for every asset it names, so any
// hold refuses it.
export type SpendRequest = {
  command: SpendCommand;
  stage: AssetStage;
  assetPaths: readonly string[];
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

export type SpendVerdict = {
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
    req.assetPaths.some((address) => {
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
    else if (hold === "edge") edgeFindings.push(f);
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
  }

  if (ctx.manager && ctx.direction && req.stage === "reference") {
    const song = songAddressOf(ctx.direction);
    if (song !== null && req.assetPaths.includes(song)) {
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
          assetPaths: req.assetPaths,
          ...(req.extraRefs ? { extraRefs: req.extraRefs } : {}),
        });
        const named = upstreamMostBlockers(blocking);
        if (named) unaccepted.push(upstreamUnaccepted(req.stage, named));
      } else {
        for (const assetPath of req.assetPaths) {
          const blocking = unacceptedUpstreamDeps({ ...upstreamOpts, assetPaths: [assetPath] });
          for (const line of upstreamMostBlockers(blocking)?.lines ?? []) hold(assetPath, line);
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
  if (!ctx.direction || ctx.directionAccepted) return [];
  const { gateBlocking } = directionAcceptanceView(ctx.direction, manager.getDirectionAcceptance());
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

function findingLines(findings: readonly Finding[]): string[] {
  return groupByFixIn(findings).flatMap(({ file, findings: group }) => [
    `  ${file}:`,
    ...group.map((f) => `    ${formatFindingLine(f)}`),
  ]);
}

// The refusal a verdict amounts to, or null when the spend may go on with what is not held.
export function spendHeldError(req: SpendRequest, verdict: SpendVerdict): KonteError | null {
  const allHeld =
    req.assetPaths.length > 0 && req.assetPaths.every((address) => verdict.held.has(address));
  const targetedHeld = req.targeted && req.assetPaths.some((address) => verdict.held.has(address));
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
          ...findingLines(findings).map((l) => `  ${l}`),
        ]
      : []),
    ...verdict.unaccepted.flatMap((u) => [`  ${u.headline}:`, ...u.lines.map((l) => `  ${l}`)]),
    ...(allHeld || targetedHeld
      ? [
          "  Held:",
          ...[...verdict.held]
            .filter(([address]) => req.assetPaths.includes(address))
            .flatMap(([address, why]) => [`    ${address}`, ...why.map((l) => `    ${l}`)]),
        ]
      : []),
  ];
  const what = req.patch ? `patch ${req.patch}` : `${req.command} ${req.stage}`;
  return new KonteError("SPEND_HELD", `Cannot ${what} — it is held`, lines);
}

// The gate: refuses with SPEND_HELD on the first request held, else hands back what the whole-stage
// spends leave out. Several requests share one pass of the checks.
export async function spendGate(
  ctx: CheckContext,
  reqs: SpendRequest | readonly SpendRequest[],
): Promise<{ held: Map<string, string[]> }> {
  const report = await collectFindings(ctx, (traits) => traits.holds.spend !== undefined);
  const held = new Map<string, string[]>();
  for (const req of Array.isArray(reqs) ? reqs : [reqs as SpendRequest]) {
    const verdict = judgeSpend(ctx, report, req);
    const error = spendHeldError(req, verdict);
    if (error) throw error;
    for (const [address, lines] of verdict.held) held.set(address, lines);
  }
  return { held };
}

// What a whole-stage spend would leave out, without refusing anything — for a surface that reports
// what `generate` would submit.
export async function spendHeldAssets(
  ctx: CheckContext,
  req: SpendRequest,
): Promise<Map<string, string[]>> {
  const report = await collectFindings(ctx, (traits) => traits.holds.spend !== undefined);
  return judgeSpend(ctx, report, req).held;
}

// The findings alone, for a spend that reaches no graph — a delivery upscale's own prompts.
export function assertNoSpendFindings(findings: readonly Finding[], req: SpendRequest): void {
  const error = spendHeldError(req, {
    findings: findings.filter((f) => spendHold(f, req) === "whole"),
    edgeFindings: [],
    unaccepted: [],
    held: new Map(),
  });
  if (error) throw error;
}

// --- review ---

export function reviewHeldFindings(report: FindingReport, ops: readonly ReviewOp[]): Finding[] {
  return report.findings.filter((f) => ops.some((op) => reviewHold(f, op)));
}

export function reviewHeldError(blocked: string, findings: readonly Finding[]): KonteError | null {
  if (findings.length === 0) return null;
  const vouchable = findings.some((f) => findingTraits(f.code).clears === "vouch");
  return new KonteError(
    "REVIEW_HELD",
    `${blocked} — fix each finding in the file it is listed under` +
      (vouchable
        ? "; dismiss a take found wrong (reroll for another beside it), or `konte vouch <variantId>` one that is fine"
        : ""),
    findingLines(findings),
  );
}

// The gate: refuses with REVIEW_HELD when a finding holds any of `ops`.
export async function reviewGate(
  ctx: CheckContext,
  ops: readonly ReviewOp[],
  blocked: string,
): Promise<void> {
  const preview = ops.some((op) => op.op === "preview");
  const accept = ops.some((op) => op.op === "accept");
  const want = (t: ReturnType<typeof findingTraits>) =>
    (preview && t.holds.preview === true) || (accept && t.holds.accept === true);
  const previewStages = new Set(ops.flatMap((op) => (op.op === "preview" ? [op.stage] : [])));
  const [takeStage] = previewStages;
  const report = await collectFindings(
    !accept && previewStages.size === 1 && takeStage !== "direction" ? { ...ctx, takeStage } : ctx,
    want,
  );
  const error = reviewHeldError(blocked, reviewHeldFindings(report, ops));
  if (error) throw error;
}
