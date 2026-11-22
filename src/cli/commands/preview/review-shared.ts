import { commitAccept } from "../../../core/accept-commit.js";
import { formatShotAddress } from "../../../core/address.js";
import { errorMessage } from "../../../core/errors.js";
import type { Handoff, AnimaticDefinition } from "../../../core/types/index.js";
import type { AddressReviewSubmitBody } from "../../../core/review-submit.js";
import {
  type ReviewDecisionEntry,
  type ReviewRecord,
  saveReviewRecord,
} from "../../../core/review-record.js";
import type { ReviewContext } from "./review-context.js";
import { FeedbackManager } from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/index.js";
import { JobManager } from "../../../core/job-manager.js";
import type { FindingReport } from "../../../core/checks.js";
import { reviewHeldError, reviewHeldFindings } from "../../finding-gates.js";
import {
  applyFeedbackMutations,
  recordFeedbackFor,
  staleFlagsBeforeDecisions,
} from "./feedback-apply.js";
import { applyKeepDecisions, applyRegenerateDecisions } from "./keep-apply.js";

// The handoff (AI -> reviewer) a review record was made against.
export function handoffRecordFields(
  handoff: Handoff | null,
): Pick<ReviewRecord, "handoffId" | "handoffSummary" | "handoffNotes"> {
  return {
    ...(handoff ? { handoffId: handoff.id } : {}),
    ...(handoff?.summary ? { handoffSummary: handoff.summary } : {}),
    ...(handoff && handoff.notes.length > 0 ? { handoffNotes: handoff.notes } : {}),
  };
}

/**
 * Saves a submit's record, stores its overall comment as feedback on the bare stage beside it, and
 * reports where it landed. `force` keeps a record `hasFeedback` would drop. Returns the record's
 * path, or null when there was nothing to save.
 */
export async function persistReview(
  ctx: ReviewContext,
  record: ReviewRecord,
  force: boolean,
): Promise<string | null> {
  const stage = record.stage;
  const filePath = await saveReviewRecord(ctx.videoRoot, record, { force });
  if (filePath && record.overallComment) {
    const text = record.overallComment;
    await FeedbackManager.withLock(ctx.videoRoot, stage, async (mgr) => {
      applyFeedbackMutations(
        mgr,
        [{ address: stage, text, annotation: null }],
        [],
        record.createdAt,
      );
    });
  }
  const regenerate = record.regenerate ?? [];
  ctx.reportOutcome?.({ stage, filePath, ...(regenerate.length > 0 ? { regenerate } : {}) });
  return filePath;
}

// Handoff notes (AI -> reviewer guidance) at one address — a shot, a reference, a direction part —
// shown beside it whether or not anything changed since the last review.
export function handoffNotesAt(handoff: Handoff | null, address: string): string[] {
  return (handoff?.notes ?? []).filter((n) => n.address === address).map((n) => n.text);
}

// The notes no shot of the reel shows — a plate's, the timeline's — which the summary banner carries.
export function unroutedReelHandoffNotes(
  handoff: Handoff | null,
  stage: "video" | "animatic",
  shotIds: readonly string[],
): Array<{ address: string; text: string }> {
  const routed = new Set(shotIds.map((id) => formatShotAddress(stage, id)));
  return (handoff?.notes ?? []).filter((n) => !routed.has(n.address));
}

// What lands and what does not, for an address-keyed review, before the stage builds its record.
type AddressReviewOutcome = {
  acceptedAssets: string[];
  // Upstream deps signed off as a side effect of an accept, tagged with the address they rode in
  // on — persisted so `review record show` names them.
  cascadeAccepted: Array<{ address: string; via: string }>;
  overturned: NonNullable<ReviewRecord["overturned"]>;
  // The verdicts that did NOT land, reported back so the page holds itself open instead of closing
  // on a success that state does not back.
  skippedDecisions: NonNullable<ReviewRecord["skippedDecisions"]>;
  decisions: ReviewDecisionEntry[];
  songLines: NonNullable<ReviewRecord["songLines"]>;
  kept: string[];
  regenerate: string[];
};

