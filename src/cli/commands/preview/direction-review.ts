import { DIRECTION_SECTIONS, directionSectionOf } from "../../../core/address.js";
import { errorResponse, jsonResponse } from "../../page-host/http.js";
import { directionHash, directionPartHashes } from "../../../core/direction-hash.js";
import {
  type DirectionAcceptanceSummary,
  type DirectionSectionDecisions,
  applyDirectionSectionDecisions,
  directionAcceptSections,
  directionAcceptanceView,
  summarizeDirectionAcceptance,
} from "../../../core/direction-acceptance.js";
import type { Direction } from "../../../core/dsl/direction.js";
import type { DirectionPreviewState } from "../../../core/types/review-state.js";
import type { ReviewDecisionEntry, ReviewRecord } from "../../../core/review-record.js";
import type {
  DirectionSubmitBody,
  DirectionSubmitResponse,
} from "../../../core/types/review-submit.js";
import { reviewModeOf } from "../../../core/review-mode.js";
import { FeedbackManager } from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/index.js";
import {
  buildAddressFeedback,
  applyFeedbackMutations,
  staleFlagsBeforeDecisions,
  recordFeedbackFor,
} from "./feedback-apply.js";
import { handoffNotesAt, handoffRecordFields, persistReview } from "./review-shared.js";
import { directionPreviewState } from "./direction-view.js";
import { emptyOutcome } from "./review-outcome.js";
import type { ReviewContext } from "./submit.js";
import { reviewHeldError, reviewHeldFindings } from "../../finding-gates.js";
import { loadCheckContext } from "../../../core/check-context.js";
import { collectFindings, directionCheckOf, waiverCoverageOf } from "../../../core/checks.js";

// The direction as a media-less review view. Feedback attaches to a synthetic address per
// reviewable part (`direction:<part>`).
export async function handleGetDirectionState(
  ctx: ReviewContext,
  direction: Direction,
): Promise<Response> {
  const { videoRoot, handoff, reference, animatic, video } = ctx;
  const manager = await StateManager.load(videoRoot);
  const feedbackMgr = await FeedbackManager.load(videoRoot, "direction");
  const state = manager.getState();

  const check = directionCheckOf(
    await loadCheckContext({
      cueTakes: "played",
      videoRoot,
      definitions: { reference, animatic, video },
      direction,
      manager,
      graph: null,
    }),
  )!;
  const acceptanceView = directionAcceptanceView(
    direction,
    manager.getDirectionAcceptance(),
    check.waiverCoverage,
  );
  const subjectHashes = directionPartHashes(direction);

  return jsonResponse(
    (await directionPreviewState({
      direction,
      videoRoot,
      handoff,
      directionHash: directionHash(direction),
      sections: acceptanceView.sections,
      acceptSections: directionAcceptSections(
        direction,
        manager.getDirectionAcceptance(),
        check.waiverCoverage,
      ),
      waived: check.waived,
      partView: (address) => ({
        address,
        status: acceptanceView.parts.get(address) ?? "unsigned",
        feedback: buildAddressFeedback(feedbackMgr, state, address, { subjectHashes }),
        handoffNote: handoffNotesAt(handoff, address)[0],
      }),
    })) satisfies DirectionPreviewState,
  );
}

// Direction review submit. Two orthogonal outcomes: per-part feedback
// (routed to the `direction/static` stream) and a single direction Accept (stored in state, keyed
// to the live `directionHash`). The review record — saved only when there is feedback — nests
// under `review/direction/static/records/`; acceptance is durable in state regardless.

