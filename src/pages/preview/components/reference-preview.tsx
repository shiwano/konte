import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { submitReferenceReview } from "../api.js";
import { withDisplayedVariants } from "../review/displayed-variants.js";
import { normalizedPointIn } from "../review/normalized-point.js";
import { ReviewShell, type ShortcutRows } from "../review/review-shell.js";
import {
  referenceAcceptUnits,
  referenceBulkAccept,
  referenceDecisionFor,
  referenceEffectiveStatus,
  referenceUndecidedAssets,
} from "../review/reference-decisions.js";
import { commentedAddresses } from "../review/undecided.js";
import { useEffectiveVariants } from "../review/use-effective-variants.js";
import { useHighlightedFeedback } from "../review/use-highlighted-feedback.js";
import { usePendingPin } from "../review/use-pending-pin.js";
import { type SubmitInput, useReviewSession } from "../review/use-review-session.js";
import { useReviewShortcuts } from "../review/use-review-shortcuts.js";
import {
  EMPTY_KEEP_GRAPH,
  keepDecisions,
  keepPrompt,
  keepPromptFor,
  regenerateByUnit,
  regenerateDecisions,
  regenerateSummary,
  takeNames,
  unitLabel,
  withoutUnits,
  type KeepChoice,
  type KeepContext,
} from "../review/keep-or-regenerate.js";
import { useKeepChoices } from "../review/use-keep-choices.js";
import type {
  FeedbackInfo,
  MediaKind,
  ReferenceAssetInfo,
  ReferencePreviewState,
  VariantStatus,
} from "../types.js";
import { AcceptButton } from "./accept-button.js";
import { CheckIcon, GridIcon, VolumeIcon } from "./icons.js";
import {
  buildPinIndex,
  CommentThread,
  type PendingFeedbackItem,
  RosterCard,
} from "./comment-thread.js";
import { FrameOverlay } from "./frame-overlay.js";
import { Modal } from "./modal.js";
import { PinLayer } from "./pin-layer.js";
import { ReviewHeaderActions } from "./review-header-actions.js";
import { StatusBadge } from "./status-badge.js";
import { AssetInfoPanel, type InfoTake, takeInfo } from "./asset-info-panel.js";
import { VariantGallery } from "./variant-gallery.js";
import { KeepOrRegenerateModal } from "./keep-or-regenerate-modal.js";
import { RegenerateBadge, type RegenerateMark } from "./regenerate-badge.js";

const SHORTCUTS: ShortcutRows = [
  [["J", "K"], "Previous / next asset"],
  [["A"], "Accept / un-accept the focused asset"],
  [["N"], "Jump to next unreviewed asset"],
  [["S"], "Toggle hide-stale notes"],
  [["?"], "Toggle this shortcuts panel"],
  [["⌘/Ctrl", "⏎"], "Submit review"],
];

// An all-`file` reference stage has no accept decision, so the keys that drive one are gone too.
const SHORTCUTS_NO_ACCEPT: ShortcutRows = SHORTCUTS.filter(
  ([keys]) => keys[0] !== "A" && keys[0] !== "N",
);

// Whether the shown variant is stale. Per-variant (not the asset-level `needsReview`, which
// only ever describes the server's accepted variant) so switching to a fresh variant and
// accepting it actually clears the "Needs review" state instead of reporting the old one.
function isSelectedStale(asset: ReferenceAssetInfo, selected: string | null): boolean {
  return asset.variants.find((v) => v.variantId === selected)?.stale ?? false;
}

// An accept the shown variant's staleness has outrun: the detail modal's button still reads
// "Accepted" but drops its highlight, the enlarged view's form of the "Changed"
// badge the inline row carries. No accept here settles it (`konte reroll` does), so it stays out
// of `unacceptedAddresses` and everything keyed on it.
function referenceNeedsReview(
  asset: ReferenceAssetInfo,
  selected: string | null,
  effectiveStatus: VariantStatus,
): boolean {
  return effectiveStatus === "accepted" && isSelectedStale(asset, selected);
}

// One labelled table per media kind, in this order. An empty group is skipped at render time.
const GROUPS: Array<{ kind: MediaKind; title: string }> = [
  { kind: "image", title: "Images" },
  { kind: "video", title: "Videos" },
  { kind: "audio", title: "Audio" },
];

