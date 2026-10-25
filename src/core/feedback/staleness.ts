import {
  formatAddress,
  formatCompositionAddress,
  getStage,
  parseShotAddress,
  parseStageAddress,
  shotStemAssetNames,
  type ShotStage,
  type Stage,
} from "../address.js";
import { shortId } from "../short-id.js";
import {
  computeVariantStaleness,
  selectResolvedVariant,
  type StalenessCache,
} from "../staleness.js";
import type { FeedbackEntry, KonteState } from "../types/index.js";

export function generateFeedbackId(): string {
  return `fb-${shortId()}`;
}

/**
 * Three answers, not two. A comment whose subject cannot be read — the definitions would not load,
 * so the axis it stands on has no current value to compare against — is neither standing nor
 * answered, and a reader that collapses that into "fresh" reports a comment as still standing
 * however far its subject has moved. Every surface that acts on the verdict (skipping an answered
 * comment, hiding it) must act on "stale" alone.
 */
export type FeedbackStaleness = "fresh" | "stale" | "unknown";

export interface FeedbackWithStaleness extends FeedbackEntry {
  staleness: FeedbackStaleness;
}

export interface FeedbackStaleContext {
  // Current content hash per direction feedback address (`directionPartHashes`). Omit it and a
  // direction comment's subject staleness is left unevaluated — a caller that cannot load
  // direction.ts must not report every comment as stale.
  subjectHashes?: ReadonlyMap<string, string>;
  // Current live definition hash per materialized-leaf address (composition / stem). Omit the map
  // entirely and a leaf comment's definition-hash staleness is left unevaluated — a reader that
  // cannot resolve live hashes must not report every leaf comment as stale. When the map is
  // provided, an address missing from it means the leaf left the definition (its shotFn or audio
  // was removed), which — like a vanished direction part — makes the comment stale.
  definitionHashes?: ReadonlyMap<string, string>;
  // The caller's resolution memo, carrying the definitions its own surface resolved by. Omit it and
  // a media comment's subject is compared against a take the reviewer was not necessarily shown.
  cache?: StalenessCache;
  // When each of a stage's reviews was submitted (`reviewTimes`). Omit it and an overall comment,
  // or one its own review accepted over, is left unevaluated.
  reviewTimes?: ReadonlyMap<Stage, readonly string[]>;
  // The reviewer's own page: an accept answers a comment the moment it lands, the one it was
  // submitted with included.
  reviewerView?: boolean;
}

/**
 * A comment is stale when it no longer stands, which happens two ways. The reviewer **signed off
 * over it**: an accept landed on its target at or after it was written (see `signedOffOver`) — on
 * the reviewer's page at once, from the CLI at once (`closedAt`), elsewhere once a later review is
 * in (see `answeredBySignOff`). Or
 * its **subject moved**: what it was written against is no longer what the preview shows.
 *
 * For a media target the subject is the *resolved* variant — the one actually displayed (accepted if any,
 * else the newest ready variant, else the stale fallback the review surfaces show). The comment is
 * stale if that resolved variant differs from the snapshot (e.g. a reroll surfaced a newer variant,
 * or a different variant was accepted), or the variant it still points at has itself become
 * input/definition-stale. Assets with nothing displayable are ignored (nothing to contradict).
 *
 * A direction comment has no variant: it snapshots its direction part's content hash instead, and is
 * stale once that part changed — or vanished from the direction entirely.
 *
 * A materialized leaf (composition / stem) renders live from its definition and only gains a variant
 * when accepted, so a definition-only edit produces no variant to contradict `displayedVariants`. It
 * additionally snapshots the leaf's live definition hash (`displayedDefinitionHashes`) and is stale
 * once that hash no longer matches what the context reports — or the leaf leaves the definition.
 *
 * An overall comment (on a bare stage) is stale once a later review of the stage was submitted.
 */
