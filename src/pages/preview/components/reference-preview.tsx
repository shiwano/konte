import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import {
  GROUP_KIND_LABEL,
  referenceMemberLabel,
  referenceRowLabel,
  referenceSections,
  type ReferenceRowInfo,
  type ReferenceSection,
} from "../review/reference-groups.js";
import { isNarrow } from "../review/narrow.js";
import { commentedAddresses } from "../review/undecided.js";
import { useEffectiveVariants } from "../review/use-effective-variants.js";
import { useHighlightedFeedback } from "../review/use-highlighted-feedback.js";
import { usePendingPin } from "../review/use-pending-pin.js";
import {
  type CommentThreadBinding,
  type SubmitInput,
  useReviewSession,
} from "../review/use-review-session.js";
import { useReviewShortcuts } from "../review/use-review-shortcuts.js";
import {
  EMPTY_KEEP_GRAPH,
  keepDecisions,
  keepPrompt,
  keepPromptFor,
  keepContext,
  regenerateDecisions,
  regenerateMarks,
  regenerateSummary,
  withoutUnits,
  type KeepChoice,
  type KeepContext,
  type RegenerateMark,
} from "../review/keep-or-regenerate.js";
import { useKeepChoices } from "../review/use-keep-choices.js";
import type {
  FeedbackInfo,
  ReferenceAssetInfo,
  ReferenceGroupMemberInfo,
  ReferencePreviewState,
  VariantStatus,
  SongLineEdit,
  SongReadingInfo,
} from "../types.js";
import { AcceptButton } from "./accept-button.js";
import { CheckIcon, CommentIcon, FilmIcon, GridIcon, MenuIcon, VolumeIcon } from "./icons.js";
import { AuditionAudio } from "./audition-audio.js";
import { SongLineEditsContext, SongSummary, SongTrack, unplacedLineCount } from "./song-track.js";
import { buildPinIndex, CommentThread } from "./comment-thread.js";
import { FrameOverlay } from "./frame-overlay.js";
import { Modal } from "./modal.js";
import { PinLayer } from "./pin-layer.js";
import { type ResetAction, ResetButton, ReviewHeaderActions } from "./review-header-actions.js";
import { StatusBadge } from "./status-badge.js";
import { AssetInfoPanel, type InfoVariant, variantInfo } from "./asset-info-panel.js";
import { VariantGallery } from "./variant-gallery.js";
import { KeepOrRegenerateModal } from "./keep-or-regenerate-modal.js";
import { RegenerateBadge } from "./regenerate-badge.js";

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

// What scrolls the page under an element: <main> at phone width, the document otherwise.
function pageScroller(el: Element | null): Element | null {
  const main = el?.closest(".main-content");
  return main && getComputedStyle(main).overflowY !== "visible" ? main : document.scrollingElement;
}

