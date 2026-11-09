import { z } from "zod";
import { DIRECTION_SECTIONS } from "../address.js";
import {
  ReviewAcceptDecisionSchema,
  ReviewRecordSchema,
  VideoReviewDecisionsSchema,
  type ReviewRecord,
} from "../review-record.js";

// What each submit handler takes from the preview client and then persists. Validated at the door,
// before any mutation: feedback written unvalidated lands in the stream, whose next load parses it —
// so one bad entry fails that load and takes every comment with it — and a malformed decision or
// shown-variant map would only surface at saveReviewRecord, after the accepts and the feedback were
// already committed. One schema per mode, since each handler's required fields differ.
const CommentFieldsSchema = z.object({
  address: z.string(),
  text: z.string(),
  annotation: z
    .object({ kind: z.literal("pin"), x: z.number(), y: z.number() })
    .nullable()
    .optional(),
  time: z.number().optional(),
  shotTime: z.number().optional(),
});

const AddedFeedbackSchema = z.array(
  CommentFieldsSchema.extend({
    displayedVariants: z.record(z.string(), z.string()).optional(),
    displayedDefinitionHashes: z.record(z.string(), z.string()).optional(),
    subjectHash: z.string().optional(),
  }),
);

// The reel's comments carry WHERE they were written and nothing about what they were written
// against: which addresses a target perceives is a question about the definition, and the handler
// answers it (see `commentSubjectAddresses`). A client cannot narrow the subject it does not send —
// which is what a page reading it off one of its own asset arrays did, dropping every audio take.
const ReelAddedFeedbackSchema = z.array(CommentFieldsSchema);

const FeedbackPatchSchema = z.object({
  op: z.enum(["edit", "delete"]),
  id: z.string(),
  address: z.string(),
  text: z.string().optional(),
});

export type FeedbackPatchBody = z.infer<typeof FeedbackPatchSchema>;

// The variant the reviewer saw per address — recorded, and what an accept accepts.
const DisplayedVariantsSchema = z.record(z.string(), z.string());

// Every take the reviewer had in front of them per address — the gallery as the page rendered it.
// An accept dismisses the ones it did not choose (see `StateManager.setAccepted`), so this cannot
// be re-derived at submit time: a reroll that landed mid-review is in state but was never on
// screen.
const DisplayedCandidatesSchema = z.record(z.string(), z.array(z.string()));

// The reviewer's word on the pass as a whole, from the submit dialog. Carried by every stage's
// payload and persisted on the record — it is what a submit that settled nothing still says.
const OverallCommentSchema = z.string();

// The Keep-or-regenerate answers, expanded on the page: each take a Keep names with the upstream it
// was kept against, and each take a Regenerate names.
const KeepSchema = z.array(
  z.object({
    address: z.string(),
    variantId: z.string(),
    inputs: z.record(z.string(), z.string()),
  }),
);
const RegenerateSchema = z.array(z.object({ address: z.string(), variantId: z.string() }));

export type KeepEntryBody = z.infer<typeof KeepSchema>[number];
export type RegenerateEntryBody = z.infer<typeof RegenerateSchema>[number];

export const ReelSubmitSchema = z.object({
  decisions: VideoReviewDecisionsSchema.nullish(),
  // The timeline audio stem (soundtrack beds) accept decision. Per-shot audio rides its shot's
  // accept (which finalizes that shot's stem); the beds — spanning the whole video — are signed off
  // here, via `timeline#stem`.
  timelineStemDecision: ReviewAcceptDecisionSchema.optional(),
  // The overlay's accept decision, offered once every shot accept stands (see `overlayOffered`).
  overlayDecision: ReviewAcceptDecisionSchema.optional(),
  // The video's thumbnail accept decision, at `video:thumbnail#still`.
  thumbnailDecision: ReviewAcceptDecisionSchema.optional(),
  notes: ReviewRecordSchema.shape.notes,
  addedFeedback: ReelAddedFeedbackSchema.optional(),
  feedbackPatches: z.array(FeedbackPatchSchema).optional(),
  // The variant the reviewer actually saw for every reviewable asset. Submit accepts exactly these —
  // never a variant re-resolved at submit time, which could be a reroll that completed mid-review.
  displayedVariants: DisplayedVariantsSchema.optional(),
  // The live definition hash the page was served per materialized leaf (each shot's composition and
  // stem, the timeline stem). A leaf renders from its definition and mints no variant until
  // accepted, so a definition edit is invisible to the takes above; this is the axis that catches
  // it. Whole-page, like `displayedVariants` — the handler selects the leaves each comment stands
  // on.
  displayedDefinitionHashes: DisplayedVariantsSchema.optional(),
  displayedCandidates: DisplayedCandidatesSchema.optional(),
  // The shot ids that stood in with the board instead of a picture that is not made yet, from the
  // client. Same discipline as `displayedVariants`: what a shot showed cannot be re-derived at
  // submit time, because a build dependency finishing mid-review flips the answer — and the verdict
  // would then land on a composition nobody watched. Their verdicts are dropped: a stand-in carries
  // nothing to sign off. REQUIRED, so a caller that cannot say what it displayed is rejected rather
  // than silently falling back to a re-derivation with that exact bug.
  displayedStandInShotIds: z.array(z.string()),
  overallComment: OverallCommentSchema.optional(),
  keep: KeepSchema.optional(),
  regenerate: RegenerateSchema.optional(),
});