export function feedbackStaleness(
  entry: FeedbackEntry,
  address: string,
  state: KonteState,
  ctx: FeedbackStaleContext = {},
): FeedbackStaleness {
  if (entry.closedAt !== undefined) return "stale";
  const writtenAt = Date.parse(entry.createdAt);
  const stage = parseStageAddress(address);
  if (stage !== null) {
    if (!ctx.reviewTimes) return "unknown";
    return (ctx.reviewTimes.get(stage) ?? []).some((at) => Date.parse(at) > writtenAt)
      ? "stale"
      : "fresh";
  }
  // An axis the caller gave no context for is not evidence that the comment still stands. Held
  // rather than returned at once: another axis may still find it stale, which is a verdict, and
  // "stale" outranks "we could not look".
  let unevaluated = false;

  const signOff = signedOffOver(entry, address, state);
  if (signOff !== null) {
    if (ctx.reviewerView) return "stale";
    if (!ctx.reviewTimes) unevaluated = true;
    else if (answeredBySignOff(writtenAt, getStage(address), signOff, ctx.reviewTimes)) {
      return "stale";
    }
  }

  if (entry.subjectHash !== undefined) {
    if (!ctx.subjectHashes) unevaluated = true;
    else if (ctx.subjectHashes.get(address) !== entry.subjectHash) return "stale";
  }
  const leafHashes = Object.entries(entry.displayedDefinitionHashes ?? {});
  if (leafHashes.length > 0 && !ctx.definitionHashes) unevaluated = true;
  for (const [addr, snapshotHash] of leafHashes) {
    // A provided context that lacks the address means the leaf left the definition, which is a
    // verdict of its own: `get` returns undefined, which is ≠ the snapshot.
    if (!ctx.definitionHashes) break;
    // A null snapshot is the writer saying the definition moved while the comment was being
    // written, so it never learned what this leaf showed. There is nothing to compare.
    if (snapshotHash === null) {
      unevaluated = true;
      continue;
    }
    if (ctx.definitionHashes.get(addr) !== snapshotHash) return "stale";
  }
  for (const [addr, snapshotVariantId] of Object.entries(entry.displayedVariants ?? {})) {
    // `includeStale` is what the review surfaces pass, so this asks about the take actually on
    // screen. Without it an all-stale address resolves to null and the comment would read fresh
    // while the reviewer is looking at the very frame its subject moved under.
    const resolved = selectResolvedVariant(state, addr, { includeStale: true }, ctx.cache);
    if (resolved === null) continue;
    if (resolved.variantId !== snapshotVariantId) return "stale";
    // Resolved still matches the snapshot, but a displayed variant can be stale — an accepted one
    // always could be, and with the stale fallback an unaccepted one can too. Its own definition
    // counts as much as its inputs, off the same definitions the selection above used.
    const variant = state.assets[addr]?.variants?.[resolved.variantId];
    if (variant) {
      // The take recorded a definition to be measured against and the caller registered none to
      // measure it with, so that axis is unread rather than clean — the same hole as the two above,
      // kept out today by nothing but every caller happening to register definitions first.
      if (variant.definitionHash !== null && ctx.cache?.definitions === undefined) {
        unevaluated = true;
      }
      const s = computeVariantStaleness(
        state,
        addr,
        variant,
        ctx.cache?.definitions?.definitionHash(addr) ?? null,
        ctx.cache?.definitions?.patchHashes,
        ctx.cache,
      );
      if (s.inputStale || s.definitionStale) return "stale";
    }
  }
  return unevaluated ? "unknown" : "fresh";
}

/**
 * What a bare shot-level target — which holds comments but no variant of its own — has to carry
 * before an accept answers a comment on it: EVERY half the shot has, the composition and, where the
 * shot sounds anything, its stems.
 *
 * Both, because nothing says which half a comment is about. The text is prose on the shot; konte
 * cannot read whether "the mother sounds too crisp" is about the picture or the sound. Signing off
 * on the composition alone therefore closed every shot comment on a guess it had no grounds for,
 * and a note on a line the reviewer never re-heard vanished as answered.
 *
 * Whether the shot HAS a stem is read off the comment's own snapshot rather than the definition:
 * `displayedDefinitionHashes` carries the stem address exactly when the shot sounded something at
 * the time it was written, which is the shot the comment was made against.
 */