export async function handleDirectionSubmit(
  review: ReviewContext,
  direction: Direction,
  body: DirectionSubmitBody,
): Promise<Response> {
  const { videoRoot, handoff, reference, animatic, video, reportOutcome } = review;
  // Stamped before anything is written, so every comment this review carries predates the
  // accepts it was submitted with (see applyFeedbackMutations). The record carries it too: a
  // comment's own review is the one submitted at its createdAt.
  const reviewedAt = new Date().toISOString();

  const currentHash = directionHash(direction);
  const ctx = await loadCheckContext({
    cueTakes: "played",
    videoRoot,
    definitions: { reference, animatic, video },
    direction,
  });
  const waiverCoverage = waiverCoverageOf(ctx);
  const { accept } = body;
  const sectionDecisions: DirectionSectionDecisions =
    accept === undefined
      ? {}
      : Object.fromEntries(
          directionAcceptSections(
            direction,
            ctx.manager?.getDirectionAcceptance() ?? null,
            waiverCoverage,
          ).map((s) => [s, accept]),
        );
  const accepting = Object.values(sectionDecisions).some((v) => v === true);
  // An Accept signs off the box the reviewer saw; if direction.ts changed since the page loaded,
  // refuse rather than record a hash the human never reviewed. The guard is whole-direction even
  // though the verdict is per-section: the page is one read, and an edit anywhere can change what
  // the accepted box means (a shot moving into the act being signed off, say). The watcher's live
  // reload normally keeps the page current — this is the backstop for the edit-during-accept race.
  //
  // The token is mandatory to ACCEPT, not merely honoured when offered: a guard a caller opts into
  // is no guard, since the one caller it must stop is the one that does not know the page moved.
  // A revoke needs no token (it is safe against any version), and a feedback-only submit accepts
  // nothing, so neither has to prove what it read.
  if (accepting) {
    if (body.reviewedHash === undefined) {
      return errorResponse(
        "An accept must name the direction it reviewed (reviewedHash).",
        "INVALID_REQUEST",
        400,
      );
    }
    if (body.reviewedHash !== currentHash) {
      return errorResponse(
        "The direction changed since this review was opened — reload and re-review before accepting.",
        "DIRECTION_CHANGED",
        409,
      );
    }
  }

  // Every reviewable part of the current direction, keyed by its feedback address — both the guard
  // against a comment on a part that doesn't exist (a stale or forged address, which would land in
  // the stream as an un-renderable orphan) and the subject snapshot each new comment carries.
  const subjectHashes = directionPartHashes(direction);
  for (const fb of body.addedFeedback) {
    if (!subjectHashes.has(fb.address)) {
      return errorResponse(
        `Feedback address "${fb.address}" is not a part of the current direction`,
        "INVALID_ADDRESS",
        400,
      );
    }
  }

  const touchedAddresses = new Set<string>();
  for (const fb of body.addedFeedback) touchedAddresses.add(fb.address);
  for (const p of body.feedbackPatches) touchedAddresses.add(p.address);

  if (
    touchedAddresses.size === 0 &&
    Object.keys(sectionDecisions).length === 0 &&
    !body.overallComment
  ) {
    reportOutcome?.(emptyOutcome("direction"));
    return jsonResponse({
      saved: false,
      filePath: null,
      accepted: false,
    } satisfies DirectionSubmitResponse);
  }

  // A box holding a part a finding to fix sits on is not signed off. Only that box's accept is dropped; the rest of the review still lands.
  const skippedDecisions: NonNullable<ReviewRecord["skippedDecisions"]> = [];
  const acceptedSections = DIRECTION_SECTIONS.filter((s) => sectionDecisions[s] === true);
  if (acceptedSections.length > 0) {
    const findings = await collectFindings(ctx, (t) => t.holds.accept === true);
    for (const section of acceptedSections) {
      const held = reviewHeldError(
        `Cannot accept the direction's ${section}`,
        reviewHeldFindings(
          findings,
          [...subjectHashes.keys()]
            .filter((address) => directionSectionOf(address) === section)
            .map((address) => ({ op: "accept", address })),
        ),
      );
      if (!held) continue;
      delete sectionDecisions[section];
      skippedDecisions.push({ address: `direction:${section}`, reason: held.message });
    }
  }

  const addedFeedbackIds = new Set<string>();
  const editedFeedbackIds = new Set<string>(
    body.feedbackPatches.filter((p) => p.op === "edit").map((p) => p.id),
  );

  let reviewDecisions: ReviewDecisionEntry[] = [];
  // What this review left behind, read back under the same lock that wrote it: a concurrent
  // submit settling the other half of the page would otherwise decide whether the gate is open.
  let summary: DirectionAcceptanceSummary = {
    status: "unaccepted",
    blocking: 0,
    total: 0,
    gateBlocking: 0,
    unaccepted: { parts: 0, sections: [] },
    changed: { parts: 0, sections: [] },
  };

  await StateManager.withLock(videoRoot, async (mgr) => {
    await FeedbackManager.withLock(videoRoot, "direction", async (fbMgr) => {
      // The subject snapshot is taken from the live direction, never from the client — a comment is
      // always anchored to the part as it reads right now.
      const added = body.addedFeedback.map((fb) => ({
        ...fb,
        subjectHash: subjectHashes.get(fb.address),
      }));
      for (const { id } of applyFeedbackMutations(fbMgr, added, body.feedbackPatches, reviewedAt)
        .added) {
        addedFeedbackIds.add(id);
      }
      // Before the section decisions below: an accept stamped over a comment ages it, and a record
      // computed after would hide the very comment its accept was made against.
      const staleBefore = staleFlagsBeforeDecisions(fbMgr, mgr.getState(), {
        view: mgr.stalenessView(),
        subjectHashes,
      });
      // A revoke of a box holding no sign-off changes nothing, so it is no outcome to record.
      const signedOff = new Set(
        Object.keys(mgr.getDirectionAcceptance()?.parts ?? {}).map(directionSectionOf),
      );
      for (const section of DIRECTION_SECTIONS) {
        if (sectionDecisions[section] === false && !signedOff.has(section)) {
          delete sectionDecisions[section];
        }
      }
      if (Object.keys(sectionDecisions).length > 0) {
        mgr.setDirectionAcceptance(
          applyDirectionSectionDecisions(
            direction,
            mgr.getDirectionAcceptance(),
            sectionDecisions,
            new Date(),
            waiverCoverage,
          ),
        );
      }
      summary = summarizeDirectionAcceptance(
        direction,
        mgr.getDirectionAcceptance(),
        waiverCoverage,
      );
      reviewDecisions = [...touchedAddresses].map((address) => ({
        address,
        feedback: recordFeedbackFor(
          fbMgr,
          address,
          staleBefore,
          addedFeedbackIds,
          editedFeedbackIds,
        ),
      }));
    });
  });

  const record: ReviewRecord = {
    mode: reviewModeOf("direction"),
    stage: "direction",
    createdAt: reviewedAt,
    context: { shots: [], directionParts: Object.fromEntries(subjectHashes) },
    decisions: reviewDecisions,
    ...(Object.keys(sectionDecisions).length > 0
      ? {
          directionDecisions: Object.fromEntries(
            Object.entries(sectionDecisions).map(([section, accept]) => [
              section,
              accept ? ("accepted" as const) : ("none" as const),
            ]),
          ),
        }
      : {}),
    directionGate: {
      open: summary.gateBlocking === 0,
      blocking: summary.gateBlocking,
      total: summary.total,
    },
    ...(body.overallComment ? { overallComment: body.overallComment } : {}),
    ...handoffRecordFields(handoff),
  };
  if (skippedDecisions.length > 0) record.skippedDecisions = skippedDecisions;
  const filePath = await persistReview(review, record, skippedDecisions.length > 0);

  return jsonResponse({
    saved: filePath !== null,
    filePath,
    accepted: summary.status === "accepted",
    ...(skippedDecisions.length > 0 ? { skippedDecisions } : {}),
  } satisfies DirectionSubmitResponse);
}