export type ReelSubmitBody = z.infer<typeof ReelSubmitSchema>;

const SongLineSchema = z.object({
  variantId: z.string(),
  key: z.string(),
  span: z.object({ startSec: z.number(), endSec: z.number() }).nullable(),
});

export type SongLineBody = z.infer<typeof SongLineSchema>;

// An address-keyed review (reference): one decision entry per address, feedback always sent.
export const AddressReviewSubmitSchema = z.object({
  addedFeedback: AddedFeedbackSchema,
  feedbackPatches: z.array(FeedbackPatchSchema),
  decisions: z
    .array(
      z.object({
        address: z.string(),
        variantId: z.string(),
        status: ReviewAcceptDecisionSchema,
        // The other takes this decision was made among — see DisplayedCandidatesSchema.
        candidateVariantIds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  overallComment: OverallCommentSchema.optional(),
  keep: KeepSchema.optional(),
  regenerate: RegenerateSchema.optional(),
  // Lyric lines the reviewer placed on a take of the song, or left to the reading again (`span`
  // null) — see `setSongLine`.
  songLines: z.array(SongLineSchema).optional(),
});

export type AddressReviewSubmitBody = z.infer<typeof AddressReviewSubmitSchema>;

// The review page accepts per SECTION (the boxes it renders), while state records per part — one
// box's verdict fans out to every part it holds. A section the reviewer never touched is absent
// rather than false, so a feedback-only submit revokes nothing.
export const DirectionSubmitSchema = z.object({
  addedFeedback: AddedFeedbackSchema,
  feedbackPatches: z.array(FeedbackPatchSchema),
  // True signs off every part the section holds, false revokes them (the spend gate re-blocks on
  // that box).
  sectionDecisions: z.record(z.enum(DIRECTION_SECTIONS), z.boolean()).optional(),
  // The direction hash the reviewer actually looked at — the optimistic-concurrency token that stops
  // an Accept from signing off a version edited out from under the open review.
  reviewedHash: z.string().optional(),
  overallComment: OverallCommentSchema.optional(),
});

export type DirectionSubmitBody = z.infer<typeof DirectionSubmitSchema>;

// The verdicts that did NOT land, reported back so the page holds itself open instead of closing on
// a success that state does not back.
export type SkippedDecision = NonNullable<ReviewRecord["skippedDecisions"]>[number];

export interface ReelSubmitResponse {
  saved: boolean;
  filePath: string | null;
  acceptedAssets: string[];
  unacceptedAssets: string[];
  skippedDecisions: SkippedDecision[];
  kept: string[];
  regenerate: string[];
}

// A submit that touched nothing writes no record.
export type AddressReviewSubmitResponse =
  | { saved: false; filePath: null }
  | {
      saved: boolean;
      filePath: string | null;
      acceptedAssets: string[];
      skippedDecisions: SkippedDecision[];
      kept: string[];
      regenerate: string[];
    };

export interface DirectionSubmitResponse {
  saved: boolean;
  filePath: string | null;
  // The WHOLE direction's standing after the submit (the spend gate's question), not whether the
  // sections in this payload were accepted.
  accepted: boolean;
  skippedDecisions?: SkippedDecision[];
}