function shotSignOffAddresses(
  entry: FeedbackEntry,
  shot: { stage: ShotStage; shotId: string },
): string[] {
  const required = [formatCompositionAddress(shot.stage, shot.shotId)];
  for (const name of shotStemAssetNames(shot.stage)) {
    const stem = formatAddress(shot.stage, shot.shotId, name);
    if (entry.displayedDefinitionHashes && stem in entry.displayedDefinitionHashes) {
      required.push(stem);
    }
  }
  return required;
}

/**
 * When the reviewer signed off over the comment: the instant the target it stands on carried an
 * accept stamped at or after it was written, else null. There is no "reject" in a review — a target
 * needing work is one left unaccepted — so accepting with a comment on it says "going with this".
 *
 * A comment written after that accept is not answered by it — a later review asking for work on a
 * signed-off take.
 *
 * Every comment of one review carries that review's timestamp (`applyFeedbackMutations` takes it),
 * so an accept and a comment submitted together compare as accept-after-comment whatever order the
 * handler writes them in.
 */
export function signedOffOver(
  entry: FeedbackEntry,
  address: string,
  state: KonteState,
): number | null {
  const writtenAt = Date.parse(entry.createdAt);
  if (Number.isNaN(writtenAt)) return null;
  // Parsed, not compared as strings: both fields are bare `z.string()`, and `…:00Z` sorts AFTER
  // `…:00.500Z` lexically — which would read an earlier accept as a later one and drop a comment
  // nobody answered.
  const signedOffAt = (at: string | null | undefined): number => (at ? Date.parse(at) : Number.NaN);

  const acceptedAtOrAfter = (addr: string): number | null => {
    for (const variant of Object.values(state.assets[addr]?.variants ?? {})) {
      // Only an accept answers a comment; a dismissal stamps `decidedAt` too.
      if (variant.status !== "accepted") continue;
      const at = signedOffAt(variant.decidedAt);
      if (at >= writtenAt) return at;
    }
    return null;
  };

  const own = acceptedAtOrAfter(address);
  if (own !== null) return own;
  const shot = parseShotAddress(address);
  if (shot) {
    // `every`, not `some`: a shot is answered when it is finished, and half of it signed off says
    // nothing about the other half. Signed off when its last half was.
    const halves = shotSignOffAddresses(entry, shot).map(acceptedAtOrAfter);
    if (halves.every((at) => at !== null)) return Math.max(...(halves as number[]));
  }
  // The direction is variant-less: its sign-off is the per-part acceptance record, so a comment on
  // a part settles exactly as one on an asset does.
  const part = signedOffAt(state.directionAcceptance?.parts[address]?.acceptedAt);
  return part >= writtenAt ? part : null;
}

/**
 * Whether a sign-off answers the comment off the reviewer's page. One the comment's own review
 * made reads "going with this" to the human, who need not see the comment again, while a comment
 * asking for a change is still an instruction to whoever acts on the review; so it stands until the
 * stage's next review is in. A sign-off a later review made — or made after one — answers it as
 * soon as it lands.
 *
 * A comment's own review is the one submitted at its `createdAt`; a review submitted after it and
 * at or before the sign-off is the one the sign-off came from, or one it followed.
 */
function answeredBySignOff(
  writtenAt: number,
  stage: Stage,
  signOff: number,
  reviewTimes: ReadonlyMap<Stage, readonly string[]>,
): boolean {
  for (const [reviewed, times] of reviewTimes) {
    for (const at of times) {
      const t = Date.parse(at);
      if (t > writtenAt && (reviewed === stage || t <= signOff)) return true;
    }
  }
  return false;
}

export function getFeedbackWithStaleness(
  feedbackList: FeedbackEntry[],
  address: string,
  state: KonteState,
  ctx: FeedbackStaleContext = {},
): FeedbackWithStaleness[] {
  return feedbackList.map((entry) => ({
    ...entry,
    staleness: feedbackStaleness(entry, address, state, ctx),
  }));
}
