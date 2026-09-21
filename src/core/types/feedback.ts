import { z } from "zod";

// Annotation coordinates are normalized to the frame: 0-1 from its top-left corner, never pixels —
// so a comment keeps pointing at the same spot when the same shot is reviewed at another size.
// Clamped, not rejected: a drag that ends a hair outside the frame still means "at this edge", and
// rejecting it here would fail the whole feedback stream's load, not just that one pin.
export const NormalizedCoordSchema = z.number().transform(clampUnit);

export function clampUnit(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export const FeedbackAnnotationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pin"), x: NormalizedCoordSchema, y: NormalizedCoordSchema }),
  z.object({
    kind: z.literal("arrow"),
    from: z.object({ x: NormalizedCoordSchema, y: NormalizedCoordSchema }),
    to: z.object({ x: NormalizedCoordSchema, y: NormalizedCoordSchema }),
  }),
]);
export type FeedbackAnnotation = z.infer<typeof FeedbackAnnotationSchema>;

export const FeedbackEntrySchema = z.object({
  id: z.string(),
  // The variant composition the comment was written against: asset address ->
  // variantId shown at authoring time. Drives staleness — a comment goes stale
  // once any of these assets has a different variant accepted (or that accepted
  // variant's inputs change).
  displayedVariants: z.record(z.string(), z.string()).default({}),
  // The variant-less counterpart of `displayedVariants`, set only on a direction comment: the
  // content hash of the direction part it was written against (see `directionPartHashes`). The
  // comment goes stale once that part reads differently, or disappears from the direction.
  subjectHash: z.string().optional(),
  // The materialized-leaf counterpart of `displayedVariants`, set only on a comment whose shot has
  // a composition/stem: leaf address -> its live definition hash at authoring time. A leaf renders
  // live from its definition and only gains a variant when accepted, so a definition edit (a
  // transition, an audio retime) that produces no new variant is invisible to `displayedVariants`;
  // this catches it — the comment goes stale once the leaf's live definition hash no longer matches.
  //
  // `null` records a leaf the definition holds that the page reported no hash for: the definition
  // moved between the page loading and the review landing, so what the reviewer perceived at this
  // leaf is not knowable. Read as `unknown` rather than guessed either way.
  displayedDefinitionHashes: z.record(z.string(), z.string().nullable()).optional(),
  annotation: FeedbackAnnotationSchema.nullable().default(null),
  // Timeline-global playhead position (seconds) the comment was placed at — what the player
  // seeks to and what the ruler markers use.
  time: z.number().optional(),
  // The same instant expressed as an offset within its shot (`time` minus the shot's timeline
  // start), so a comment carries the shot-local position — what `<Audio start>` and friends take —
  // without the reader re-deriving it. Set only on a timed video shot-note; snapshotted at submit
  // from the timeline the reviewer saw, so it stays meaningful even if upstream shot durations later
  // shift the global `time`.
  shotTime: z.number().optional(),
  text: z.string(),
  createdAt: z.string(),
  createdBy: z.string().default("local"),
});
export type FeedbackEntry = z.infer<typeof FeedbackEntrySchema>;

export const FEEDBACK_SCHEMA_VERSION = 1;

// One stage's review stream feedback, persisted at `review/<stage>/feedback.json`.
// Keyed by the full asset address so a single stream file can hold comments for every
// shot/timeline target it covers.
export const FeedbackStreamSchema = z.object({
  schemaVersion: z.number(),
  feedback: z.record(z.string(), z.array(FeedbackEntrySchema)),
});
export type FeedbackStream = z.infer<typeof FeedbackStreamSchema>;
