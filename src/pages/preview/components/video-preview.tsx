import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatShotAddress } from "../../../core/address.js";
import { submitReview } from "../api.js";
import { formatPlayerTime } from "../format-time.js";
import { type Playhead, usePlayheadTime } from "../review/playhead.js";
import { ReviewShell, type ShortcutRows } from "../review/review-shell.js";
import { shotGalleryTabs, soundtrackGalleryTabs } from "../review/gallery-tabs.js";
import { isNewVariant } from "../review/new-variant.js";
import { shotAcceptable } from "../../../core/shot-acceptable.js";
import { liveFeedback } from "../review/live-feedback.js";
import { commentedAddresses } from "../review/undecided.js";
import { useEffectiveVariants } from "../review/use-effective-variants.js";
import { useFillLayout } from "../review/use-fill-layout.js";
import { useHighlightedFeedback } from "../review/use-highlighted-feedback.js";
import { type SubmitInput, useReviewSession } from "../review/use-review-session.js";
import { useReviewShortcuts } from "../review/use-review-shortcuts.js";
import { keepPrompt, regenerateSummary } from "../review/keep-or-regenerate.js";
import { useKeepChoices } from "../review/use-keep-choices.js";
import { buildReelSubmitPayload } from "../review/reel-submit-payload.js";
import { useReelComposition } from "../review/use-reel-composition.js";
import {
  hasReelMarks,
  NO_REEL_MARKS,
  useReelDecisions,
  type ReelMarks,
} from "../review/use-reel-decisions.js";
import { findShotIdxAtTime, useReelPlayback } from "../review/use-reel-playback.js";
import { useShotFrames } from "../review/use-shot-frames.js";
import type {
  FeedbackInfo,
  MediaKind,
  VariantInfo,
  VideoPreviewState,
  ShotInfo,
} from "../types.js";
import { HyperFramesPlayerWrapper } from "./hyperframes-player-wrapper.js";
import { AcceptButton } from "./accept-button.js";
import {
  CollapseIcon,
  CommentIcon,
  ExpandIcon,
  LoopIcon,
  PauseIcon,
  PlayIcon,
  SkipToStartIcon,
  StepBackIcon,
  StepForwardIcon,
} from "./icons.js";
import { TargetPanel, type DisplayComment, type NoteDraft } from "./target-panel.js";
import { NextUnreviewedButton, ReviewHeaderActions } from "./review-header-actions.js";
import { ReviewTimeline, type ReviewTimelineRef } from "./review-timeline.js";
import { StatusBadge } from "./status-badge.js";
import { TimedNoteOverlay, type TimedNote } from "./timed-note-overlay.js";
import { ShotList } from "./shot-list.js";
import { TheaterScrubber } from "./theater-scrubber.js";
import { AssetInfoPanel, type InfoVariant, variantInfo } from "./asset-info-panel.js";
import { type GalleryTab, VariantGallery } from "./variant-gallery.js";
import { KeepOrRegenerateModal } from "./keep-or-regenerate-modal.js";

// Keyboard shortcuts, surfaced on demand from the header's "?" button.
const SHORTCUTS: ShortcutRows = [
  [["Space"], "Play / pause"],
  [["←", "→"], "Seek back / forward (hold to scrub smoothly)"],
  [["J", "K"], "Previous / next shot"],
  [[",", "."], "Step one frame"],
  [["A"], "Accept the focused shot (or the soundtrack)"],
  [["C"], "Add a note at the playhead"],
  [["N"], "Jump to next unreviewed shot"],
  [["S"], "Toggle hide-stale notes"],
  [["F"], "Fullscreen the player (Esc to leave)"],
  [["+", "-"], "Zoom the timeline in / out"],
  [["="], "Reset the timeline zoom"],
  [["?"], "Toggle this shortcuts panel"],
  [["⌘/Ctrl", "⏎"], "Submit review"],
];

// Everything the variant gallery needs to render one asset, indexed by address — motion/
// background (per shot) and audio (per timeline asset) alike, so a clip on any track opens
// its gallery through a single lookup.
interface GalleryAsset {
  address: string;
  assetName: string;
  mediaKind: MediaKind;
  variantId: string | null;
  variants: VariantInfo[];
}

// The player's clock readout — the one control that must redraw every frame, so it subscribes
// to the playhead on its own instead of pulling the review's controls along with it.
function PlayerTime({
  playhead,
  totalDuration,
}: {
  playhead: Playhead;
  totalDuration: number;
}): React.ReactElement {
  const currentTime = usePlayheadTime(playhead);
  return (
    <span className="player-time">
      {formatPlayerTime(currentTime)}{" "}
      <span className="player-time-total">/ {formatPlayerTime(totalDuration)}</span>
    </span>
  );
}