export function ReferencePreview({ state }: { state: ReferencePreviewState }): React.ReactElement {
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, { variantId: string; status: VariantStatus }>
  >({});
  // The asset whose enlarged detail modal is open. Pins and notes are authored there against
  // the same per-address feedback state as the inline row.
  const [detail, setDetail] = useState<{ address: string } | null>(null);
  // The take whose declaration panel is open, stacked over whichever overlay opened it.
  const [infoTake, setInfoTake] = useState<InfoTake | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [highlightedFeedbackId, setHighlightedFeedbackId] = useHighlightedFeedback();
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    choices: keepChoices,
    asking: keepAsking,
    request: requestKeep,
    answer: answerKeep,
    dropUnits: dropKeepUnits,
    keepUnit: keepUnitAfterAll,
    reset: resetKeep,
  } = useKeepChoices();
  const keepGraph = state.keep ?? EMPTY_KEEP_GRAPH;

  // Every asset in the order the tables render them — the sequence J/K/N walk.
  const orderedAssets = useMemo(
    () => GROUPS.flatMap(({ kind }) => state.assets.filter((a) => a.mediaKind === kind)),
    [state.assets],
  );

  // Accept is per-variant: a row is "accepted" only when the variant currently shown is the
  // accepted one. Switching to another variant in the gallery flips the row back to "none"
  // until that variant is explicitly accepted — so the badge and the accept button always
  // reflect what submit would actually persist.
  const getEffectiveStatus = useCallback(
    (asset: ReferenceAssetInfo, selected: string | null): VariantStatus =>
      referenceEffectiveStatus(asset, selected, statusOverrides[asset.address]),
    [statusOverrides],
  );

  // The minimal set of accept/un-accept decisions to send — see `referenceDecisionFor` for what
  // counts as a decision worth sending.
  const pendingDecisions = useMemo(() => {
    const out: Array<{ address: string; variantId: string; status: VariantStatus }> = [];
    for (const [address, o] of Object.entries(statusOverrides)) {
      const asset = state.assets.find((a) => a.address === address);
      if (!asset) continue;
      const decision = referenceDecisionFor(asset, o);
      if (decision) out.push(decision);
    }
    return out;
  }, [statusOverrides, state.assets]);

  const session = useReviewSession({
    hasExtraChanges: pendingDecisions.length > 0 || keepChoices.length > 0,
  });
  const effectiveVariants = useEffectiveVariants(state.assets, session.selectedVariants);
  const pin = usePendingPin(session);

  // What a Keep-or-regenerate prompt reads, under the accept marks the accept being asked about leaves.
  const keepContextFor = useCallback(
    (
      overrides: Record<string, { variantId: string; status: VariantStatus }>,
      choices: readonly KeepChoice[],
    ): KeepContext => ({
      graph: keepGraph,
      takeAccepted: (address) => {
        const mark = overrides[address];
        return mark
          ? mark.status === "accepted"
          : keepGraph.addresses[address]?.acceptedVariantId != null;
      },
      takeOf: (address) => {
        const asset = state.assets.find((a) => a.address === address);
        return asset
          ? (effectiveVariants[address] ?? asset.variantId)
          : (keepGraph.addresses[address]?.acceptedVariantId ?? null);
      },
      choices,
    }),
    [keepGraph, state.assets, effectiveVariants],
  );

  // Accept is a toggle on the shown variant: accept it, or clear an already-accepted one.
  const handleAcceptRow = useCallback(
    (asset: ReferenceAssetInfo, selected: string) => {
      const next: VariantStatus =
        getEffectiveStatus(asset, selected) === "accepted" ? "none" : "accepted";
      const mark = { variantId: selected, status: next };
      const apply = () => setStatusOverrides((prev) => ({ ...prev, [asset.address]: mark }));
      if (next === "none") {
        dropKeepUnits([asset.address]);
        apply();
        return;
      }
      const entries = keepPromptFor(
        keepContextFor(
          { ...statusOverrides, [asset.address]: mark },
          withoutUnits(keepChoices, [asset.address]),
        ),
        [{ unit: asset.address, chosen: { [asset.address]: selected } }],
      );
      requestKeep(entries, apply, [asset.address]);
    },
    [getEffectiveStatus, dropKeepUnits, keepContextFor, statusOverrides, keepChoices, requestKeep],
  );

  const regenerateMarks = useMemo(() => {
    const out = new Map<string, RegenerateMark>();
    for (const [unit, mark] of regenerateByUnit(keepChoices)) {
      out.set(unit, {
        origin: unitLabel(keepGraph, mark.origin, "reference"),
        follows:
          mark.follows === null
            ? null
            : { id: mark.follows, label: unitLabel(keepGraph, mark.follows, "reference") },
        takes: takeNames(unit, mark.takes),
      });
    }
    return out;
  }, [keepChoices, keepGraph]);

  // The one answer behind every review affordance here — the unreviewed count, the N jump, Accept
  // all's label AND the "Needs review" filter. See bulk-accept.ts.
  const {
    unaccepted: unacceptedAddresses,
    done: everythingAccepted,
    acceptAll,
  } = useMemo(
    () => referenceBulkAccept(state.assets, effectiveVariants, statusOverrides),
    [state.assets, effectiveVariants, statusOverrides],
  );

  // Nothing persists until Submit, so no confirm dialog — each mark stays individually reversible.
  // Every asset it accepts asks through one prompt.
  const handleAcceptAll = useCallback(() => {
    const next = acceptAll(statusOverrides);
    const origins = state.assets
      .filter((a) => {
        const shown = effectiveVariants[a.address] ?? a.variantId;
        return (
          shown !== null &&
          next[a.address]?.status === "accepted" &&
          getEffectiveStatus(a, shown) !== "accepted"
        );
      })
      .map((a) => ({ unit: a.address, chosen: { [a.address]: next[a.address]!.variantId } }));
    const units = origins.map((o) => o.unit);
    const entries = keepPromptFor(keepContextFor(next, withoutUnits(keepChoices, units)), origins);
    requestKeep(entries, () => setStatusOverrides(next), units);
  }, [
    acceptAll,
    statusOverrides,
    state.assets,
    effectiveVariants,
    getEffectiveStatus,
    keepContextFor,
    keepChoices,
    requestKeep,
  ]);

  // With no readable variant on the page there is nothing to accept, jump to, or sign off — only
  // notes reach the server.
  const hasReviewableAssets = referenceAcceptUnits(state.assets).length > 0;

  // The assets left with neither an accept nor a live comment — named once at Submit, since the
  // record would show them unaccepted with no reason (see review/undecided.ts).
  const undecided = useMemo(
    () =>
      referenceUndecidedAssets(
        state.assets,
        effectiveVariants,
        statusOverrides,
        commentedAddresses(
          state.assets.flatMap((a) => a.feedback),
          session,
        ),
      ),
    [state.assets, effectiveVariants, statusOverrides, session],
  );

  // Switching the shown variant resets any pending accept/un-accept intent for that asset, so
  // the badge (and what submit persists) can never disagree with what is on screen.
  const handleUseVariant = useCallback(
    (address: string, variantId: string) => {
      session.useVariant(address, variantId);
      dropKeepUnits([address]);
      setStatusOverrides((prev) => {
        if (!(address in prev)) return prev;
        const next = { ...prev };
        delete next[address];
        return next;
      });
    },
    [session, dropKeepUnits],
  );

  const scrollToAsset = useCallback((address: string) => {
    containerRef.current
      ?.querySelector(`[data-address="${address}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const handleJumpToUnreviewed = useCallback(() => {
    if (unacceptedAddresses.size === 0) return;
    for (let i = 1; i <= orderedAssets.length; i++) {
      const cand = orderedAssets[(focusIdx + i) % orderedAssets.length]!;
      if (unacceptedAddresses.has(cand.address)) {
        setFocusIdx((focusIdx + i) % orderedAssets.length);
        scrollToAsset(cand.address);
        return;
      }
    }
  }, [unacceptedAddresses, orderedAssets, focusIdx, scrollToAsset]);

  const submitReview = useCallback(
    async ({ addedFeedback, feedbackPatches, overallComment }: SubmitInput) => {
      await submitReferenceReview({
        addedFeedback: withDisplayedVariants(addedFeedback, state.assets, effectiveVariants),
        feedbackPatches,
        decisions: pendingDecisions,
        ...(overallComment ? { overallComment } : {}),
        ...(keepChoices.length > 0
          ? { keep: keepDecisions(keepChoices), regenerate: regenerateDecisions(keepChoices) }
          : {}),
      });
    },
    [pendingDecisions, state.assets, effectiveVariants, keepChoices],
  );
  const handleSubmit = session.openSubmit;

  const moveFocus = (idx: number) => {
    setFocusIdx(idx);
    if (orderedAssets[idx]) scrollToAsset(orderedAssets[idx].address);
  };
  useReviewShortcuts({
    blocked:
      !!session.gallery ||
      !!detail ||
      infoTake !== null ||
      session.submitOpen ||
      keepAsking !== null,
    onSubmit: handleSubmit,
    handlers: {
      j: () => moveFocus(Math.min(focusIdx + 1, orderedAssets.length - 1)),
      k: () => moveFocus(Math.max(focusIdx - 1, 0)),
      a: () => {
        const asset = orderedAssets[focusIdx];
        if (asset?.variantId) {
          handleAcceptRow(asset, effectiveVariants[asset.address] ?? asset.variantId);
        }
      },
      n: handleJumpToUnreviewed,
      s: () => session.setHideStale(!session.hideStale),
    },
  });

  const galleryAsset = session.gallery
    ? state.assets.find((a) => a.address === session.gallery!.address)
    : null;
  const detailAsset = detail ? state.assets.find((a) => a.address === detail.address) : null;
  const focusedAddress = orderedAssets[focusIdx]?.address ?? null;

  return (
    <ReviewShell
      error={session.error}
      onDismissError={() => session.setError(null)}
      handoffSummary={state.handoffSummary}
      showChangedOnly={session.showChangedOnly}
      onToggleChangedOnly={() => session.setShowChangedOnly(!session.showChangedOnly)}
      hideStale={session.hideStale}
      onToggleHideStale={() => session.setHideStale(!session.hideStale)}
      shortcuts={hasReviewableAssets ? SHORTCUTS : SHORTCUTS_NO_ACCEPT}
      headerExtra={
        <ReviewHeaderActions
          next={
            hasReviewableAssets
              ? { count: unacceptedAddresses.size, noun: "asset", onClick: handleJumpToUnreviewed }
              : undefined
          }
          acceptAll={
            hasReviewableAssets
              ? {
                  done: everythingAccepted,
                  what: "every reviewable asset",
                  onClick: handleAcceptAll,
                }
              : undefined
          }
          reset={{
            disabled: !session.hasPendingChanges,
            onClick: () => {
              setStatusOverrides({});
              resetKeep();
              pin.cancelPin();
              setHighlightedFeedbackId(null);
              session.reset();
            },
          }}
        />
      }
      submitting={session.submitting}
      submitted={session.submitted}
      submittedTitle="Review Submitted"
      canSubmit={session.hasPendingChanges}
      submitHint={
        hasReviewableAssets
          ? "Nothing to submit yet. Accept an asset, leave a note, or write an overall comment above."
          : "No asset here takes an accept. Leave a note, or write an overall comment above."
      }
      onSubmit={handleSubmit}
      undecided={undecided}
      regenerate={regenerateSummary(keepGraph, keepChoices, "reference")}
      submitOpen={session.submitOpen}
      overallComment={session.overallComment}
      onOverallCommentChange={session.setOverallComment}
      onConfirmSubmit={() => void session.confirmSubmit(submitReview)}
      onCancelSubmit={session.cancelSubmit}
    >
      <div className="reference-preview" ref={containerRef}>
        {GROUPS.map(({ kind, title }) => {
          const assets = orderedAssets.filter(
            (a) =>
              a.mediaKind === kind &&
              (!session.showChangedOnly || unacceptedAddresses.has(a.address)),
          );
          if (assets.length === 0) return null;
          return (
            <section key={kind} className="reference-group">
              <h2 className="reference-group-title">{title}</h2>
              <table className="review-table-element">
                <thead>
                  <tr>
                    <th className="reference-col-media">Asset</th>
                    <th className="review-col-feedback">Feedback</th>
                    <th className="review-col-accept">Accept</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => {
                    const selectedVariantId = effectiveVariants[asset.address] ?? asset.variantId;
                    const effectiveStatus = getEffectiveStatus(asset, selectedVariantId);
                    return (
                      <ReferenceRow
                        key={asset.address}
                        asset={asset}
                        selectedVariantId={selectedVariantId}
                        effectiveStatus={effectiveStatus}
                        focused={focusedAddress === asset.address}
                        hasOverride={asset.address in statusOverrides}
                        regenerate={regenerateMarks.get(asset.address)}
                        onKeepAfterAll={() => keepUnitAfterAll(asset.address)}
                        onJumpToUnit={scrollToAsset}
                        pendingFeedback={session.pendingFeedback[asset.address] ?? []}
                        pendingPin={pin.pinFor(asset.address)}
                        hideStale={session.hideStale}
                        deletedFeedbackIds={session.deletedFeedbackIds}
                        editedTextById={session.editedTextById}
                        highlightedFeedbackId={highlightedFeedbackId}
                        onFocus={() => setFocusIdx(orderedAssets.indexOf(asset))}
                        onHighlightPin={setHighlightedFeedbackId}
                        onOpenGallery={() => session.setGallery({ address: asset.address })}
                        onOpenInfo={
                          selectedVariantId && takeInfo(asset.variants, selectedVariantId)
                            ? () =>
                                setInfoTake({
                                  address: asset.address,
                                  variantId: selectedVariantId,
                                })
                            : undefined
                        }
                        onOpenDetail={() => setDetail({ address: asset.address })}
                        onAccept={(variantId) => handleAcceptRow(asset, variantId)}
                        onAddPending={(text) => pin.addPending(asset.address, text)}
                        onRemovePending={(id) => session.removePending(asset.address, id)}
                        onEditPending={(id, text) => session.editPending(asset.address, id, text)}
                        onEditExisting={(id, text) => session.editExisting(id, asset.address, text)}
                        onDeleteExisting={(id) => session.deleteExisting(id, asset.address)}
                        onPinPlace={(x, y) => pin.placePin(asset.address, x, y)}
                        onCancelPin={pin.cancelPin}
                      />
                    );
                  })}
                </tbody>
              </table>
            </section>
          );
        })}

        {galleryAsset && (
          <VariantGallery
            label={galleryAsset.assetName}
            kind={galleryAsset.mediaKind}
            variants={galleryAsset.variants}
            selectedVariantId={effectiveVariants[galleryAsset.address] ?? galleryAsset.variantId}
            onUse={(variantId) => handleUseVariant(galleryAsset.address, variantId)}
            onOpenInfo={(variantId) => setInfoTake({ address: galleryAsset.address, variantId })}
            infoOpen={infoTake !== null}
            onClose={() => session.setGallery(null)}
          />
        )}

        {detailAsset &&
          !session.gallery &&
          (() => {
            const selectedVariantId =
              effectiveVariants[detailAsset.address] ?? detailAsset.variantId;
            const effectiveStatus = getEffectiveStatus(detailAsset, selectedVariantId);
            return (
              <ReferenceDetailModal
                asset={detailAsset}
                selectedVariantId={selectedVariantId}
                effectiveStatus={effectiveStatus}
                needsReviewNow={referenceNeedsReview(
                  detailAsset,
                  selectedVariantId,
                  effectiveStatus,
                )}
                pendingFeedback={session.pendingFeedback[detailAsset.address] ?? []}
                pendingPin={pin.pinFor(detailAsset.address)}
                hideStale={session.hideStale}
                deletedFeedbackIds={session.deletedFeedbackIds}
                editedTextById={session.editedTextById}
                highlightedFeedbackId={highlightedFeedbackId}
                onHighlightPin={setHighlightedFeedbackId}
                onClose={() => setDetail(null)}
                onOpenGallery={() => session.setGallery({ address: detailAsset.address })}
                onAccept={(variantId) => handleAcceptRow(detailAsset, variantId)}
                onAddPending={(text) => pin.addPending(detailAsset.address, text)}
                onRemovePending={(id) => session.removePending(detailAsset.address, id)}
                onEditPending={(id, text) => session.editPending(detailAsset.address, id, text)}
                onEditExisting={(id, text) => session.editExisting(id, detailAsset.address, text)}
                onDeleteExisting={(id) => session.deleteExisting(id, detailAsset.address)}
                onPinPlace={(x, y) => pin.placePin(detailAsset.address, x, y)}
                onCancelPin={pin.cancelPin}
              />
            );
          })()}

        {keepAsking && (
          <KeepOrRegenerateModal
            prompt={keepPrompt(keepGraph, keepAsking.entries, "reference")}
            accepting={keepAsking.origins.length}
            onAnswer={answerKeep}
          />
        )}

        {infoTake &&
          (() => {
            const asset = state.assets.find((a) => a.address === infoTake.address);
            const info = asset && takeInfo(asset.variants, infoTake.variantId);
            if (!asset || !info) return null;
            return (
              <AssetInfoPanel
                assetName={asset.assetName}
                address={asset.address}
                variantId={infoTake.variantId}
                info={info}
                onClose={() => setInfoTake(null)}
              />
            );
          })()}
      </div>
    </ReviewShell>
  );
}

// Image surface with a pin overlay: a click drops a pin at normalized 0–1 coords, inline and in
// the detail modal alike.
function ReferenceImageMedia({
  asset,
  imageUrl,
  pins,
  pendingPins,
  pendingPin,
  hideStale,
  deletedFeedbackIds,
  pinIndexById,
  highlightedId,
  large,
  overlay,
  onPlacePin,
  onPinClick,
}: {
  asset: ReferenceAssetInfo;
  imageUrl: string | null;
  pins: FeedbackInfo[];
  pendingPins: PendingFeedbackItem[];
  pendingPin: { x: number; y: number } | null;
  hideStale: boolean;
  deletedFeedbackIds: Set<string>;
  pinIndexById?: Map<string, number>;
  highlightedId?: string | null;
  large?: boolean;
  overlay?: React.ReactNode;
  onPlacePin: (x: number, y: number) => void;
  onPinClick: (id: string) => void;
}): React.ReactElement {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const { x, y } = normalizedPointIn(e.currentTarget.getBoundingClientRect(), e);
      onPlacePin(x, y);
    },
    [onPlacePin],
  );

  return (
    <div
      role="presentation"
      className={`reference-card-media reference-card-media--pinnable${large ? " reference-detail-image" : ""}`}
      onClick={handleClick}
    >
      {imageUrl ? (
        <img
          className="reference-card-img"
          src={imageUrl}
          alt={asset.assetName}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="reference-card-empty">No media</span>
      )}
      <PinLayer
        pins={pins}
        pendingPins={pendingPins}
        pendingPin={pendingPin}
        hideStale={hideStale}
        deletedFeedbackIds={deletedFeedbackIds}
        pinIndexById={pinIndexById}
        highlightedId={highlightedId}
        onPinClick={onPinClick}
      />
      {overlay}
    </div>
  );
}

// Inline media for non-image assets: both audio and video keep a native inline player, so a clip
// plays in place. Full-size playback is the frame's enlarge action, not a click on the player.
function ReferenceMedia({
  asset,
  variant,
  overlay,
}: {
  asset: ReferenceAssetInfo;
  variant: { imageUrl: string | null; fileUrl?: string | null };
  overlay?: React.ReactNode;
}): React.ReactElement {
  if (asset.mediaKind === "audio") {
    return (
      <div className="reference-card-media reference-card-media--audio">
        <span className="reference-card-audio-glyph">
          <VolumeIcon size={32} />
        </span>
        {variant.fileUrl && (
          <audio className="reference-card-audio" src={variant.fileUrl} controls preload="none">
            <track kind="captions" />
          </audio>
        )}
        {overlay}
      </div>
    );
  }
  return (
    <div className="reference-card-media">
      {variant.fileUrl ? (
        <video
          className="reference-card-video"
          src={variant.fileUrl}
          poster={variant.imageUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
        />
      ) : variant.imageUrl ? (
        <img
          className="reference-card-img"
          src={variant.imageUrl}
          alt={asset.assetName}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="reference-card-empty">No media</span>
      )}
      {overlay}
    </div>
  );
}

function ReferenceRow({
  asset,
  selectedVariantId,
  effectiveStatus,
  focused,
  hasOverride,
  regenerate,
  onKeepAfterAll,
  onJumpToUnit,
  pendingFeedback,
  hideStale,
  deletedFeedbackIds,
  editedTextById,
  highlightedFeedbackId,
  onFocus,
  onHighlightPin,
  onOpenGallery,
  onOpenInfo,
  onOpenDetail,
  onAccept,
  pendingPin,
  onAddPending,
  onRemovePending,
  onEditPending,
  onEditExisting,
  onDeleteExisting,
  onPinPlace,
  onCancelPin,
}: {
  asset: ReferenceAssetInfo;
  selectedVariantId: string | null;
  effectiveStatus: VariantStatus;
  focused: boolean;
  hasOverride: boolean;
  // The Regenerate answer standing for this asset; a follow's names the asset answered for it.
  regenerate?: RegenerateMark;
  onKeepAfterAll: () => void;
  onJumpToUnit: (address: string) => void;
  pendingFeedback: PendingFeedbackItem[];
  pendingPin: { x: number; y: number } | null;
  hideStale: boolean;
  deletedFeedbackIds: Set<string>;
  editedTextById: Map<string, string>;
  highlightedFeedbackId: string | null;
  onFocus: () => void;
  onHighlightPin: (id: string) => void;
  onOpenGallery: () => void;
  onOpenInfo?: () => void;
  onOpenDetail: () => void;
  onAccept: (variantId: string) => void;
  onAddPending: (text: string) => void;
  onRemovePending: (id: string) => void;
  onEditPending: (id: string, text: string) => void;
  onEditExisting: (id: string, text: string) => void;
  onDeleteExisting: (id: string) => void;
  onPinPlace: (x: number, y: number) => void;
  onCancelPin: () => void;
}): React.ReactElement {
  // The shown media follows the gallery selection (override), else the resolved variant.
  const shown =
    asset.variants.find((v) => v.variantId === selectedVariantId) ??
    ({ imageUrl: asset.imageUrl, fileUrl: asset.fileUrl ?? null } as {
      imageUrl: string | null;
      fileUrl?: string | null;
    });

  const isImage = asset.mediaKind === "image";

  // A fresh reroll landed beside the accepted take (auto-shown by default) — surfaced on the
  // variant pill so the reviewer knows the pending state is a newer take awaiting re-accept.
  const hasNewerTake = asset.variants.some((v) => v.isNew);

  const pinIndexById = buildPinIndex(asset.feedback, pendingFeedback, {
    hideStale,
    deletedFeedbackIds,
  });

  const overlay = (
    <FrameOverlay
      assetName={asset.assetName}
      variants={asset.variants}
      hasNewerVariant={hasNewerTake}
      onOpenGallery={onOpenGallery}
      onOpenInfo={onOpenInfo}
      onEnlarge={shown.imageUrl || shown.fileUrl ? onOpenDetail : undefined}
    />
  );

  return (
    <tr
      className={`review-row${focused ? " review-row--focused" : ""}`}
      data-address={asset.address}
      onClick={onFocus}
    >
      <td className="reference-col-media">
        {isImage ? (
          <ReferenceImageMedia
            asset={asset}
            imageUrl={shown.imageUrl}
            pins={asset.feedback}
            pendingPins={pendingFeedback}
            pendingPin={pendingPin}
            hideStale={hideStale}
            deletedFeedbackIds={deletedFeedbackIds}
            pinIndexById={pinIndexById}
            highlightedId={highlightedFeedbackId}
            overlay={overlay}
            onPlacePin={onPinPlace}
            onPinClick={onHighlightPin}
          />
        ) : (
          <ReferenceMedia asset={asset} variant={shown} overlay={overlay} />
        )}
      </td>

      <td className="review-col-feedback">
        {asset.directionRoster?.map((part) => (
          <RosterCard
            key={`${part.kind}:${part.name}`}
            kind={part.kind}
            name={part.name}
            description={part.description}
            needsReview={part.needsReview}
          />
        ))}
        <CommentThread
          feedback={asset.feedback}
          pendingFeedback={pendingFeedback}
          pendingPin={pendingPin}
          handoffNotes={
            asset.handoffNote
              ? [{ assetName: asset.assetName, text: asset.handoffNote }]
              : undefined
          }
          emptyHint={
            isImage
              ? "No notes on this asset yet. Add one below, or click the frame to pin one."
              : "No notes on this asset yet. Add one below."
          }
          hideStale={hideStale}
          deletedFeedbackIds={deletedFeedbackIds}
          editedTextById={editedTextById}
          pinIndexById={pinIndexById}
          highlightedId={highlightedFeedbackId}
          onAddPending={onAddPending}
          onRemovePending={onRemovePending}
          onEditPending={onEditPending}
          onEditExisting={onEditExisting}
          onDeleteExisting={onDeleteExisting}
          onHighlightPin={onHighlightPin}
          onCancelPin={onCancelPin}
        />
      </td>

      {/* The decision gets its own column rather than an overlay on the media, so the accept
          control reads the same here as in the animatic review's panel list. */}
      <td className="review-col-accept">
        {hasNewerTake && <StatusBadge status="changed" label="Changed" />}
        {regenerate && (
          <RegenerateBadge mark={regenerate} onKeep={onKeepAfterAll} onJumpToRow={onJumpToUnit} />
        )}
        {selectedVariantId && (
          <AcceptButton
            accepted={effectiveStatus === "accepted"}
            overridden={hasOverride}
            title={effectiveStatus === "accepted" ? "Click to unaccept" : "Accept this variant"}
            onClick={() => onAccept(selectedVariantId)}
          />
        )}
      </td>
    </tr>
  );
}

// Enlarged view of one asset: the media at full size (images are pinnable here), with a notes
// panel, accept toggle, and variant access. Shares the parent's per-address feedback handlers, so
// notes/pins authored here are the same as the inline row's.
function ReferenceDetailModal({
  asset,
  selectedVariantId,
  effectiveStatus,
  needsReviewNow,
  pendingFeedback,
  pendingPin,
  hideStale,
  deletedFeedbackIds,
  editedTextById,
  highlightedFeedbackId,
  onHighlightPin,
  onClose,
  onOpenGallery,
  onAccept,
  onAddPending,
  onRemovePending,
  onEditPending,
  onEditExisting,
  onDeleteExisting,
  onPinPlace,
  onCancelPin,
}: {
  asset: ReferenceAssetInfo;
  selectedVariantId: string | null;
  effectiveStatus: VariantStatus;
  needsReviewNow: boolean;
  pendingFeedback: PendingFeedbackItem[];
  pendingPin: { x: number; y: number } | null;
  hideStale: boolean;
  deletedFeedbackIds: Set<string>;
  editedTextById: Map<string, string>;
  highlightedFeedbackId: string | null;
  onHighlightPin: (id: string) => void;
  onClose: () => void;
  onOpenGallery: () => void;
  onAccept: (variantId: string) => void;
  onAddPending: (text: string) => void;
  onRemovePending: (id: string) => void;
  onEditPending: (id: string, text: string) => void;
  onEditExisting: (id: string, text: string) => void;
  onDeleteExisting: (id: string) => void;
  onPinPlace: (x: number, y: number) => void;
  onCancelPin: () => void;
}): React.ReactElement {
  const shown =
    asset.variants.find((v) => v.variantId === selectedVariantId) ??
    ({ imageUrl: asset.imageUrl, fileUrl: asset.fileUrl ?? null } as {
      imageUrl: string | null;
      fileUrl?: string | null;
    });

  const pinIndexById = buildPinIndex(asset.feedback, pendingFeedback, {
    hideStale,
    deletedFeedbackIds,
  });

  return (
    <Modal
      className="reference-detail"
      escape="unless-typing"
      onClose={onClose}
      title={
        <>
          {asset.assetName}
          {selectedVariantId ? ` · ${selectedVariantId}` : ""}
        </>
      }
      actions={
        <>
          {selectedVariantId && (
            <button
              type="button"
              className={`ctrl-btn reference-accept${
                effectiveStatus === "accepted" && !needsReviewNow ? " reference-accept--on" : ""
              }`}
              onClick={() => onAccept(selectedVariantId)}
            >
              <CheckIcon size={13} /> {effectiveStatus === "accepted" ? "Accepted" : "Accept"}
            </button>
          )}
          {asset.variants.length > 1 && (
            <button type="button" className="ctrl-btn" onClick={onOpenGallery}>
              <GridIcon size={14} /> Variants
            </button>
          )}
        </>
      }
    >
      <div className="reference-detail-body">
        <div className="reference-detail-stage">
          {asset.mediaKind === "image" ? (
            <ReferenceImageMedia
              asset={asset}
              imageUrl={shown.imageUrl}
              pins={asset.feedback}
              pendingPins={pendingFeedback}
              pendingPin={pendingPin}
              hideStale={hideStale}
              deletedFeedbackIds={deletedFeedbackIds}
              pinIndexById={pinIndexById}
              highlightedId={highlightedFeedbackId}
              large
              onPlacePin={onPinPlace}
              onPinClick={onHighlightPin}
            />
          ) : !shown.fileUrl ? (
            <span className="reference-card-empty">No media</span>
          ) : asset.mediaKind === "audio" ? (
            <div className="reference-detail-audio">
              <span className="reference-card-audio-glyph">
                <VolumeIcon size={48} />
              </span>
              <audio
                className="reference-detail-audio-player"
                src={shown.fileUrl}
                controls
                autoPlay
              >
                <track kind="captions" />
              </audio>
            </div>
          ) : (
            <video
              className="reference-detail-video"
              src={shown.fileUrl}
              poster={shown.imageUrl ?? undefined}
              controls
              autoPlay
              playsInline
            />
          )}
        </div>
        <aside className="reference-detail-notes">
          {asset.directionRoster?.map((part) => (
            <RosterCard
              key={`${part.kind}:${part.name}`}
              kind={part.kind}
              name={part.name}
              description={part.description}
            />
          ))}
          <CommentThread
            feedback={asset.feedback}
            pendingFeedback={pendingFeedback}
            pendingPin={pendingPin}
            handoffNotes={
              asset.handoffNote
                ? [{ assetName: asset.assetName, text: asset.handoffNote }]
                : undefined
            }
            hideStale={hideStale}
            deletedFeedbackIds={deletedFeedbackIds}
            editedTextById={editedTextById}
            pinIndexById={pinIndexById}
            highlightedId={highlightedFeedbackId}
            onAddPending={onAddPending}
            onRemovePending={onRemovePending}
            onEditPending={onEditPending}
            onEditExisting={onEditExisting}
            onDeleteExisting={onDeleteExisting}
            onHighlightPin={onHighlightPin}
            onCancelPin={onCancelPin}
          />
        </aside>
      </div>
    </Modal>
  );
}
