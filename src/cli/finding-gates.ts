// The two gates: the spend gate in front of every `generate` / `reroll` / `patch apply` / `export`,
// the review gate in front of `preview <stage>` and every accept. Each asks the one finding registry
// (`collectFindings`) what holds the operation, beside — for a spend — what the human has not
// accepted yet, and names every reason in one refusal.

import { type CheckContext, type FindingReport, collectFindings } from "../core/checks.js";
import { KonteError } from "../core/errors.js";
import {
  type Finding,
  type ReviewOp,
  findingTraits,
  formatFindingGroups,
  reviewHold,
  spendHold,
} from "../core/finding.js";
import { type SpendRequest, judgeSpend, spendHeldError } from "../core/spend-gate.js";

// The gate: refuses with SPEND_HELD on the first request held, else hands back what the whole-stage
// spends leave out. Several requests share one pass of the checks.
export async function spendGate(
  ctx: CheckContext,
  reqs: SpendRequest | readonly SpendRequest[],
): Promise<{ held: Map<string, string[]> }> {
  const report = await collectFindings(ctx, (traits) => traits.holds.spend !== undefined, {
    signedOff: true,
  });
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
  const report = await collectFindings(ctx, (traits) => traits.holds.spend !== undefined, {
    signedOff: true,
  });
  return judgeSpend(ctx, report, req).held;
}

// The findings alone, for a spend that reaches no graph — a delivery upscale's own prompts.
export function assertNoSpendFindings(findings: readonly Finding[], req: SpendRequest): void {
  const error = spendHeldError(req, {
    findings: findings.filter((f) => spendHold(f, req) !== null),
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
  const vouchable = findings.some(
    (f) => findingTraits(f.code).clears === "vouch" && f.code !== "tail-silent",
  );
  return new KonteError(
    "REVIEW_HELD",
    `${blocked} — fix each finding in the file it is listed under` +
      (vouchable
        ? "; dismiss a take found wrong (reroll for another beside it), or `konte vouch <variantId>` one that is fine"
        : ""),
    formatFindingGroups(findings),
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
  const [variantStage] = previewStages;
  const report = await collectFindings(
    !accept && previewStages.size === 1 && variantStage !== "direction"
      ? { ...ctx, variantStage }
      : ctx,
    want,
  );
  const error = reviewHeldError(blocked, reviewHeldFindings(report, ops));
  if (error) throw error;
}