// Apply an address-keyed review under the state and feedback locks: write the comments, land each
// accept/un-accept, cascade into the direction, and read back the record's decision lines.
export async function applyAddressReview(
  videoRoot: string,
  body: AddressReviewSubmitBody,
  reviewedAt: string,
  hooks: {
    // The cascade context: the animatic whose panels are (or back) the targets.
    animatic: AnimaticDefinition | null;
    // The findings standing when the decisions land — an accept a finding holds is dropped.
    findings: (mgr: StateManager) => Promise<FindingReport>;
    // A reason to refuse an accept made on this page, or null to let it through.
    refuseAccept?: (address: string, variantId: string, mgr: StateManager) => string | null;
    // Writes the lyric lines the reviewer placed, before any accept lands.
    placeSongLines?: (mgr: StateManager) => {
      placed: AddressReviewOutcome["songLines"];
      skipped: AddressReviewOutcome["skippedDecisions"];
    };
    // The direction parts an applied accept re-signs, tagged with the accept's address.
    cascadeDirection: (
      mgr: StateManager,
      appliedAccepts: ReadonlySet<string>,
      held: (address: string) => boolean,
    ) => Array<{ address: string; via: string }>;
  },
): Promise<AddressReviewOutcome> {
  const acceptedAssets: string[] = [];
  const cascadeAccepted: AddressReviewOutcome["cascadeAccepted"] = [];
  const overturned: AddressReviewOutcome["overturned"] = [];
  const skippedDecisions: AddressReviewOutcome["skippedDecisions"] = [];
  const songLines: AddressReviewOutcome["songLines"] = [];
  // The accepts that actually landed. A decision the loop below drops — a made-up address, a
  // variant pruned since the page loaded, a target whose review prerequisites are unwritten —
  // signed nothing off, so neither the direction cascade nor the record may read it as an accept.
  const appliedAccepts = new Set<string>();
  const kept: string[] = [];
  const regenerate: string[] = [];
  const jobManager = new JobManager(videoRoot);

  const addedFeedbackIds = new Set<string>();
  const editedFeedbackIds = new Set<string>(
    body.feedbackPatches.filter((p) => p.op === "edit").map((p) => p.id),
  );
  const statusOverrideByAddress = new Map(
    (body.decisions ?? []).map((d) => [
      d.address,
      { variantId: d.variantId, status: d.status } as const,
    ]),
  );
  const touchedAddresses = new Set<string>();
  for (const d of body.decisions ?? []) touchedAddresses.add(d.address);
  for (const fb of body.addedFeedback) touchedAddresses.add(fb.address);
  for (const p of body.feedbackPatches) touchedAddresses.add(p.address);

  let decisions: ReviewDecisionEntry[] = [];

  await StateManager.withLock(videoRoot, async (mgr) => {
    await FeedbackManager.withLock(videoRoot, "reference", async (fbMgr) => {
      for (const { id } of applyFeedbackMutations(
        fbMgr,
        body.addedFeedback,
        body.feedbackPatches,
        reviewedAt,
      ).added) {
        addedFeedbackIds.add(id);
      }
      // Read before the decisions below land — see staleFlagsBeforeDecisions.
      const staleBefore = staleFlagsBeforeDecisions(fbMgr, mgr.getState(), {
        view: mgr.stalenessView(),
      });

      if (hooks.placeSongLines) {
        const { placed, skipped } = hooks.placeSongLines(mgr);
        songLines.push(...placed);
        skippedDecisions.push(...skipped);
      }
      const findings = await hooks.findings(mgr);
      const isHeld = (address: string, variantId?: string) =>
        reviewHeldFindings(findings, [{ op: "accept", address, variantId }]).length > 0;

      for (const override of body.decisions ?? []) {
        let committing = false;
        try {
          const refusal =
            override.status === "accepted"
              ? (hooks.refuseAccept?.(override.address, override.variantId, mgr) ?? null)
              : null;
          if (refusal !== null) {
            skippedDecisions.push({ address: override.address, reason: refusal });
            continue;
          }
          if (override.status === "accepted") {
            // A target a finding holds cannot be signed off. Thrown, not skipped inline: the
            // decision loop's catch is what drops this one accept while the feedback written above
            // it — and every other decision — still commits.
            const held = reviewHeldError(
              `Cannot accept ${override.address}`,
              reviewHeldFindings(findings, [
                { op: "accept", address: override.address, variantId: override.variantId },
              ]),
            );
            if (held) throw held;
            committing = true;
            await commitAccept(
              mgr,
              jobManager,
              {
                address: override.address,
                variantId: override.variantId,
                dismiss: override.candidateVariantIds ?? [],
                cascade: { animatic: hooks.animatic, held: isHeld },
              },
              { acceptedAssets, cascadeAccepted, overturned },
            );
            appliedAccepts.add(override.address);
          } else if (override.status === "none") {
            // Only an accept is cleared. A stale page can name a variant that is no longer the
            // accepted one — ignored, never turned back into a candidate.
            const variants = mgr.tryGetAssetState(override.address)?.variants;
            if (variants?.[override.variantId]?.status === "accepted") {
              mgr.setUnaccepted(override.address, override.variantId);
            }
          }
        } catch (err) {
          // Drop just this decision: an address the client made up, a variant pruned since the
          // page loaded, or a target whose review prerequisites are unwritten. Named rather than
          // swallowed — but only where the verdict really did not land: the cascade runs after the
          // accept is written, and a cascade that throws leaves an accept the record reports as
          // made. Reporting it skipped as well would contradict the record it ships with.
          if (committing && mgr.getAcceptedVariant(override.address) === override.variantId) {
            appliedAccepts.add(override.address);
          } else if (!appliedAccepts.has(override.address)) {
            skippedDecisions.push({ address: override.address, reason: errorMessage(err) });
          }
        }
      }

      cascadeAccepted.push(...hooks.cascadeDirection(mgr, appliedAccepts, isHeld));
      kept.push(...applyKeepDecisions(mgr, body.keep ?? [], body.regenerate));
      regenerate.push(...applyRegenerateDecisions(mgr, body.regenerate));

      decisions = [...touchedAddresses].map((address) => {
        const override = statusOverrideByAddress.get(address);
        const entry: ReviewDecisionEntry = {
          address,
          feedback: recordFeedbackFor(
            fbMgr,
            address,
            staleBefore,
            addedFeedbackIds,
            editedFeedbackIds,
          ),
        };
        // An accept the loop above dropped is not what happened, so the record must not read it
        // back as one — the human is told the decisions that landed, not the ones submitted.
        if (override && (override.status !== "accepted" || appliedAccepts.has(address))) {
          entry.variantId = override.variantId;
          entry.status = override.status;
        }
        return entry;
      });
    });
  });

  return {
    acceptedAssets,
    cascadeAccepted,
    overturned,
    skippedDecisions,
    decisions,
    songLines,
    kept,
    regenerate,
  };
}

export function addressReviewTouchesNothing(body: AddressReviewSubmitBody): boolean {
  return (
    (body.decisions ?? []).length === 0 &&
    body.addedFeedback.length === 0 &&
    body.feedbackPatches.length === 0 &&
    (body.keep ?? []).length === 0 &&
    (body.regenerate ?? []).length === 0 &&
    (body.songLines ?? []).length === 0 &&
    !body.overallComment
  );
}
