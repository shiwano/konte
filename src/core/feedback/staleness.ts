import {
  formatAddress,
  formatCompositionAddress,
  parseShotAddress,
  shotStemAssetNames,
  type ShotStage,
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
}

/**
 * A comment is stale when it no longer stands, which happens two ways. The reviewer **signed off
 * over it**: an accept landed on its target at or after it was written (see `acceptedOver`). Or its
 * **subject moved**: what it was written against is no longer what the preview shows.
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
 */
export function feedbackStaleness(
  entry: FeedbackEntry,
  address: string,
  state: KonteState,
  ctx: FeedbackStaleContext = {},
): FeedbackStaleness {
  if (acceptedOver(entry, address, state)) return "stale";
  // An axis the caller gave no context for is not evidence that the comment still stands. Held
  // rather than returned at once: another axis may still find it stale, which is a verdict, and
  // "stale" outranks "we could not look".
  let unevaluated = false;

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
 * The reviewer signed off over the comment: the target it stands on carries an accept stamped at or
 * after it was written. There is no "reject" in a review — a target needing work is one left
 * unaccepted — so accepting with a comment on it says "going with this".
 *
 * A comment written after that accept is not answered by it — a later review asking for work on a
 * signed-off take.
 *
 * Every comment of one review carries that review's timestamp (`applyFeedbackMutations` takes it),
 * so an accept and a comment submitted together compare as accept-after-comment whatever order the
 * handler writes them in.
 */
function acceptedOver(entry: FeedbackEntry, address: string, state: KonteState): boolean {
  const writtenAt = Date.parse(entry.createdAt);
  if (Number.isNaN(writtenAt)) return false;
  // Parsed, not compared as strings: both fields are bare `z.string()`, and `…:00Z` sorts AFTER
  // `…:00.500Z` lexically — which would read an earlier accept as a later one and drop a comment
  // nobody answered.
  const signedOffAt = (at: string | null | undefined): number => (at ? Date.parse(at) : Number.NaN);

  const acceptedAtOrAfter = (addr: string): boolean =>
    Object.values(state.assets[addr]?.variants ?? {}).some(
      // Only an accept answers a comment; a dismissal stamps `decidedAt` too.
      (variant) => variant.status === "accepted" && signedOffAt(variant.decidedAt) >= writtenAt,
    );

  if (acceptedAtOrAfter(address)) return true;
  const shot = parseShotAddress(address);
  // `every`, not `some`: a shot is answered when it is finished, and half of it signed off says
  // nothing about the other half.
  if (shot && shotSignOffAddresses(entry, shot).every(acceptedAtOrAfter)) return true;
  // The direction is variant-less: its sign-off is the per-part acceptance record, so a comment on
  // a part settles exactly as one on an asset does.
  return signedOffAt(state.directionAcceptance?.parts[address]?.acceptedAt) >= writtenAt;
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