export function ReferencePreview({ state }: { state: ReferencePreviewState }): React.ReactElement {
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, { variantId: string; status: VariantStatus }>
  >({});
  // The asset whose enlarged detail modal is open. Pins and notes are authored there against
  // the same per-address feedback state as the inline row.
  const [detail, setDetail] = useState<{ address: string } | null>(null);
  // The take whose declaration panel is open, stacked over whichever overlay opened it.
  const [infoVariant, setInfoVariant] = useState<InfoVariant | null>(null);
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
  const [songLines, setSongLines] = useState<SongLineEdit[]>([]);
  const songLineEdits = useMemo(() => {
    const others = (variantId: string, key: string) =>
      songLines.filter((e) => e.variantId !== variantId || e.key !== key);
    return {
      edits: songLines,
      place: (edit: SongLineEdit) => setSongLines([...others(edit.variantId, edit.key), edit]),
      discard: (variantId: string, key: string) => setSongLines(others(variantId, key)),
      reset: (variantId: string) =>
        setSongLines(songLines.filter((e) => e.variantId !== variantId)),
    };
  }, [songLines]);

  const sections = useMemo(
    () => referenceSections(state.groups, state.assets),
    [state.groups, state.assets],
  );
  // Every row in page order — the sequence J/K/N walk.
  const rows = useMemo(
    () => sections.flatMap((section) => section.subjects.flatMap((subject) => subject.rows)),
    [sections],
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

  // Why the take shown at an asset cannot be accepted: a take of the song with a lyric line nobody
  // placed on it, as this review would leave it.
  const acceptBlockedOf = useCallback(
    (asset: ReferenceAssetInfo, variantId: string | null): string | null => {
      const song = asset.variants.find((v) => v.variantId === variantId)?.song;
      const unplaced = song ? unplacedLineCount(song, songLines) : 0;
      return unplaced > 0
        ? `${unplaced} lyric line(s) are not placed — open the song and drag them onto the track`
        : null;
    },
    [songLines],
  );

  const session = useReviewSession({
    hasExtraChanges: pendingDecisions.length > 0 || keepChoices.length > 0 || songLines.length > 0,
  });
  const effectiveVariants = useEffectiveVariants(state.assets, session.selectedVariants);
  const pin = usePendingPin(session);

  // What a Keep-or-regenerate prompt reads, under the accept marks the accept being asked about leaves.
  const keepContextFor = useCallback(
    (
      overrides: Record<string, { variantId: string; status: VariantStatus }>,
      choices: readonly KeepChoice[],
    ): KeepContext =>
      keepContext(keepGraph, choices, {
        accepted: (address) => {
          const mark = overrides[address];
          return mark ? mark.status === "accepted" : undefined;
        },
        shown: (address) => {
          const asset = state.assets.find((a) => a.address === address);
          return asset ? (effectiveVariants[address] ?? asset.variantId) : undefined;
        },
      }),
    [keepGraph, state.assets, effectiveVariants],
  );

  // Accept is a toggle on the shown variant: accept it, or clear an already-accepted one.
  const handleAcceptRow = useCallback(
    (asset: ReferenceAssetInfo, selected: string) => {
      const next: VariantStatus =
        getEffectiveStatus(asset, selected) === "accepted" ? "none" : "accepted";
      if (next === "accepted" && acceptBlockedOf(asset, selected)) return;
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
    [
      getEffectiveStatus,
      acceptBlockedOf,
      dropKeepUnits,
      keepContextFor,
      statusOverrides,
      keepChoices,
      requestKeep,
    ],
  );

  const regenerateByAddress = useMemo(
    () => regenerateMarks(keepGraph, keepChoices, "reference"),
    [keepChoices, keepGraph],
  );

  // The one answer behind every review affordance here — the unreviewed count, the N jump and
  // Accept all's label. See bulk-accept.ts.
  const { unaccepted: unacceptedAddresses, done: everythingAccepted } = useMemo(
    () => referenceBulkAccept(state.assets, effectiveVariants, statusOverrides),
    [state.assets, effectiveVariants, statusOverrides],
  );

  // The "Needs review" filter reads the server's accepts alone: a mark is recorded only on Submit,
  // so a row marked here stays in view until then.
  const persistedUnaccepted = useMemo(
    () => referenceBulkAccept(state.assets, {}, {}).unaccepted,
    [state.assets],
  );

  // Nothing persists until Submit, so no confirm dialog — each mark stays individually reversible.
  // Every asset it accepts asks through one prompt.
  const acceptMany = useCallback(
    (assets: ReferenceAssetInfo[]) => {
      const next = {
        ...referenceBulkAccept(assets, effectiveVariants, statusOverrides).acceptAll(
          statusOverrides,
        ),
      };
      for (const a of assets) {
        const mark = next[a.address];
        if (mark?.status !== "accepted" || !acceptBlockedOf(a, mark.variantId)) continue;
        if (statusOverrides[a.address]) next[a.address] = statusOverrides[a.address]!;
        else delete next[a.address];
      }
      const origins = assets
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
      const entries = keepPromptFor(
        keepContextFor(next, withoutUnits(keepChoices, units)),
        origins,
      );
      requestKeep(entries, () => setStatusOverrides(next), units);
    },
    [
      acceptBlockedOf,
      statusOverrides,
      effectiveVariants,
      getEffectiveStatus,
      keepContextFor,
      keepChoices,
      requestKeep,
    ],
  );

  // With no readable variant on the page there is nothing to accept, jump to, or sign off — only
  // notes reach the server.
  const hasReviewableAssets = referenceAcceptUnits(state.assets).length > 0;

  // The assets left with neither an accept nor a live comment — named once at Submit, since the
  // record would show them unaccepted with no reason (see review/undecided.ts).
  const commented = useMemo(
    () =>
      commentedAddresses(
        state.assets.flatMap((a) => a.feedback),
        session,
      ),
    [state.assets, session],
  );
  const undecided = useMemo(() => {
    const labels = new Map<string, string>();
    for (const row of rows) {
      if (!labels.has(row.asset.address)) labels.set(row.asset.address, referenceRowLabel(row));
    }
    return referenceUndecidedAssets(
      state.assets,
      effectiveVariants,
      statusOverrides,
      commented,
      (a) => labels.get(a.address) ?? a.assetName,
    );
  }, [state.assets, rows, effectiveVariants, statusOverrides, commented]);

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

  const scrollTo = useCallback((attr: "address" | "row" | "group", value: string) => {
    containerRef.current
      ?.querySelector(`[data-${attr}="${CSS.escape(value)}"]`)
      ?.scrollIntoView({ block: attr === "group" ? "start" : "center" });
  }, []);
  const scrollToAsset = useCallback((address: string) => scrollTo("address", address), [scrollTo]);

  const handleJumpToUnreviewed = useCallback(() => {
    if (unacceptedAddresses.size === 0) return;
    for (let i = 1; i <= rows.length; i++) {
      const cand = rows[(focusIdx + i) % rows.length]!;
      if (unacceptedAddresses.has(cand.asset.address)) {
        setFocusIdx((focusIdx + i) % rows.length);
        scrollTo("row", cand.key);
        return;
      }
    }
  }, [unacceptedAddresses, rows, focusIdx, scrollTo]);

  const [railOpen, setRailOpen] = useState(() => !isNarrow());
  // Opening or closing the index resizes every row; the one being read stays where it was on screen.
  const held = useRef<{ el: Element; top: number } | null>(null);
  const toggleRail = useCallback(() => {
    for (const el of containerRef.current?.querySelectorAll("[data-row]") ?? []) {
      const { top } = el.getBoundingClientRect();
      if (top >= 0) {
        held.current = { el, top };
        break;
      }
    }
    setRailOpen((open) => !open);
  }, []);
  useLayoutEffect(() => {
    const place = held.current;
    held.current = null;
    if (!place) return;
    const moved = place.el.getBoundingClientRect().top - place.top;
    if (moved !== 0) pageScroller(place.el)?.scrollBy(0, moved);
  }, [railOpen]);

  const handleJumpToGroup = useCallback(
    (groupId: string) => {
      const idx = rows.findIndex((r) => r.group.id === groupId);
      if (idx >= 0) setFocusIdx(idx);
      if (isNarrow()) setRailOpen(false);
      scrollTo("group", groupId);
    },
    [rows, scrollTo],
  );

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
        ...(songLines.length > 0 ? { songLines } : {}),
      });
    },
    [pendingDecisions, state.assets, effectiveVariants, keepChoices, songLines],
  );
  const handleSubmit = session.openSubmit;

  const moveFocus = (idx: number) => {
    setFocusIdx(idx);
    if (rows[idx]) scrollTo("row", rows[idx].key);
  };
  useReviewShortcuts({
    blocked:
      !!session.gallery ||
      !!detail ||
      infoVariant !== null ||
      session.submitOpen ||
      keepAsking !== null,
    onSubmit: handleSubmit,
    handlers: {
      j: () => moveFocus(Math.min(focusIdx + 1, rows.length - 1)),
      k: () => moveFocus(Math.max(focusIdx - 1, 0)),
      a: () => {
        const asset = rows[focusIdx]?.asset;
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
  const focusedRow = rows[focusIdx] ?? null;
  const visibleSections = sections.flatMap((section) => {
    const subjects = section.subjects.flatMap((subject) => {
      const shown = subject.rows.filter(
        (r) => !session.showChangedOnly || persistedUnaccepted.has(r.asset.address),
      );
      return shown.length > 0 ? [{ ...subject, shown }] : [];
    });
    return subjects.length > 0 ? [{ title: section.title, subjects }] : [];
  });

  // The subject under the reader's eye, which the index marks: the last one whose head has passed
  // a line a third of the way down the window, and the last of all at the page's end.
  const [readingGroupId, setReadingGroupId] = useState<string | null>(null);
  const visibleGroupIds = visibleSections
    .flatMap((section) => section.subjects.map((subject) => subject.group.id))
    .join("\n");
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const heads = [
        ...(containerRef.current?.querySelectorAll<HTMLElement>("[data-group]") ?? []),
      ];
      if (heads.length === 0) return setReadingGroupId(null);
      const page = pageScroller(containerRef.current);
      const atEnd = !!page && page.scrollTop + page.clientHeight >= page.scrollHeight - 2;
      const line = window.innerHeight / 3;
      const passed = heads.filter((el) => el.getBoundingClientRect().top <= line);
      const reading = atEnd ? heads.at(-1)! : (passed.at(-1) ?? heads[0]!);
      setReadingGroupId(reading.dataset.group ?? null);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    // Captured, so a scroll of <main> at phone width is read as the window's is.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [visibleGroupIds]);

  const resetAction: ResetAction = {
    disabled: !session.hasPendingChanges,
    onClick: () => {
      setStatusOverrides({});
      setSongLines([]);
      resetKeep();
      pin.cancelPin();
      setHighlightedFeedbackId(null);
      session.reset();
    },
  };

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
                  onClick: () => acceptMany(state.assets),
                }
              : undefined
          }
          reset={resetAction}
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
      <SongLineEditsContext.Provider value={songLineEdits}>
        <div
          className={`reference-preview${railOpen ? " reference-preview--rail" : ""}`}
          ref={containerRef}
        >
          <button
            type="button"
            className="dir-icon-btn dir-rail-toggle"
            onClick={toggleRail}
            aria-expanded={railOpen}
            aria-label={railOpen ? "Close the index" : "Open the index"}
            title={railOpen ? "Close the index" : "Open the index"}
          >
            <MenuIcon size={16} />
          </button>
          <button
            type="button"
            className="dir-scrim"
            aria-label="Close the index"
            tabIndex={-1}
            onClick={toggleRail}
          />
          <ReferenceRail
            open={railOpen}
            tools={
              <>
                <label className="review-toggle">
                  <input
                    type="checkbox"
                    checked={session.showChangedOnly}
                    onChange={() => session.setShowChangedOnly(!session.showChangedOnly)}
                  />
                  Needs review
                </label>
                <label className="review-toggle">
                  <input
                    type="checkbox"
                    checked={session.hideStale}
                    onChange={() => session.setHideStale(!session.hideStale)}
                  />
                  Hide stale notes
                </label>
                <ResetButton reset={resetAction} />
              </>
            }
            sections={visibleSections}
            currentGroupId={readingGroupId}
            unaccepted={unacceptedAddresses}
            commented={commented}
            onJump={handleJumpToGroup}
          />
          <div className="ref-subjects">
            {visibleSections.map((section) => (
              <section key={section.title} className="reference-group">
                <h2 className="reference-group-title">{section.title}</h2>
                {section.subjects.map(({ group, rows: all, shown }) => {
                  const decidable = all.filter((r) => r.asset.variantId !== null);
                  const left = decidable.filter((r) => unacceptedAddresses.has(r.asset.address));
                  return (
                    <article key={group.id} className="ref-subject" data-group={group.id}>
                      <header className="ref-subject-head">
                        <span className="ref-subject-kind">{GROUP_KIND_LABEL[group.kind]}</span>
                        <h3 className="ref-subject-name">{group.name}</h3>
                        {decidable.length > 1 && (
                          <span className="ref-subject-progress">
                            {decidable.length - left.length}/{decidable.length} accepted
                          </span>
                        )}
                        {decidable.length > 1 && left.length > 0 && (
                          <button
                            type="button"
                            className="ctrl-btn"
                            title={`Accept every asset of ${group.name}`}
                            onClick={() => acceptMany(decidable.map((r) => r.asset))}
                          >
                            <CheckIcon size={13} /> Accept all
                          </button>
                        )}
                      </header>
                      {shown.map((row) => {
                        const { asset } = row;
                        const selectedVariantId =
                          effectiveVariants[asset.address] ?? asset.variantId;
                        const effectiveStatus = getEffectiveStatus(asset, selectedVariantId);
                        return (
                          <ReferenceRow
                            key={row.key}
                            row={row}
                            selectedVariantId={selectedVariantId}
                            effectiveStatus={effectiveStatus}
                            focused={focusedRow?.key === row.key}
                            hasOverride={asset.address in statusOverrides}
                            regenerate={regenerateByAddress.get(asset.address)}
                            onKeepAfterAll={() => keepUnitAfterAll(asset.address)}
                            onJumpToUnit={scrollToAsset}
                            thread={pin.threadFor(asset.address)}
                            pendingPin={pin.pinFor(asset.address)}
                            highlightedFeedbackId={highlightedFeedbackId}
                            onFocus={() => setFocusIdx(rows.indexOf(row))}
                            onHighlightPin={setHighlightedFeedbackId}
                            onOpenGallery={() => session.setGallery({ address: asset.address })}
                            onOpenInfo={
                              selectedVariantId && variantInfo(asset.variants, selectedVariantId)
                                ? () =>
                                    setInfoVariant({
                                      address: asset.address,
                                      variantId: selectedVariantId,
                                    })
                                : undefined
                            }
                            onOpenDetail={() => setDetail({ address: asset.address })}
                            acceptBlocked={acceptBlockedOf(asset, selectedVariantId)}
                            onAccept={(variantId) => handleAcceptRow(asset, variantId)}
                            onPinPlace={(x, y) => pin.placePin(asset.address, x, y)}
                            onCancelPin={pin.cancelPin}
                          />
                        );
                      })}
                    </article>
                  );
                })}
              </section>
            ))}
          </div>

          {galleryAsset && (
            <VariantGallery
              label={galleryAsset.assetName}
              kind={galleryAsset.mediaKind}
              variants={galleryAsset.variants}
              selectedVariantId={effectiveVariants[galleryAsset.address] ?? galleryAsset.variantId}
              onUse={(variantId) => handleUseVariant(galleryAsset.address, variantId)}
              onOpenInfo={(variantId) =>
                setInfoVariant({ address: galleryAsset.address, variantId })
              }
              infoOpen={infoVariant !== null}
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
                  thread={pin.threadFor(detailAsset.address)}
                  pendingPin={pin.pinFor(detailAsset.address)}
                  highlightedFeedbackId={highlightedFeedbackId}
                  onHighlightPin={setHighlightedFeedbackId}
                  onClose={() => setDetail(null)}
                  onOpenGallery={() => session.setGallery({ address: detailAsset.address })}
                  acceptBlocked={acceptBlockedOf(detailAsset, selectedVariantId)}
                  onAccept={(variantId) => handleAcceptRow(detailAsset, variantId)}
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

          {infoVariant &&
            (() => {
              const asset = state.assets.find((a) => a.address === infoVariant.address);
              const info = asset && variantInfo(asset.variants, infoVariant.variantId);
              if (!asset || !info) return null;
              return (
                <AssetInfoPanel
                  assetName={asset.assetName}
                  address={asset.address}
                  variantId={infoVariant.variantId}
                  info={info}
                  onClose={() => setInfoVariant(null)}
                />
              );
            })()}
        </div>
      </SongLineEditsContext.Provider>
    </ReviewShell>
  );
}

// Image surface with a pin overlay: a click drops a pin at normalized 0–1 coords, inline and in
// the detail modal alike.
function ReferenceImageMedia({
  asset,
  imageUrl,
  size,
  pins,
  thread,
  pendingPin,
  pinIndexById,
  highlightedId,
  large,
  overlay,
  onPlacePin,
  onPinClick,
}: {
  asset: ReferenceAssetInfo;
  imageUrl: string | null;
  size?: { width: number; height: number };
  pins: FeedbackInfo[];
  thread: CommentThreadBinding;
  pendingPin: { x: number; y: number } | null;
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
          className={`reference-card-img${size ? " reference-card-img--sized" : ""}`}
          style={
            size
              ? ({
                  "--img-ratio": size.width / size.height,
                  "--img-width": `${size.width}px`,
                } as React.CSSProperties)
              : undefined
          }
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
        pendingPins={thread.pendingFeedback}
        pendingPin={pendingPin}
        filter={thread}
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
  onOpenDetail,
}: {
  asset: ReferenceAssetInfo;
  variant: {
    imageUrl: string | null;
    fileUrl?: string | null;
    song?: SongReadingInfo;
    auditionGain?: number;
  };
  overlay?: React.ReactNode;
  onOpenDetail: () => void;
}): React.ReactElement {
  // A take of the song plays only in its track, under the grid and lines it was read as — what
  // accepting it signs off.
  if (asset.mediaKind === "audio" && variant.fileUrl && variant.song) {
    return (
      <div className="reference-card-media reference-card-media--audio">
        <SongSummary song={variant.song} onOpen={onOpenDetail} />
        {overlay}
      </div>
    );
  }
  if (asset.mediaKind === "audio") {
    return (
      <div className="reference-card-media reference-card-media--audio">
        <span className="reference-card-audio-glyph">
          <VolumeIcon size={32} />
        </span>
        {variant.fileUrl && (
          <AuditionAudio
            className="reference-card-audio"
            src={variant.fileUrl}
            gain={variant.auditionGain}
            controls
            preload="none"
          />
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

function ReferenceRail({
  open,
  tools,
  sections,
  currentGroupId,
  unaccepted,
  commented,
  onJump,
}: {
  open: boolean;
  // The header's controls a phone's one-row bar has no room for.
  tools: React.ReactNode;
  sections: ReferenceSection[];
  currentGroupId: string | null;
  unaccepted: Set<string>;
  commented: Set<string>;
  onJump: (groupId: string) => void;
}): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  // An index longer than the window follows the page. Its own scroll alone: scrolling the row into
  // view would stop a jump the page is in the middle of.
  useEffect(() => {
    const scroller = scrollRef.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!scroller || !row) return;
    const box = scroller.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < box.top) scroller.scrollTop -= box.top - at.top;
    else if (at.bottom > box.bottom) scroller.scrollTop += at.bottom - box.bottom;
  }, [currentGroupId]);
  return (
    <nav
      className={`dir-rail${open ? " dir-rail--open" : ""}`}
      aria-label="Reference index"
      aria-hidden={!open}
      inert={!open}
    >
      <div ref={scrollRef} className="dir-rail-scroll dir-scroll">
        {sections.map((section) => (
          <section key={section.title} className="dir-rail-group">
            <h2 className="dir-rail-title">{section.title}</h2>
            {section.subjects.map(({ group, rows }) => {
              const left = rows.filter((r) => unaccepted.has(r.asset.address)).length;
              const current = group.id === currentGroupId;
              return (
                <button
                  key={group.id}
                  type="button"
                  className={`dir-rail-row${current ? " dir-rail-row--current" : ""}`}
                  aria-current={current}
                  onClick={() => onJump(group.id)}
                >
                  <span className="dir-rail-name">{group.name}</span>
                  {rows.some((r) => commented.has(r.asset.address)) && (
                    <span className="dir-rail-noted" title="Has notes">
                      <CommentIcon size={11} />
                    </span>
                  )}
                  {left > 0 ? (
                    <span className="ref-rail-left" title={`${left} to review`}>
                      {left}
                    </span>
                  ) : (
                    rows.some((r) => r.asset.variantId !== null) && (
                      <span className="ref-rail-done" title="Accepted">
                        <CheckIcon size={12} />
                      </span>
                    )
                  )}
                </button>
              );
            })}
          </section>
        ))}
        <section className="dir-rail-group dir-rail-tools">
          <h2 className="dir-rail-title">Review</h2>
          <div className="dir-rail-tools-body">{tools}</div>
        </section>
      </div>
    </nav>
  );
}

function VoiceLinesCard({
  lines,
}: {
  lines: NonNullable<ReferenceGroupMemberInfo["lines"]>;
}): React.ReactElement {
  const shown = lines.slice(0, 4);
  return (
    <div className="comment-card comment-card--move">
      <span className="comment-card-icon">
        <FilmIcon size={12} />
      </span>
      <span className="comment-card-body">
        {shown.map((line, i) => (
          <span key={i} className="comment-move-row">
            <span className="comment-move-label">{i === 0 ? "Lines" : ""}</span>
            <span className="comment-move-text">
              {line.text}
              {line.acting && <span className="ref-line-acting"> ({line.acting})</span>}
            </span>
          </span>
        ))}
        {lines.length > shown.length && (
          <span className="comment-move-row">
            <span className="comment-move-label" />
            <span className="comment-move-text ref-line-acting">
              and {lines.length - shown.length} more
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

function ReferenceRow({
  row,
  selectedVariantId,
  effectiveStatus,
  focused,
  hasOverride,
  regenerate,
  onKeepAfterAll,
  onJumpToUnit,
  thread,
  highlightedFeedbackId,
  onFocus,
  onHighlightPin,
  onOpenGallery,
  onOpenInfo,
  onOpenDetail,
  acceptBlocked,
  onAccept,
  pendingPin,
  onPinPlace,
  onCancelPin,
}: {
  row: ReferenceRowInfo;
  selectedVariantId: string | null;
  effectiveStatus: VariantStatus;
  focused: boolean;
  hasOverride: boolean;
  // The Regenerate answer standing for this asset; a follow's names the asset answered for it.
  regenerate?: RegenerateMark;
  onKeepAfterAll: () => void;
  onJumpToUnit: (address: string) => void;
  thread: CommentThreadBinding;
  pendingPin: { x: number; y: number } | null;
  highlightedFeedbackId: string | null;
  onFocus: () => void;
  onHighlightPin: (id: string) => void;
  onOpenGallery: () => void;
  onOpenInfo?: () => void;
  onOpenDetail: () => void;
  // Why the shown take cannot be accepted, or null.
  acceptBlocked: string | null;
  onAccept: (variantId: string) => void;
  onPinPlace: (x: number, y: number) => void;
  onCancelPin: () => void;
}): React.ReactElement {
  const { asset, member } = row;
  const label = referenceMemberLabel(member);
  // The shown media follows the gallery selection (override), else the resolved variant.
  const shown =
    asset.variants.find((v) => v.variantId === selectedVariantId) ??
    asset.variants.find((v) => v.variantId === asset.variantId) ??
    ({ imageUrl: asset.imageUrl, fileUrl: asset.fileUrl ?? null } as {
      imageUrl: string | null;
      fileUrl?: string | null;
      song?: SongReadingInfo;
      auditionGain?: number;
      size?: { width: number; height: number };
    });

  const isImage = asset.mediaKind === "image";

  // An undecided reroll stands beside the accepted variant (auto-shown by default) — badged
  // Changed so the reviewer knows the pending state awaits a re-accept.
  const undecidedBesideAccepted = asset.variants.some((v) => v.undecidedBesideAccepted);

  const pinIndexById = buildPinIndex(asset.feedback, thread.pendingFeedback, thread);

  const overlay = (
    <FrameOverlay
      assetName={asset.assetName}
      variants={asset.variants}
      onOpenGallery={onOpenGallery}
      onOpenInfo={onOpenInfo}
      onEnlarge={shown.imageUrl || shown.fileUrl ? onOpenDetail : undefined}
    />
  );

  return (
    <div
      role="presentation"
      className={`review-row ref-row ref-row--${asset.mediaKind}${
        member.role === "view" ? " ref-row--nested" : ""
      }${focused ? " review-row--focused" : ""}`}
      data-address={asset.address}
      data-row={row.key}
      onClick={onFocus}
    >
      {label && (
        <div className="ref-row-label">
          <span className="ref-row-role">{label}</span>
          {member.holds && member.holds.length > 0 && (
            <span className="ref-row-holds">{member.holds.join(", ")}</span>
          )}
        </div>
      )}
      <div className="ref-row-media">
        {isImage ? (
          <ReferenceImageMedia
            asset={asset}
            imageUrl={shown.imageUrl}
            size={shown.size}
            pins={asset.feedback}
            thread={thread}
            pendingPin={pendingPin}
            pinIndexById={pinIndexById}
            highlightedId={highlightedFeedbackId}
            overlay={overlay}
            onPlacePin={onPinPlace}
            onPinClick={onHighlightPin}
          />
        ) : (
          <ReferenceMedia
            asset={asset}
            variant={shown}
            overlay={overlay}
            onOpenDetail={onOpenDetail}
          />
        )}
      </div>

      <div className="ref-row-notes review-col-feedback">
        <CommentThread
          address={asset.address}
          feedback={asset.feedback}
          thread={thread}
          pendingPin={pendingPin}
          {...(asset.directionRoster ? { roster: asset.directionRoster } : {})}
          context={
            member.lines && member.lines.length > 0 ? (
              <VoiceLinesCard lines={member.lines} />
            ) : undefined
          }
          handoffNotes={asset.handoffNote ? [asset.handoffNote] : undefined}
          emptyHint={
            isImage
              ? "No notes on this asset yet. Add one below, or click the frame to pin one."
              : "No notes on this asset yet. Add one below."
          }
          pinIndexById={pinIndexById}
          highlightedId={highlightedFeedbackId}
          onHighlightPin={onHighlightPin}
          onCancelPin={onCancelPin}
        />
      </div>

      {/* The decision gets its own column rather than an overlay on the media, so the accept
          control reads the same here as in the animatic review's panel list. */}
      <div className="ref-row-accept review-col-accept">
        {undecidedBesideAccepted && <StatusBadge status="changed" label="Changed" />}
        {regenerate && (
          <RegenerateBadge mark={regenerate} onKeep={onKeepAfterAll} onJumpToRow={onJumpToUnit} />
        )}
        {selectedVariantId && (
          <AcceptButton
            accepted={effectiveStatus === "accepted"}
            overridden={hasOverride}
            disabled={effectiveStatus !== "accepted" && acceptBlocked !== null}
            title={
              effectiveStatus === "accepted"
                ? "Click to unaccept"
                : (acceptBlocked ?? "Accept this take")
            }
            onClick={() => onAccept(selectedVariantId)}
          />
        )}
      </div>
    </div>
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
  thread,
  pendingPin,
  highlightedFeedbackId,
  onHighlightPin,
  onClose,
  onOpenGallery,
  acceptBlocked,
  onAccept,
  onPinPlace,
  onCancelPin,
}: {
  asset: ReferenceAssetInfo;
  selectedVariantId: string | null;
  effectiveStatus: VariantStatus;
  needsReviewNow: boolean;
  thread: CommentThreadBinding;
  pendingPin: { x: number; y: number } | null;
  highlightedFeedbackId: string | null;
  onHighlightPin: (id: string) => void;
  onClose: () => void;
  onOpenGallery: () => void;
  acceptBlocked: string | null;
  onAccept: (variantId: string) => void;
  onPinPlace: (x: number, y: number) => void;
  onCancelPin: () => void;
}): React.ReactElement {
  const shown =
    asset.variants.find((v) => v.variantId === selectedVariantId) ??
    asset.variants.find((v) => v.variantId === asset.variantId) ??
    ({ imageUrl: asset.imageUrl, fileUrl: asset.fileUrl ?? null } as {
      imageUrl: string | null;
      fileUrl?: string | null;
      song?: SongReadingInfo;
      auditionGain?: number;
      size?: { width: number; height: number };
    });

  const pinIndexById = buildPinIndex(asset.feedback, thread.pendingFeedback, thread);

  return (
    <Modal
      className={`reference-detail${asset.mediaKind === "audio" && shown.song ? " reference-detail--song" : ""}`}
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
              disabled={effectiveStatus !== "accepted" && acceptBlocked !== null}
              title={effectiveStatus !== "accepted" ? (acceptBlocked ?? undefined) : undefined}
              onClick={() => onAccept(selectedVariantId)}
            >
              <CheckIcon size={13} /> {effectiveStatus === "accepted" ? "Accepted" : "Accept"}
            </button>
          )}
          {asset.variants.length > 1 && (
            <button type="button" className="ctrl-btn" onClick={onOpenGallery}>
              <GridIcon size={14} /> Takes
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
              size={shown.size}
              pins={asset.feedback}
              thread={thread}
              pendingPin={pendingPin}
              pinIndexById={pinIndexById}
              highlightedId={highlightedFeedbackId}
              large
              onPlacePin={onPinPlace}
              onPinClick={onHighlightPin}
            />
          ) : !shown.fileUrl ? (
            <span className="reference-card-empty">No media</span>
          ) : asset.mediaKind === "audio" && shown.song ? (
            <SongTrack fileUrl={shown.fileUrl} song={shown.song} />
          ) : asset.mediaKind === "audio" ? (
            <div className="reference-detail-audio">
              <span className="reference-card-audio-glyph">
                <VolumeIcon size={48} />
              </span>
              <AuditionAudio
                className="reference-detail-audio-player"
                src={shown.fileUrl}
                gain={shown.auditionGain}
                controls
                autoPlay
              />
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
          <CommentThread
            address={asset.address}
            feedback={asset.feedback}
            thread={thread}
            pendingPin={pendingPin}
            {...(asset.directionRoster
              ? {
                  roster: asset.directionRoster.map(({ kind, name, description }) => ({
                    kind,
                    name,
                    description,
                  })),
                }
              : {})}
            handoffNotes={asset.handoffNote ? [asset.handoffNote] : undefined}
            pinIndexById={pinIndexById}
            highlightedId={highlightedFeedbackId}
            onHighlightPin={onHighlightPin}
            onCancelPin={onCancelPin}
          />
        </aside>
      </div>
    </Modal>
  );
}