export function VideoPreview({ state }: { state: VideoPreviewState }): React.ReactElement {
  // What the feedback panel is pointed at. "shot" follows the playhead; "soundtrack" and an overlay
  // are sticky picks (each spans shots, so seeking to hear or watch one must not snap the panel back
  // to whatever shot the playhead landed in). Only an explicit shot gesture — picking a card, J/K/N,
  // placing a pin — points it back at the shot.
  const [noteTarget, setNoteTarget] = useState<"shot" | "soundtrack" | "overlay">("shot");

  // The take whose declaration panel is open, stacked over the gallery when opened from there.
  const [infoVariant, setInfoVariant] = useState<InfoVariant | null>(null);

  // The comment being written: the instant it is about, and the pin on that frame if one was
  // placed. Non-null means the composer is open.
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [highlightedFeedbackId, setHighlightedFeedbackId] = useHighlightedFeedback();
  const [focusRequest, setFocusRequest] = useState<{
    start: number;
    duration: number;
    seq: number;
  }>();

  const [showNotes, setShowNotes] = useState(true);

  // Theater: the review fills the window below the header, the frame taking every pixel the
  // controls, the timeline and the two side columns leave — the columns stay, so a note is still
  // written where it always was. The browser's fullscreen is asked for on top of it; where it is
  // refused (no user activation, an embedding that forbids it) the in-window mode still stands,
  // so the toggle never silently does nothing.
  const [theater, setTheater] = useState(false);
  // Theater hides the header, so the review's toggles and actions are portaled into this slot at
  // the top of the shots column instead (see ReviewShell's actionsTarget).
  const [theaterActionsEl, setTheaterActionsEl] = useState<HTMLElement | null>(null);

  // A phone fills the screen with the review whether or not theater was asked for — the three
  // columns have nowhere to stand at that width. Both paths hand the viewport its height, so
  // everything below reads `immersive` rather than the toggle; `theater` stays the toggle alone.
  const { fill, bandSide } = useFillLayout(state.size.width / state.size.height);
  const immersive = theater || fill;

  const [marks, setMarks] = useState<ReelMarks>(NO_REEL_MARKS);
  const keep = useKeepChoices();
  const { choices: keepChoices, asking: keepAsking, answer: answerKeep } = keep;
  const session = useReviewSession({
    hasExtraChanges: hasReelMarks(marks) || keepChoices.length > 0,
  });

  const timelineRef = useRef<ReviewTimelineRef>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportBox, setViewportBox] = useState({ width: 0, height: 0 });

  // Which reel this page is playing. One page serves both composition stages, so every address it
  // mints and the endpoint it submits to are the mode's.
  const reelStage = state.mode === "animatic-preview" ? "animatic" : "video";

  const shotFeedbackAddress = useCallback(
    (shotId: string) => formatShotAddress(reelStage, shotId),
    [reelStage],
  );

  const {
    playhead,
    playerRef,
    focusedShotIdx,
    isPlaying,
    setIsPlaying,
    loopMode,
    setLoopMode,
    playbackRate,
    setPlaybackRate,
    handleTimeUpdate,
    handlePlayerReady,
    pausePlayback,
    handleSeek,
    handleStepFrame,
    handleArrowSeek,
    handlePlayPause,
  } = useReelPlayback({
    shots: state.shots,
    totalDuration: state.totalDuration,
    fps: state.fps,
    noteDraft,
    setNoteDraft,
  });

  const focusedShot = state.shots[focusedShotIdx];

  // A reload that drops the soundtracks takes the panel's target with it, so the pick is read
  // through the stem's presence rather than trusted on its own.
  const soundtrackFocused = noteTarget === "soundtrack" && !!state.timelineStem;
  // The overlay, when it is offered on its own: every shot accept stands and it changed after them.
  const offeredOverlay = state.overlay?.offered ? state.overlay : undefined;
  const focusedOverlay = noteTarget === "overlay" ? offeredOverlay : undefined;
  // The target the panel shows when it is not a shot.
  const spanTarget = useMemo(
    () =>
      soundtrackFocused && state.timelineStem
        ? { address: state.timelineStem.address, label: "Soundtrack" }
        : focusedOverlay
          ? { address: focusedOverlay.address, label: "Overlay" }
          : null,
    [soundtrackFocused, state.timelineStem, focusedOverlay],
  );

  // Every asset with takes to show — the shots' and the audio beds' — for the player and the
  // submit snapshots.
  const allAssets = useMemo(
    () => [...state.shots.flatMap((s) => s.assets), ...state.audioAssets],
    [state.shots, state.audioAssets],
  );
  const effectiveVariants = useEffectiveVariants(allAssets, session.selectedVariants);

  const assetByAddress = useMemo(() => {
    const map = new Map<string, GalleryAsset>();
    for (const s of state.shots) {
      for (const a of s.assets) {
        map.set(a.address, {
          address: a.address,
          assetName: a.assetName,
          mediaKind: a.mediaKind,
          variantId: a.variantId,
          variants: a.variants,
        });
      }
    }
    for (const a of state.audioAssets) {
      map.set(a.address, {
        address: a.address,
        assetName: a.assetName,
        mediaKind: "audio",
        variantId: a.variantId,
        variants: a.variants,
      });
    }
    return map;
  }, [state.shots, state.audioAssets]);

  // Each review target's gallery tabs. The focused target's own come first, so an asset placed in
  // more than one shot opens among the shot the panel is pointed at.
  const galleryTargets = useMemo(() => {
    const shots = state.shots.map((s) => ({
      subject: `Shot ${s.shotId}`,
      tabs: shotGalleryTabs(s, state.audioAssets),
    }));
    const soundtrack = { subject: "Soundtrack", tabs: soundtrackGalleryTabs(state.audioAssets) };
    const focused = soundtrackFocused
      ? soundtrack
      : focusedOverlay
        ? null
        : focusedShot && shots[focusedShotIdx];
    return {
      focused: focused ?? null,
      all: [...(focused ? [focused] : []), ...shots, soundtrack],
    };
  }, [
    state.shots,
    state.audioAssets,
    soundtrackFocused,
    focusedOverlay,
    focusedShot,
    focusedShotIdx,
  ]);
  const galleryTabOf = useCallback(
    (address: string): GalleryTab | null => {
      const a = assetByAddress.get(address);
      return a
        ? {
            address,
            assetName: a.assetName,
            variants: a.variants,
          }
        : null;
    },
    [assetByAddress],
  );
  const focusedGalleryTabs = galleryTargets.focused?.tabs ?? [];

  // The timeline's info button opens the take the reel is playing at that address.
  const infoOpener = useCallback(
    (address: string): (() => void) | undefined => {
      const asset = assetByAddress.get(address);
      const variantId = effectiveVariants[address] ?? asset?.variantId ?? null;
      if (!asset || !variantId || !variantInfo(asset.variants, variantId)) return undefined;
      return () => setInfoVariant({ address, variantId });
    },
    [assetByAddress, effectiveVariants],
  );

  // Auditioning a take is a comparison, so the reel keeps the instant it was switched at rather
  // than dropping back to its head: the player pauses before each load and resumes at the playhead
  // once the new composition is ready (see the wrapper's getStartTime). A reel that came back
  // shorter reports the frame it actually landed on, which puts the playhead and the focused shot
  // right.
  const compositionHtml = useReelComposition({
    shots: state.shots,
    compositionRefVariants: state.compositionRefVariants,
    effectiveVariants,
    onLoad: pausePlayback,
    onError: session.setError,
  });

  const shotFrames = useShotFrames(state.shots, compositionHtml, effectiveVariants);

  // Height as well as width: in theater the viewport's height is handed to it by the column
  // rather than derived from its width, so it has to be measured to scale the frame into it.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewportBox({ width: el.clientWidth, height: el.clientHeight });
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries)
        setViewportBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    document.body.classList.toggle("theater-mode", immersive);
    document.body.classList.toggle("fill-mode", fill);
    return () => {
      document.body.classList.remove("theater-mode");
      document.body.classList.remove("fill-mode");
    };
  }, [immersive, fill]);

  // Escape leaves the browser's fullscreen without the click that would tell us; drop the
  // in-window mode with it, so the two never disagree.
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setTheater(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      // The review is going away (submitted, reloaded into another stage) — give the screen back
      // rather than leave the closing message holding it.
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const theaterRef = useRef(theater);
  theaterRef.current = theater;

  const exitTheater = useCallback(() => {
    setTheater(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  const toggleTheater = useCallback(() => {
    if (theaterRef.current) {
      exitTheater();
      return;
    }
    setTheater(true);
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }, [exitTheater]);

  const {
    keepGraph,
    baseShotAccepted,
    baseTimelineStemAccepted,
    baseOverlayAccepted,
    shotAccepted,
    timelineStemAccepted,
    overlayAccepted,
    timelineStemChanged,
    acceptableShots,
    audioAccepted,
    everythingAccepted,
    unreviewedShotIds,
    regenerateUnits,
    regenerateByShot,
    toggleShotDecision,
    toggleTimelineStem,
    toggleOverlay,
    acceptAll,
    keepShotAfterAll,
    reset: resetDecisions,
  } = useReelDecisions({ state, reelStage, marks, setMarks, keep, effectiveVariants });

  // Picking a shot from the shot list seeks the player AND frames the shot on the timeline
  // (see ReviewTimeline's focusShotRequest). The playhead alone would leave a zoomed-out
  // timeline showing the whole video, which is not what "go to this shot" means.
  const frameSpan = useCallback((start: number, duration: number) => {
    setFocusRequest((prev) => ({ start, duration, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const handleJumpToShot = useCallback(
    (shot: ShotInfo) => {
      setNoteTarget("shot");
      handleSeek(shot.startTime);
      frameSpan(shot.startTime, shot.duration);
    },
    [handleSeek, frameSpan],
  );

  // Picking the soundtrack frames the beds: their combined span, so every bed the accept covers
  // is on screen at once (a bed may be `from`/`until`-bounded rather than run the whole video).
  const focusSoundtrack = useCallback(() => {
    const cues = state.audioAssets.filter((a) => a.kind === "soundtrack").flatMap((a) => a.cues);
    if (cues.length > 0) {
      const start = Math.min(...cues.map((c) => c.start));
      const end = Math.max(...cues.map((c) => c.end));
      if (end > start) frameSpan(start, end - start);
    }
    setNoteTarget("soundtrack");
    setNoteDraft((draft) => (draft?.pin ? { ...draft, pin: null } : draft));
  }, [state.audioAssets, frameSpan]);

  // Clicking the Soundtrack card again drops the pick, so the feedback panel goes back to the
  // shot at the playhead. The zoom stays as it is — un-picking must not yank the view around.
  const toggleSoundtrackFocus = useCallback(() => {
    if (soundtrackFocused) setNoteTarget("shot");
    else focusSoundtrack();
  }, [soundtrackFocused, focusSoundtrack]);

  // Picking the overlay frames the whole timeline; picking it again drops the pick.
  const toggleOverlayFocus = useCallback(() => {
    if (focusedOverlay) {
      setNoteTarget("shot");
      return;
    }
    if (state.overlay) frameSpan(0, state.overlay.duration);
    setNoteTarget("overlay");
    setNoteDraft((draft) => (draft?.pin ? { ...draft, pin: null } : draft));
  }, [focusedOverlay, state.overlay, frameSpan]);

  const handleJumpToUnreviewed = useCallback(() => {
    if (unreviewedShotIds.length === 0) return;
    const order = state.shots.map((s) => s.shotId);
    const start = focusedShot ? order.indexOf(focusedShot.shotId) : -1;
    for (let i = 1; i <= order.length; i++) {
      const shot = state.shots[(start + i) % order.length]!;
      if (unreviewedShotIds.includes(shot.shotId)) {
        handleJumpToShot(shot);
        return;
      }
    }
  }, [unreviewedShotIds, state.shots, focusedShot, handleJumpToShot]);

  // A note is about the frame in front of the reviewer, so opening the composer stops the reel:
  // playback running on under a half-typed note would carry it into the next shot. Re-opening an
  // already-open one keeps its instant, so a second C never moves a note being typed.
  const openNoteComposer = useCallback(() => {
    pausePlayback();
    setNoteDraft((draft) => draft ?? { time: playhead.get(), pin: null });
  }, [pausePlayback, playhead]);

  const closeNoteComposer = useCallback(() => setNoteDraft(null), []);

  const handlePinPlace = useCallback(
    (x: number, y: number) => {
      pausePlayback();
      // Pointing at the frame is a statement about the picture, so it takes the panel back to
      // the shot even if the soundtrack was the pick.
      setNoteTarget("shot");
      setNoteDraft({ time: playhead.get(), pin: { x, y } });
    },
    [pausePlayback, playhead],
  );

  // Save the composed comment on the draft's own instant. On the soundtrack it hangs off the
  // timeline stem, timed but never pinned; on a shot it belongs to the shot that instant is in.
  const handleAddNote = useCallback(
    (text: string) => {
      if (!noteDraft) return;
      const { time, pin } = noteDraft;
      if (spanTarget) {
        session.addPending(spanTarget.address, text, { annotation: null, time });
        setNoteDraft(null);
        return;
      }
      const shot = state.shots[findShotIdxAtTime(state.shots, time)];
      if (!shot) return;
      session.addPending(shotFeedbackAddress(shot.shotId), text, {
        annotation: pin ? { kind: "pin", ...pin } : null,
        time,
        shotId: shot.shotId,
      });
      setNoteDraft(null);
    },
    [state.shots, spanTarget, session, shotFeedbackAddress, noteDraft],
  );

  // Every visible comment (saved + draft) across the timeline — one list for the sidebar, the
  // on-frame markers, and the ruler markers. Grouped by target, each target's saved comments in
  // their persisted order then this session's drafts, never by time: a note taken at the playhead
  // would otherwise land above the notes written before it and renumber the pins already on the
  // frame. Pin numbers run per target, from 1 — the unit both surfaces that show them draw.
  const displayComments = useMemo<DisplayComment[]>(() => {
    const out: DisplayComment[] = [];

    const collect = (
      address: string,
      saved: FeedbackInfo[],
      // What a comment with no time of its own (one written from the CLI) takes.
      defaultTime: number,
      shotId?: string,
    ) => {
      const target: DisplayComment[] = [];
      for (const f of liveFeedback(saved, {
        deletedFeedbackIds: session.deletedFeedbackIds,
        hideStale: session.hideStale,
      })) {
        target.push({
          id: f.id,
          address: f.address,
          time: f.time ?? defaultTime,
          ...(shotId !== undefined ? { shotId } : {}),
          text: session.editedTextById.get(f.id) ?? f.text,
          stale: f.stale,
          ...(f.annotation ? { x: f.annotation.x, y: f.annotation.y } : {}),
        });
      }
      for (const p of session.pendingFeedback[address] ?? []) {
        target.push({
          id: p.id,
          address: p.address,
          time: p.time ?? defaultTime,
          ...(shotId !== undefined ? { shotId } : {}),
          text: p.text,
          pending: true,
          ...(p.annotation ? { x: p.annotation.x, y: p.annotation.y } : {}),
        });
      }
      let n = 1;
      for (const c of target) {
        if (c.x !== undefined && c.y !== undefined) c.pinIndex = n++;
      }
      out.push(...target);
    };

    for (const shot of state.shots) {
      collect(shotFeedbackAddress(shot.shotId), shot.feedback, shot.startTime, shot.shotId);
    }
    // Soundtrack comments carry a time but no shot: a bed spans the timeline, so they sit among
    // the shot notes on the ruler while belonging to none of them, and take no pin.
    const stem = state.timelineStem;
    if (stem) collect(stem.address, stem.feedback, 0);
    if (state.overlay) collect(state.overlay.address, state.overlay.feedback, 0);
    return out;
  }, [
    state.shots,
    state.timelineStem,
    state.overlay,
    session.pendingFeedback,
    session.deletedFeedbackIds,
    session.editedTextById,
    session.hideStale,
    shotFeedbackAddress,
  ]);

  // The sidebar shows only the focused target's notes; the on-frame markers, the ruler, and
  // the per-shot counts keep working off the whole-timeline list.
  const panelComments = useMemo(
    () =>
      spanTarget
        ? displayComments.filter((c) => c.address === spanTarget.address)
        : displayComments.filter((c) => c.shotId === focusedShot?.shotId),
    [displayComments, spanTarget, focusedShot],
  );

  const noteCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of displayComments) {
      if (c.shotId) counts[c.shotId] = (counts[c.shotId] ?? 0) + 1;
    }
    return counts;
  }, [displayComments]);

  const addressNoteCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of displayComments) counts[c.address] = (counts[c.address] ?? 0) + 1;
    return counts;
  }, [displayComments]);

  const soundtrackNoteCount = useMemo(
    () =>
      state.timelineStem
        ? displayComments.filter((c) => c.address === state.timelineStem?.address).length
        : 0,
    [displayComments, state.timelineStem],
  );

  // Targets left with neither an accept nor a live comment — named once at Submit (see
  // review/undecided.ts). A shot no review can sign off (see shotAcceptable) is excluded: it has
  // nothing of its own to look at, so listing it every time would train the reviewer to dismiss the
  // confirmation unread. The soundtrack is excluded for the same reason while any shot is
  // pending: the beds span the whole timeline, so they can't be judged against a picture that is
  // still incomplete.
  const undecided = useMemo(() => {
    const commented = commentedAddresses(
      [
        ...state.shots.flatMap((s) => s.feedback),
        ...(state.timelineStem?.feedback ?? []),
        ...(state.overlay?.feedback ?? []),
      ],
      session,
    );
    const out: string[] = [];
    for (const s of state.shots) {
      if (!shotAcceptable(s) || shotAccepted[s.shotId]) continue;
      if (commented.has(shotFeedbackAddress(s.shotId))) continue;
      if (regenerateUnits.has(shotFeedbackAddress(s.shotId))) continue;
      out.push(`Shot ${s.shotId}`);
    }
    const stem = state.timelineStem;
    if (
      stem &&
      !state.shots.some((s) => s.pending) &&
      !timelineStemAccepted &&
      !commented.has(stem.address)
    ) {
      out.push("Soundtrack");
    }
    if (offeredOverlay && !overlayAccepted && !commented.has(offeredOverlay.address)) {
      out.push("Overlay");
    }
    return out;
  }, [
    state.shots,
    state.timelineStem,
    state.overlay,
    offeredOverlay,
    overlayAccepted,
    session,
    shotAccepted,
    timelineStemAccepted,
    shotFeedbackAddress,
    regenerateUnits,
  ]);

  const timedNotes = useMemo<TimedNote[]>(
    () =>
      displayComments.map((c) => ({
        id: c.id,
        time: c.time,
        text: c.text,
        shotId: c.shotId,
        x: c.x,
        y: c.y,
        stale: c.stale,
        pending: c.pending,
        pinIndex: c.pinIndex,
      })),
    [displayComments],
  );

  const handleCommentJump = useCallback(
    (c: { id: string; time: number }) => {
      setHighlightedFeedbackId(c.id);
      handleSeek(c.time);
    },
    [handleSeek, setHighlightedFeedbackId],
  );

  const handleCommentEditSave = useCallback(
    (c: DisplayComment, text: string) => {
      if (c.pending) session.editPending(c.address, c.id, text);
      else session.editExisting(c.id, c.address, text);
    },
    [session],
  );

  const handleCommentDelete = useCallback(
    (c: DisplayComment) => {
      if (c.pending) session.removePending(c.address, c.id);
      else session.deleteExisting(c.id, c.address);
    },
    [session],
  );

  const submitVideoReview = useCallback(
    async (input: SubmitInput) => {
      await submitReview(
        reelStage,
        buildReelSubmitPayload({ state, marks, keepChoices, effectiveVariants, input }),
      );
    },
    [reelStage, state, marks, keepChoices, effectiveVariants],
  );
  const handleSubmit = session.openSubmit;

  // J/K/N are shot gestures, so they point the panel back at the shot (see noteTarget).
  const seekToShot = (shot: ShotInfo | undefined) => {
    if (!shot) return;
    setNoteTarget("shot");
    handleSeek(shot.startTime);
  };
  // Accept whatever the panel is pointed at, so this signs off the soundtrack the same way it
  // signs off a shot.
  const acceptFocused = useCallback(() => {
    if (soundtrackFocused) toggleTimelineStem();
    else if (focusedOverlay) toggleOverlay();
    else if (focusedShot) toggleShotDecision(focusedShot.shotId);
  }, [
    soundtrackFocused,
    toggleTimelineStem,
    focusedOverlay,
    toggleOverlay,
    focusedShot,
    toggleShotDecision,
  ]);

  useReviewShortcuts({
    blocked:
      session.gallery !== null || infoVariant !== null || session.submitOpen || keepAsking !== null,
    onSubmit: handleSubmit,
    handlers: {
      " ": handlePlayPause,
      ArrowRight: () => handleArrowSeek(1),
      ArrowLeft: () => handleArrowSeek(-1),
      "+": () => timelineRef.current?.zoomIn(),
      "-": () => timelineRef.current?.zoomOut(),
      "=": () => timelineRef.current?.resetZoom(),
      j: () => seekToShot(state.shots[Math.min(focusedShotIdx + 1, state.shots.length - 1)]),
      k: () => seekToShot(state.shots[Math.max(focusedShotIdx - 1, 0)]),
      a: acceptFocused,
      c: openNoteComposer,
      s: () => session.setHideStale(!session.hideStale),
      ",": () => handleStepFrame(-1),
      "<": () => handleStepFrame(-1),
      ".": () => handleStepFrame(1),
      ">": () => handleStepFrame(1),
      n: handleJumpToUnreviewed,
      f: toggleTheater,
      // The browser takes Escape for itself while it holds the fullscreen; this is the way out of
      // the in-window mode it left behind (or never granted).
      ...(theater ? { Escape: exitTheater } : {}),
    },
  });

  // "Needs review" narrows to what the baseline leaves unsigned: acceptable shots whose verdict is
  // owed (a stale composition/stem or an undecided newer take), and audio not yet accepted. A
  // pending shot can never be accepted, so it would never leave the filter — it is not what still
  // needs the reviewer's attention.
  const visibleShots = useMemo(
    () =>
      session.showChangedOnly
        ? acceptableShots.filter((s) => !baseShotAccepted[s.shotId])
        : state.shots,
    [session.showChangedOnly, acceptableShots, state.shots, baseShotAccepted],
  );

  const visibleAudioAssets = useMemo(
    () =>
      session.showChangedOnly
        ? state.audioAssets.filter((a) => !audioAccepted[a.address])
        : state.audioAssets,
    [session.showChangedOnly, state.audioAssets, audioAccepted],
  );

  const boxWidth = viewportBox.width || Math.min(state.size.width, 960);
  // Filling the screen (theater, or a phone), the column gives the viewport what the controls and
  // scrubber leave, so its measured height is the box. Otherwise the box is a slot cut from the
  // column's width on the video's own aspect — a vertical piece gets a vertical slot.
  const boxHeight =
    immersive && viewportBox.height > 0
      ? viewportBox.height
      : (boxWidth * state.size.height) / state.size.width;
  const scale = Math.min(boxWidth / state.size.width, boxHeight / state.size.height);
  const dispWidth = state.size.width * scale;
  const dispHeight = state.size.height * scale;

  return (
    <ReviewShell
      error={session.error}
      onDismissError={() => session.setError(null)}
      handoffSummary={state.handoffSummary}
      unroutedHandoffNotes={state.unroutedHandoffNotes}
      showChangedOnly={session.showChangedOnly}
      onToggleChangedOnly={() => session.setShowChangedOnly(!session.showChangedOnly)}
      hideStale={session.hideStale}
      onToggleHideStale={() => session.setHideStale(!session.hideStale)}
      shortcuts={SHORTCUTS}
      actionsTarget={immersive ? theaterActionsEl : null}
      headerExtra={
        <ReviewHeaderActions
          // Only when the frame fills the screen: elsewhere the shot list carries the verdict, and
          // a second button for the same mark would be two places to look.
          acceptCurrent={
            fill
              ? {
                  accepted: soundtrackFocused
                    ? timelineStemAccepted
                    : focusedOverlay
                      ? overlayAccepted
                      : !!focusedShot && !!shotAccepted[focusedShot.shotId],
                  what: soundtrackFocused
                    ? "soundtrack"
                    : focusedOverlay
                      ? "overlay"
                      : `shot ${focusedShot?.shotId ?? ""}`,
                  disabled: soundtrackFocused
                    ? !state.timelineStem
                    : focusedOverlay
                      ? false
                      : !(focusedShot && shotAcceptable(focusedShot)),
                  onClick: acceptFocused,
                }
              : undefined
          }
          acceptAll={{
            done: everythingAccepted,
            what: "every shot and all audio",
            onClick: acceptAll,
          }}
          reset={{
            disabled: !session.hasPendingChanges,
            onClick: () => {
              resetDecisions();
              session.reset();
            },
          }}
        />
      }
      submitting={session.submitting}
      submitted={session.submitted}
      submittedTitle="Review Submitted"
      canSubmit={session.hasPendingChanges}
      submitHint="Nothing to submit yet. Accept something, leave a note, or write an overall comment above."
      onSubmit={handleSubmit}
      undecided={undecided}
      regenerate={regenerateSummary(keepGraph, keepChoices, reelStage)}
      submitOpen={session.submitOpen}
      overallComment={session.overallComment}
      onOverallCommentChange={session.setOverallComment}
      onConfirmSubmit={() => void session.confirmSubmit(submitVideoReview)}
      onCancelSubmit={session.cancelSubmit}
    >
      <div
        className={`video-preview-video${fill ? ` vp-fill vp-fill--band-${bandSide}` : ""}`}
        // Every slot cut for the frame is cut on the picture's own shape — the fill layout's
        // hugging slot, and the stacked theater's.
        style={
          { "--video-aspect": `${state.size.width} / ${state.size.height}` } as React.CSSProperties
        }
      >
        {/* The header's toggles and actions, rehoused: one bar across the feedback and shots
            columns (see ReviewShell's actionsTarget). Filling the screen hides the header. */}
        {immersive && <div className="vp-theater-actions" ref={setTheaterActionsEl} />}
        <div className="vp-col vp-col-video">
          <div
            ref={viewportRef}
            className="vp-video-viewport"
            style={immersive ? undefined : { height: boxHeight }}
          >
            <div className="player-stage" style={{ width: dispWidth, height: dispHeight }}>
              <HyperFramesPlayerWrapper
                compositionHtml={compositionHtml}
                fps={state.fps}
                width={state.size.width}
                height={state.size.height}
                scale={scale}
                getStartTime={playhead.get}
                onTimeUpdate={handleTimeUpdate}
                onPlayingChange={setIsPlaying}
                onReady={handlePlayerReady}
                playerRef={playerRef}
              />
              {focusedShot?.pending && (
                // An undeveloped shot (pendingShot) has no composition, so the player would hold the
                // previous shot's frame across this shot. Cover it with a tile carrying the direction's
                // action so the shot reads as a deliberate placeholder — the in-player twin of the
                // animatic black tile.
                <div className="vp-pending-overlay">
                  <span className="status-badge status-badge--pending">Pending</span>
                  {focusedShot.action && (
                    <p className="vp-pending-overlay-caption">{focusedShot.action}</p>
                  )}
                </div>
              )}
              {focusedShot?.showingStandIn && (
                // The stage twin of the shot list's badge. The board plays like any other shot, so
                // nothing on screen would otherwise say this picture has not been made.
                <span className="vp-animatic-label">Animatic: not made yet</span>
              )}
              <TimedNoteOverlay
                width={state.size.width}
                height={state.size.height}
                scale={scale}
                frameWidth={boxWidth}
                notes={showNotes ? timedNotes : []}
                playhead={playhead}
                currentShotId={focusedShot?.shotId}
                pendingPinCoords={noteDraft?.pin ?? null}
                highlightedNoteId={highlightedFeedbackId}
                onPinPlace={handlePinPlace}
                onNoteClick={handleCommentJump}
              />
            </div>
          </div>

          {immersive && (
            // Directly under the frame, where a player's seek bar belongs. The tracks are what
            // theater mode hands back to the picture; this keeps what a reviewer still needs
            // while watching — where the playhead is, and what to jump to.
            <TheaterScrubber
              shots={visibleShots}
              totalDuration={state.totalDuration}
              playhead={playhead}
              shotFrames={shotFrames}
              shotAccepted={shotAccepted}
              focusedShotId={focusedShot?.shotId}
              notes={showNotes ? timedNotes : undefined}
              onSeek={handleSeek}
              onSeekToNote={handleCommentJump}
            />
          )}

          <div className="player-controls">
            <button
              className="ctrl-btn"
              onClick={() => handleSeek(0)}
              title="Back to start"
              aria-label="Back to start"
            >
              <SkipToStartIcon size={14} />
            </button>
            <button
              className="ctrl-btn"
              onClick={() => handleStepFrame(-1)}
              title="Previous frame (,)"
              aria-label="Previous frame"
            >
              <StepBackIcon size={14} />
            </button>
            <button
              className="ctrl-btn ctrl-btn--primary"
              onClick={handlePlayPause}
              title={isPlaying ? "Pause (Space)" : "Play (Space)"}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
            </button>
            <button
              className="ctrl-btn"
              onClick={() => handleStepFrame(1)}
              title="Next frame (.)"
              aria-label="Next frame"
            >
              <StepForwardIcon size={14} />
            </button>
            <button
              className={`ctrl-btn${loopMode !== "off" ? " ctrl-btn--active" : ""}`}
              onClick={() =>
                setLoopMode((m) => (m === "off" ? "all" : m === "all" ? "shot" : "off"))
              }
              title="Cycle loop: off → whole video → current shot"
              aria-label={`Loop: ${loopMode === "off" ? "off" : loopMode === "all" ? "whole video" : "current shot"}`}
              aria-pressed={loopMode !== "off"}
            >
              <LoopIcon size={14} />
              {loopMode === "shot" ? " shot" : loopMode === "all" ? " all" : ""}
            </button>
            <label className="ctrl-speed" title="Playback speed">
              <select
                className="ctrl-speed-select"
                aria-label="Playback speed"
                value={playbackRate}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
              >
                {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
            </label>
            <button
              className={`ctrl-btn${showNotes ? " ctrl-btn--active" : ""}`}
              onClick={() => setShowNotes(!showNotes)}
              title="Show this shot's notes on the frame"
              aria-pressed={showNotes}
            >
              <CommentIcon size={14} /> Notes
            </button>
            {!fill && (
              <button
                className={`ctrl-btn${theater ? " ctrl-btn--active" : ""}`}
                onClick={toggleTheater}
                title={
                  theater
                    ? "Leave fullscreen (F or Esc)"
                    : "Fill the window. The frame grows, the notes and shots stay with it (F)"
                }
                aria-label={theater ? "Leave fullscreen" : "Fullscreen"}
              >
                {theater ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
              </button>
            )}
            <PlayerTime playhead={playhead} totalDuration={state.totalDuration} />
          </div>

          {!immersive && (
            <ReviewTimeline
              timelineRef={timelineRef}
              shots={visibleShots}
              audioAssets={visibleAudioAssets}
              totalDuration={state.totalDuration}
              playhead={playhead}
              isPlaying={isPlaying}
              shotAccepted={shotAccepted}
              focusedShotId={focusedShot?.shotId}
              soundtrackFocused={soundtrackFocused}
              focusRequest={focusRequest}
              shotFrames={shotFrames}
              notes={showNotes ? timedNotes : undefined}
              onSeek={handleSeek}
              onFocusSoundtrack={focusSoundtrack}
              onOpenGallery={(address) => session.setGallery({ address })}
              infoOpener={infoOpener}
              onSeekToNote={handleCommentJump}
            />
          )}
        </div>

        <div className="vp-side">
          <div className="vp-col vp-col-target">
            <TargetPanel
              subject={spanTarget ? spanTarget.label : focusedShot && `Shot ${focusedShot.shotId}`}
              pinnable={!spanTarget}
              script={spanTarget ? undefined : focusedShot?.script}
              moves={spanTarget ? undefined : focusedShot?.moves}
              board={reelStage === "animatic"}
              variants={
                focusedGalleryTabs.length > 0
                  ? {
                      newCount: focusedGalleryTabs.reduce(
                        (n, address) =>
                          n +
                          (assetByAddress.get(address)?.variants.filter(isNewVariant).length ?? 0),
                        0,
                      ),
                      onOpen: () => session.setGallery({ address: focusedGalleryTabs[0]! }),
                    }
                  : undefined
              }
              waivers={spanTarget ? undefined : focusedShot?.waivers}
              handoffNotes={spanTarget ? undefined : focusedShot?.handoffNotes}
              comments={panelComments}
              highlightedId={highlightedFeedbackId}
              draft={noteDraft}
              onJump={handleCommentJump}
              onEditSave={handleCommentEditSave}
              onDelete={handleCommentDelete}
              onAddNote={handleAddNote}
              onOpenComposer={openNoteComposer}
              onCloseComposer={closeNoteComposer}
            />
          </div>

          <div className="vp-col vp-col-shots">
            {state.timelineStem && !(session.showChangedOnly && baseTimelineStemAccepted) && (
              /* Selectable like a shot card, so the feedback panel can point at the beds — the
               one reviewable target with no shot to hang a comment on. */
              /* oxlint-disable jsx-a11y/prefer-tag-over-role */
              <div
                role="button"
                tabIndex={0}
                className={`vp-soundtrack-box${soundtrackFocused ? " vp-soundtrack-box--focused" : ""}`}
                onClick={toggleSoundtrackFocus}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target === e.currentTarget) {
                    e.preventDefault();
                    toggleSoundtrackFocus();
                  }
                }}
                title={
                  soundtrackFocused
                    ? "Click to stop reviewing the soundtrack"
                    : "Review the soundtrack: its notes and accept"
                }
              >
                <h3 className="panel-title">
                  Soundtrack
                  {soundtrackNoteCount > 0 && (
                    <span className="vp-shot-item-notes">
                      <CommentIcon size={12} /> {soundtrackNoteCount}
                    </span>
                  )}
                  {timelineStemChanged && <StatusBadge status="changed" label="Changed" />}
                </h3>
                <AcceptButton
                  accepted={timelineStemAccepted}
                  title={
                    timelineStemAccepted ? "Click to unaccept" : "Accept the video's soundtrack(s)"
                  }
                  onClick={toggleTimelineStem}
                />
              </div>
              /* oxlint-enable jsx-a11y/prefer-tag-over-role */
            )}
            {offeredOverlay && !(session.showChangedOnly && baseOverlayAccepted) && (
              /* Offered once every shot accept stands and the overlay changed after them:
               selectable like the soundtrack, for its notes and its accept. */
              /* oxlint-disable jsx-a11y/prefer-tag-over-role */
              <div
                role="button"
                tabIndex={0}
                className={`vp-soundtrack-box${focusedOverlay ? " vp-soundtrack-box--focused" : ""}`}
                onClick={toggleOverlayFocus}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target === e.currentTarget) {
                    e.preventDefault();
                    toggleOverlayFocus();
                  }
                }}
                title={
                  focusedOverlay
                    ? "Click to stop reviewing the overlay"
                    : "Review the overlay, changed after every shot was accepted"
                }
              >
                <h3 className="panel-title">
                  Overlay
                  {(addressNoteCounts[offeredOverlay.address] ?? 0) > 0 && (
                    <span className="vp-shot-item-notes">
                      <CommentIcon size={12} /> {addressNoteCounts[offeredOverlay.address]}
                    </span>
                  )}
                  <StatusBadge status="changed" label="Changed" />
                </h3>
                <AcceptButton
                  accepted={overlayAccepted}
                  title={
                    overlayAccepted
                      ? "Click to unaccept"
                      : "Accept the overlay over the whole video"
                  }
                  onClick={toggleOverlay}
                />
              </div>
              /* oxlint-enable jsx-a11y/prefer-tag-over-role */
            )}
            <ShotList
              shots={visibleShots}
              progress={{
                accepted: acceptableShots.length - unreviewedShotIds.length,
                total: acceptableShots.length,
              }}
              shotAccepted={shotAccepted}
              decisions={marks.shots}
              noteCounts={noteCounts}
              focusedShotId={focusedShot?.shotId}
              regenerate={regenerateByShot}
              onKeepShot={keepShotAfterAll}
              onToggleDecision={toggleShotDecision}
              onJumpToShot={handleJumpToShot}
              titleAction={
                <NextUnreviewedButton
                  count={unreviewedShotIds.length}
                  noun="shot"
                  onClick={handleJumpToUnreviewed}
                />
              }
            />
          </div>
        </div>

        {session.gallery &&
          (() => {
            const asset = assetByAddress.get(session.gallery.address);
            if (!asset) return null;
            const target = galleryTargets.all.find((t) => t.tabs.includes(asset.address));
            return (
              <VariantGallery
                subject={target?.subject}
                tabs={target?.tabs.flatMap((address) => galleryTabOf(address) ?? [])}
                activeTab={asset.address}
                onSelectTab={(address) => session.setGallery({ address })}
                label={asset.assetName}
                kind={asset.mediaKind}
                variants={asset.variants}
                selectedVariantId={effectiveVariants[session.gallery.address] ?? asset.variantId}
                onUse={(variantId) => session.useVariant(session.gallery!.address, variantId)}
                onOpenInfo={(variantId) => setInfoVariant({ address: asset.address, variantId })}
                infoOpen={infoVariant !== null}
                onClose={() => session.setGallery(null)}
              />
            );
          })()}

        {keepAsking && (
          <KeepOrRegenerateModal
            prompt={keepPrompt(keepGraph, keepAsking.entries, reelStage)}
            accepting={keepAsking.origins.length}
            onAnswer={answerKeep}
          />
        )}

        {infoVariant &&
          (() => {
            const asset = assetByAddress.get(infoVariant.address);
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
    </ReviewShell>
  );
}
