import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCompositionHtml, submitReview } from "../api.js";
import { formatPlayerTime } from "../format-time.js";
import { Playhead, usePlayheadTime } from "../review/playhead.js";
import { ReviewShell, type ShortcutRows } from "../review/review-shell.js";
import { bulkAcceptState } from "../review/bulk-accept.js";
import { reelAcceptUnits, type ReelUnit, shotAcceptable } from "../review/shot-acceptable.js";
import { commentedAddresses } from "../review/undecided.js";
import { useEffectiveVariants } from "../review/use-effective-variants.js";
import { useFillLayout } from "../review/use-fill-layout.js";
import { useHighlightedFeedback } from "../review/use-highlighted-feedback.js";
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
  type KeepOrigin,
} from "../review/keep-or-regenerate.js";
import { useKeepChoices } from "../review/use-keep-choices.js";
import type {
  FeedbackInfo,
  MediaKind,
  VariantInfo,
  VideoPreviewState,
  ShotInfo,
} from "../types.js";
import {
  HyperFramesPlayerWrapper,
  type HyperFramesPlayerRef,
} from "./hyperframes-player-wrapper.js";
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
import { CommentsPanel, type DisplayComment, type NoteDraft } from "./comments-panel.js";
import { NextUnreviewedButton, ReviewHeaderActions } from "./review-header-actions.js";
import { ReviewTimeline, type ReviewTimelineRef } from "./review-timeline.js";
import { StatusBadge } from "./status-badge.js";
import { TimedNoteOverlay, type TimedNote } from "./timed-note-overlay.js";
import { ShotList } from "./shot-list.js";
import { TheaterScrubber } from "./theater-scrubber.js";
import { AssetInfoPanel, type InfoTake, takeInfo } from "./asset-info-panel.js";
import { VariantGallery } from "./variant-gallery.js";
import { KeepOrRegenerateModal } from "./keep-or-regenerate-modal.js";
import type { RegenerateMark } from "./regenerate-badge.js";

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

// At most this many frame captures run at once. Each capture loads the whole clip into a
// hidden <video>, so the unbounded startup sweep decoded every clip on the timeline
// simultaneously — on a large project that is hundreds of concurrent full-file loads.
const CAPTURE_CONCURRENCY = 4;

function limitConcurrency(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async (fn) => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/**
 * Grab the first and last frame of a video file client-side via a hidden <video>
 * element (same-origin, so the canvas isn't tainted). No server-side rendering.
 */
function captureFirstLastFrame(
  url: string,
): Promise<{ first: string | null; last: string | null }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    const canvas = document.createElement("canvas");
    const out: { first: string | null; last: string | null } = { first: null, last: null };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore teardown errors
      }
      resolve(out);
    };
    const timer = setTimeout(finish, 8000);
    const grab = (): string | null => {
      try {
        if (!video.videoWidth) return null;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0);
        return canvas.toDataURL("image/jpeg", 0.7);
      } catch {
        return null;
      }
    };
    let stage: "first" | "last" = "first";
    const onSeeked = () => {
      if (stage === "first") {
        out.first = grab();
        stage = "last";
        const d = video.duration;
        const lastT = Number.isFinite(d) && d > 0.2 ? d - 0.1 : video.currentTime;
        if (lastT <= video.currentTime + 0.001) {
          out.last = out.first;
          finish();
        } else {
          video.currentTime = lastT;
        }
      } else {
        out.last = grab();
        finish();
      }
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener(
      "loadeddata",
      () => {
        video.currentTime = 0.04;
      },
      { once: true },
    );
    video.addEventListener("error", finish, { once: true });
    video.src = url;
  });
}

/**
 * Order the composition's <video> elements, keyed by file basename. `start` is
 * the konte <Video> `data-start` attribute (its timeline position — currently 0
 * by default, but specifiable in the future); `idx` is document order used as a
 * tiebreak. Ordering clips by (start, idx) yields timeline / authoring order.
 * Parsed via DOMParser (inert document: no script/resource loading).
 */
function parseVideoOrder(html: string): Map<string, { start: number; idx: number }> {
  const order = new Map<string, { start: number; idx: number }>();
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("video").forEach((el, idx) => {
    const base = el.getAttribute("src")?.split("/").pop();
    const start = Number(el.getAttribute("data-start") ?? 0);
    if (base && !order.has(base)) order.set(base, { start, idx });
  });
  return order;
}

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

function findShotIdxAtTime(shots: ShotInfo[], time: number): number {
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]!;
    if (time >= s.startTime && time < s.startTime + s.duration) return i;
  }
  return shots.length > 0 ? shots.length - 1 : -1;
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

// Every accept mark this session holds. `undefined` is "no mark" — the unit reads at its baseline.
type ReelMarks = {
  shots: Record<string, "accepted" | "none">;
  stem: "accepted" | "none" | undefined;
};

export function VideoPreview({ state }: { state: VideoPreviewState }): React.ReactElement {
  const [compositionHtml, setCompositionHtml] = useState<string | null>(null);
  // Playback reports a new time ~30×/s. It lives outside React state so only the leaves that
  // show it (the clock, the playhead line, the note overlay) redraw with it; the shot the
  // playhead is *in* changes rarely, so that stays ordinary state.
  const [playhead] = useState(() => new Playhead());
  const [focusedShotIdx, setFocusedShotIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, "accepted" | "none">>({});
  // The timeline audio stem (soundtrack beds) accept mark for this session; undefined = undecided.
  const [timelineStemDecision, setTimelineStemDecision] = useState<"accepted" | "none" | undefined>(
    undefined,
  );

  // What the feedback panel is pointed at. "shot" follows the playhead; "soundtrack" is a
  // sticky pick (the beds span the whole timeline, so seeking to hear one must not snap the
  // panel back to whatever shot the playhead landed in). Only an explicit shot gesture —
  // picking a card, J/K/N, placing a pin — points it back at the shot.
  const [noteTarget, setNoteTarget] = useState<"shot" | "soundtrack">("shot");

  // The take whose declaration panel is open, stacked over the gallery when opened from there.
  const [infoTake, setInfoTake] = useState<InfoTake | null>(null);

  // The comment being written: the instant it is about, and the pin on that frame if one was
  // placed. Non-null means the composer is open.
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [highlightedFeedbackId, setHighlightedFeedbackId] = useHighlightedFeedback();
  const [focusRequest, setFocusRequest] = useState<{
    start: number;
    duration: number;
    seq: number;
  }>();

  const [loopMode, setLoopMode] = useState<"off" | "all" | "shot">("off");
  const [showNotes, setShowNotes] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);

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

  const {
    choices: keepChoices,
    asking: keepAsking,
    request: requestKeep,
    answer: answerKeep,
    dropUnits: dropKeepUnits,
    keepUnit: keepUnitAfterAll,
    reset: resetKeep,
  } = useKeepChoices();
  const session = useReviewSession({
    hasExtraChanges:
      Object.keys(decisions).length > 0 ||
      timelineStemDecision !== undefined ||
      keepChoices.length > 0,
  });

  const playerRef = useRef<HyperFramesPlayerRef>(null);
  const timelineRef = useRef<ReviewTimelineRef>(null);
  const playbackRateRef = useRef(1);
  // Read by the player's frame reports, which must not pull the review into a re-render per frame.
  const noteDraftRef = useRef<NoteDraft | null>(null);
  noteDraftRef.current = noteDraft;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportBox, setViewportBox] = useState({ width: 0, height: 0 });
  const [shotFrames, setShotFrames] = useState<
    Record<string, { first: string | null; last: string | null }>
  >({});

  // Which reel this page is playing. One page serves both composition stages, so every address it
  // mints and the endpoint it submits to are the mode's.
  const reelStage = state.mode === "animatic-preview" ? "animatic" : "video";

  const shotFeedbackAddress = useCallback(
    // Composite feedback attaches to the bare shot target (feedback-only, no
    // variant), so a pin reads as an observation on the shot rather than a
    // "reroll the composition" instruction. Staleness still tracks the
    // composition via the variant snapshot recorded when the comment is saved.
    (shotId: string) => `${reelStage}:shot.${shotId}`,
    [reelStage],
  );

  const focusedShot = state.shots[focusedShotIdx];

  // A reload that drops the soundtracks takes the panel's target with it, so the pick is read
  // through the stem's presence rather than trusted on its own.
  const soundtrackFocused = noteTarget === "soundtrack" && !!state.timelineStem;

  // A definition reload can shrink the timeline out from under the focused index.
  useEffect(() => {
    setFocusedShotIdx((i) => Math.min(i, Math.max(state.shots.length - 1, 0)));
  }, [state.shots]);

  // Every asset with takes to show — the shots' and the audio beds' — for the player and the
  // submit snapshots.
  const allAssets = useMemo(
    () => [...state.shots.flatMap((s) => s.assets), ...state.audioAssets],
    [state.shots, state.audioAssets],
  );
  const effectiveVariants = useEffectiveVariants(allAssets, session.selectedVariants);

  // The take each address resolves to, for telling an audition from what stands.
  const resolvedByAddress = useMemo(
    () => new Map(allAssets.map((a) => [a.address, a.variantId])),
    [allAssets],
  );

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

  // The timeline's info button opens the take the reel is playing at that address.
  const infoOpener = useCallback(
    (address: string): (() => void) | undefined => {
      const asset = assetByAddress.get(address);
      const variantId = effectiveVariants[address] ?? asset?.variantId ?? null;
      if (!asset || !variantId || !takeInfo(asset.variants, variantId)) return undefined;
      return () => setInfoTake({ address, variantId });
    },
    [assetByAddress, effectiveVariants],
  );

  const { setError } = session;
  // The stand-ins this page was told about, as a stable key: the reel is re-fetched when the set
  // moves (a shot whose picture just landed must redraw), and never merely because state was re-read.
  const standInShotIds = useMemo(
    () => state.shots.filter((s) => s.showingStandIn).map((s) => s.shotId),
    [state.shots],
  );
  const standInShotKey = standInShotIds.join(",");
  useEffect(() => {
    // Switching takes in quick succession (or a hot-reload landing on top of one) leaves two
    // fetches in flight, and the slower one is not always the older one — abort the previous
    // request so the composition on screen is always the one last asked for.
    let controller: AbortController | null = null;
    function load() {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      // Pinned to the same takes the submit will record, or the composite re-resolves its external
      // refs against state loaded for THIS request — a reroll landing between the two draws one take
      // and the comment written over it names another. A gallery pick still wins.
      const pinned = { ...state.compositionRefVariants, ...effectiveVariants };
      const overrides = Object.keys(pinned).length > 0 ? pinned : undefined;
      fetchCompositionHtml(
        undefined,
        undefined,
        overrides,
        signal,
        standInShotKey ? standInShotKey.split(",") : [],
      )
        .then(setCompositionHtml)
        .catch((err) => {
          if (signal.aborted) return;
          setError(err.message);
        });
    }
    // Auditioning a take is a comparison, so the reel keeps the instant it was switched at rather
    // than dropping back to its head: the player pauses here and resumes at the playhead once the
    // new composition is ready (see the wrapper's getStartTime). A reel that came back shorter
    // reports the frame it actually landed on, which puts the playhead and the focused shot right.
    playerRef.current?.pause();
    setIsPlaying(false);
    load();
    window.addEventListener("konte:reload", load);
    return () => {
      controller?.abort();
      window.removeEventListener("konte:reload", load);
    };
  }, [effectiveVariants, state.compositionRefVariants, setError, standInShotKey]);

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

  // Capturing a frame means loading the whole video file, so each URL is captured once and
  // remembered: switching one shot's take then re-captures that shot's clip alone, instead of
  // re-loading every video in the timeline.
  const frameCacheRef = useRef(
    new Map<string, Promise<{ first: string | null; last: string | null }>>(),
  );
  const captureCached = useCallback((url: string) => {
    const cached = frameCacheRef.current.get(url);
    if (cached) return cached;
    // Remember successes only. A capture that yielded nothing — a decode error, a file the server
    // hadn't written yet — is a transient failure, and caching it would leave that shot's strip
    // permanently blank for the rest of the session; evict so the next pass retries.
    const capture = captureFirstLastFrame(url).then((frames) => {
      if (!frames.first && !frames.last) frameCacheRef.current.delete(url);
      return frames;
    });
    frameCacheRef.current.set(url, capture);
    return capture;
  }, []);

  useEffect(() => {
    const shots = state.shots;
    if (shots.length === 0) return;
    let cancelled = false;
    // Drop shots the reload removed; the rest are refreshed (from cache, mostly) below.
    setShotFrames((p) => {
      const live = Object.fromEntries(
        Object.entries(p).filter(([id]) => shots.some((s) => s.shotId === id)),
      );
      return Object.keys(live).length === Object.keys(p).length ? p : live;
    });
    (async () => {
      // Order each shot's videos by data-start (timeline position), then document
      // order — see parseVideoOrder. Falls back to definition order if no HTML.
      let html = "";
      try {
        html = await fetchCompositionHtml(
          undefined,
          undefined,
          undefined,
          undefined,
          standInShotIds,
        );
      } catch {
        // fall back to definition order
      }
      if (cancelled) return;
      const order = parseVideoOrder(html);
      const FAR = { start: Number.MAX_SAFE_INTEGER, idx: Number.MAX_SAFE_INTEGER };
      const sortKey = (url: string) => order.get(url.split("/").pop() ?? "") ?? FAR;
      const limit = limitConcurrency(CAPTURE_CONCURRENCY);
      await Promise.allSettled(
        shots.map((shot) =>
          limit(async () => {
            if (cancelled) return;
            const videoUrls = shot.assets
              .filter((a) => a.mediaKind === "video")
              // Capture the variant the reviewer is actually seeing (matches the player), not
              // just the accepted one — so a shown reroll's frame is what the scrub preview uses.
              .map((a) => {
                const shownId = effectiveVariants[a.address] ?? a.variantId;
                return a.variants.find((v) => v.variantId === shownId)?.fileUrl ?? a.fileUrl;
              })
              .filter((u): u is string => !!u)
              .sort((a, b) => {
                const ka = sortKey(a);
                const kb = sortKey(b);
                return ka.start - kb.start || ka.idx - kb.idx;
              });
            // A shot that lost its video (a reload, or a take with no ready file) must lose its
            // scrub thumbnail too — the frames are no longer of anything on the timeline.
            if (videoUrls.length === 0) {
              if (!cancelled) {
                setShotFrames((p) => {
                  if (!(shot.shotId in p)) return p;
                  const next = { ...p };
                  delete next[shot.shotId];
                  return next;
                });
              }
              return;
            }
            const firstUrl = videoUrls[0]!;
            const lastUrl = videoUrls[videoUrls.length - 1]!;
            let frames: { first: string | null; last: string | null };
            if (firstUrl === lastUrl) {
              frames = await captureCached(firstUrl);
            } else {
              const [a, b] = await Promise.all([captureCached(firstUrl), captureCached(lastUrl)]);
              frames = { first: a.first, last: b.last };
            }
            if (!cancelled) setShotFrames((p) => ({ ...p, [shot.shotId]: frames }));
          }),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [state.shots, standInShotIds, effectiveVariants, captureCached]);

  const handleTimeUpdate = useCallback(
    (time: number) => {
      playhead.set(time);
      setFocusedShotIdx(findShotIdxAtTime(state.shots, time));
      // The panel names the shot at this instant, so an open composer moves with it whatever put
      // the playhead here — a frame step, the player settling a seek onto its own 30fps grid, a
      // reload resuming. Both sides then read one time, so a note cannot file off the shot shown.
      const draft = noteDraftRef.current;
      if (draft && draft.time !== time) setNoteDraft({ ...draft, time });
      // A loop restart would undo the pause the composer opened with and carry a half-typed
      // note off its shot, so the reel holds still while one is being written.
      if (draft) return;
      if (loopMode === "all" && time >= state.totalDuration - 0.05) {
        playerRef.current?.seek(0);
        playerRef.current?.play();
      } else if (loopMode === "shot") {
        // Loop whichever shot the playhead is currently in; checking 0.05s before
        // its end keeps findShotIdxAtTime on the right shot at the boundary.
        const shot = state.shots[findShotIdxAtTime(state.shots, time)];
        if (shot && time >= shot.startTime + shot.duration - 0.05) {
          playerRef.current?.seek(shot.startTime);
          playerRef.current?.play();
        }
      }
    },
    [playhead, loopMode, state.totalDuration, state.shots],
  );

  const pausePlayback = useCallback(() => {
    playerRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const handleSeek = useCallback(
    (time: number) => {
      playerRef.current?.seek(time);
      playhead.set(time);
      setFocusedShotIdx(findShotIdxAtTime(state.shots, time));
      // Moving the playhead on purpose is the reviewer saying they now mean this frame, so an
      // open composer follows — and drops a pin left on the frame it was placed on. Without
      // this the note keeps the instant it opened at and files to the shot left behind.
      setNoteDraft((draft) => (draft ? { time, pin: null } : null));
    },
    [playhead, state.shots],
  );

  const handleStepFrame = useCallback((delta: number) => {
    setIsPlaying(false);
    playerRef.current?.stepFrame(delta);
    // Stepping is a deliberate move off the frame a pin was placed on; the instant follows in
    // handleTimeUpdate, once the player reports where it landed.
    setNoteDraft((draft) => (draft?.pin ? { ...draft, pin: null } : draft));
  }, []);

  // Arrow-key seek: one frame per press, so a tap nudges and a held key repeats at the OS
  // key-repeat rate into a smooth ~1× scrub. Each repeat steps off the live playhead, which the
  // store updates synchronously — reading a rendered value would make every repeat in a burst
  // seek from the same stale instant.
  const handleArrowSeek = useCallback(
    (direction: -1 | 1) => {
      if (isPlaying) {
        playerRef.current?.pause();
        setIsPlaying(false);
      }
      const next = Math.min(
        Math.max(playhead.get() + direction / state.fps, 0),
        state.totalDuration,
      );
      handleSeek(next);
    },
    [playhead, isPlaying, state.fps, state.totalDuration, handleSeek],
  );

  // Apply playback rate live; re-applied on composition reload via player onReady.
  useEffect(() => {
    playbackRateRef.current = playbackRate;
    playerRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      playerRef.current?.pause();
      setIsPlaying(false);
    } else {
      if (playhead.get() >= state.totalDuration - 0.25) {
        playerRef.current?.seek(0);
        playhead.set(0);
        setFocusedShotIdx(0);
      }
      playerRef.current?.play();
      setIsPlaying(true);
    }
  }, [playhead, isPlaying, state.totalDuration]);

  // Where each shot stands before this session touched it. Whether anything it signs off is still
  // undecided is the SERVER's answer (`needsVerdict`) — one rule for what settles a shot, shared
  // with the accept it drives. Only the preview override is the page's own: auditioning a
  // non-accepted take is a state of this session.
  const baseShotAccepted = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const s of state.shots) {
      // Standing in with the board: there is no accept to reflect.
      if (s.showingStandIn) {
        map[s.shotId] = false;
        continue;
      }
      // Only the addresses this shot's verdict actually lands on (`verdictAddresses`), so
      // auditioning a take the accept never touches does not read as an unsaved change.
      const viewingNonAccepted = s.verdictAddresses.some((address) => {
        const resolved = resolvedByAddress.get(address);
        if (resolved === undefined) return false;
        return (effectiveVariants[address] ?? resolved) !== resolved;
      });
      map[s.shotId] = !s.needsVerdict && !viewingNonAccepted;
    }
    return map;
  }, [state.shots, effectiveVariants, resolvedByAddress]);

  // The timeline audio stem (soundtrack beds): the persisted accept unless it is stale/unaccepted.
  const baseTimelineStemAccepted = useMemo(() => {
    const ts = state.timelineStem;
    return !!ts && ts.variantId !== null && !ts.needsReview;
  }, [state.timelineStem]);

  // The marks this session has made, as one value.
  const marks: ReelMarks = useMemo(
    () => ({ shots: decisions, stem: timelineStemDecision }),
    [decisions, timelineStemDecision],
  );

  // Where one unit stands under a given set of marks: an explicit mark this session wins over the
  // baseline. The page's ONE reader — every view below is this function.
  const unitAccepted = useCallback(
    (unit: ReelUnit, m: ReelMarks): boolean =>
      unit.kind === "stem"
        ? (m.stem ?? (baseTimelineStemAccepted ? "accepted" : "none")) === "accepted"
        : (m.shots[unit.shotId] ?? (baseShotAccepted[unit.shotId] ? "accepted" : "none")) ===
          "accepted",
    [baseShotAccepted, baseTimelineStemAccepted],
  );

  const shotAccepted = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const s of state.shots)
      map[s.shotId] = unitAccepted({ kind: "shot", shotId: s.shotId }, marks);
    return map;
  }, [state.shots, unitAccepted, marks]);

  const timelineStemAccepted = unitAccepted({ kind: "stem" }, marks);

  // Every shot a review can sign off (see shotAcceptable) — the rest have their accept affordances
  // disabled and are excluded from Accept all, the unreviewed count, and the review filters.
  const acceptableShots = useMemo(() => state.shots.filter(shotAcceptable), [state.shots]);

  const unacceptableShotIds = useMemo(
    () => new Set(state.shots.filter((s) => !shotAcceptable(s)).map((s) => s.shotId)),
    [state.shots],
  );

  // Accept is a toggle (un-accept on second click). A shot accept signs off both its picture
  // (composition) and its audio (the shot's stem) server-side — no separate per-audio decision.
  // Toggling back to the baseline drops the mark rather than recording a no-op decision, so
  // Submit can tell "nothing to save" from "saved a change that happens to match".
  const keepGraph = state.keep ?? EMPTY_KEEP_GRAPH;

  // The shot whose verdict lands on each address this page accepts.
  const shotOfAddress = useMemo(
    () =>
      new Map(state.shots.flatMap((s) => s.verdictAddresses.map((a) => [a, s.shotId] as const))),
    [state.shots],
  );
  const shotOfUnit = useMemo(
    () => new Map(state.shots.map((s) => [shotFeedbackAddress(s.shotId), s.shotId] as const)),
    [state.shots, shotFeedbackAddress],
  );

  // What a Keep-or-regenerate prompt reads, under the shot marks the accept being asked about leaves.
  const keepContextFor = useCallback(
    (
      markOf: (shotId: string) => "accepted" | "none" | undefined,
      choices: readonly KeepChoice[],
    ): KeepContext => ({
      graph: keepGraph,
      takeAccepted: (address) => {
        const shotId = shotOfAddress.get(address);
        const mark = shotId === undefined ? undefined : markOf(shotId);
        return mark ? mark === "accepted" : keepGraph.addresses[address]?.acceptedVariantId != null;
      },
      takeOf: (address) =>
        resolvedByAddress.has(address)
          ? (effectiveVariants[address] ?? resolvedByAddress.get(address) ?? null)
          : (keepGraph.addresses[address]?.acceptedVariantId ?? null),
      choices,
    }),
    [keepGraph, shotOfAddress, resolvedByAddress, effectiveVariants],
  );

  const keepOriginOf = useCallback(
    (shot: ShotInfo): KeepOrigin => ({
      unit: shotFeedbackAddress(shot.shotId),
      chosen: Object.fromEntries(
        shot.verdictAddresses.flatMap((address) => {
          const variantId = effectiveVariants[address] ?? resolvedByAddress.get(address);
          return variantId ? [[address, variantId]] : [];
        }),
      ),
    }),
    [shotFeedbackAddress, effectiveVariants, resolvedByAddress],
  );

  const applyShotMark = useCallback(
    (shotId: string, accepted: boolean) => {
      setDecisions((prev) => {
        const next = { ...prev };
        if (accepted === baseShotAccepted[shotId]) delete next[shotId];
        else next[shotId] = accepted ? "accepted" : "none";
        return next;
      });
    },
    [baseShotAccepted],
  );

  const markShot = useCallback(
    (shotId: string, accepted: boolean) => {
      // Guards the A shortcut too, which reaches no disabled button.
      if (unacceptableShotIds.has(shotId)) return;
      const unit = shotFeedbackAddress(shotId);
      const shot = state.shots.find((s) => s.shotId === shotId);
      if (!accepted || !shot) {
        dropKeepUnits([unit]);
        applyShotMark(shotId, accepted);
        return;
      }
      const entries = keepPromptFor(
        keepContextFor(
          (id) => (id === shotId ? "accepted" : decisions[id]),
          withoutUnits(keepChoices, [unit]),
        ),
        [keepOriginOf(shot)],
      );
      requestKeep(entries, () => applyShotMark(shotId, true), [unit]);
    },
    [
      unacceptableShotIds,
      shotFeedbackAddress,
      state.shots,
      dropKeepUnits,
      applyShotMark,
      keepContextFor,
      decisions,
      keepChoices,
      keepOriginOf,
      requestKeep,
    ],
  );

  const toggleShotDecision = useCallback(
    (shotId: string) => markShot(shotId, !shotAccepted[shotId]),
    [markShot, shotAccepted],
  );

  // The beds' form of the shot's "Changed": the accept flipped back on its own, so say why.
  const timelineStemChanged =
    !!state.timelineStem && state.timelineStem.variantId !== null && state.timelineStem.needsReview;

  const markTimelineStem = useCallback(
    (accepted: boolean) => {
      setTimelineStemDecision(
        accepted === baseTimelineStemAccepted ? undefined : accepted ? "accepted" : "none",
      );
    },
    [baseTimelineStemAccepted],
  );

  const toggleTimelineStem = useCallback(
    () => markTimelineStem(!timelineStemAccepted),
    [markTimelineStem, timelineStemAccepted],
  );

  // Whether an audio asset still needs attention, for the "Needs review" filter. Each of its cues
  // is signed off by the shot that placed it (a shot accept covers that shot's stem); a bed is
  // signed off by the timeline stem.
  const audioAccepted = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const a of state.audioAssets) {
      map[a.address] =
        a.kind === "soundtrack"
          ? timelineStemAccepted
          : a.cues.every((c) => (c.shotId ? shotAccepted[c.shotId] : timelineStemAccepted));
    }
    return map;
  }, [state.audioAssets, shotAccepted, timelineStemAccepted]);

  const acceptUnits = useMemo(
    () => reelAcceptUnits(state.shots, !!state.timelineStem),
    [state.shots, state.timelineStem],
  );

  // Accept one unit. Toggling back to the baseline drops the mark rather than recording a no-op
  // decision, so Submit can tell "nothing to save" from "saved a change that happens to match".
  const acceptUnit = useCallback(
    (unit: ReelUnit, m: ReelMarks): ReelMarks => {
      if (unit.kind === "stem")
        return { ...m, stem: baseTimelineStemAccepted ? undefined : "accepted" };
      const shots = { ...m.shots };
      if (baseShotAccepted[unit.shotId]) delete shots[unit.shotId];
      else shots[unit.shotId] = "accepted";
      return { ...m, shots };
    },
    [baseShotAccepted, baseTimelineStemAccepted],
  );

  // What the whole review still has to sign off, and whether "Accept all" would move anything.
  // See bulk-accept.ts.
  const {
    pending: pendingUnits,
    done: everythingAccepted,
    apply: acceptAllMarks,
  } = useMemo(
    () => bulkAcceptState(acceptUnits, marks, acceptUnit, unitAccepted),
    [acceptUnits, marks, acceptUnit, unitAccepted],
  );

  // Nothing persists until Submit, so bulk-marking needs no confirm dialog — every mark stays
  // individually reversible before the review is saved.
  // Every shot it accepts asks through one prompt.
  const handleAcceptAll = useCallback(() => {
    const next = acceptAllMarks(marks);
    const origins = state.shots
      .filter(
        (s) => unitAccepted({ kind: "shot", shotId: s.shotId }, next) && !shotAccepted[s.shotId],
      )
      .map(keepOriginOf);
    const units = origins.map((o) => o.unit);
    const entries = keepPromptFor(
      keepContextFor((id) => next.shots[id], withoutUnits(keepChoices, units)),
      origins,
    );
    requestKeep(
      entries,
      () => {
        setDecisions(next.shots);
        setTimelineStemDecision(next.stem);
      },
      units,
    );
  }, [
    acceptAllMarks,
    marks,
    unitAccepted,
    state.shots,
    shotAccepted,
    keepOriginOf,
    keepContextFor,
    keepChoices,
    requestKeep,
  ]);

  const regenerateUnits = useMemo(() => regenerateByUnit(keepChoices), [keepChoices]);
  const regenerateByShot = useMemo<Record<string, RegenerateMark>>(
    () =>
      Object.fromEntries(
        state.shots.flatMap((s) => {
          const mark = regenerateUnits.get(shotFeedbackAddress(s.shotId));
          if (!mark) return [];
          const row = mark.follows === null ? null : shotOfUnit.get(mark.follows);
          return [
            [
              s.shotId,
              {
                origin: unitLabel(keepGraph, mark.origin, reelStage),
                follows: row
                  ? { id: row, label: unitLabel(keepGraph, mark.follows!, reelStage) }
                  : null,
                takes: takeNames(shotFeedbackAddress(s.shotId), mark.takes),
              },
            ],
          ];
        }),
      ),
    [state.shots, regenerateUnits, shotFeedbackAddress, shotOfUnit, keepGraph, reelStage],
  );
  const keepShotAfterAll = useCallback(
    (shotId: string) => keepUnitAfterAll(shotFeedbackAddress(shotId)),
    [keepUnitAfterAll, shotFeedbackAddress],
  );

  // Shots still needing acceptance — every shot not currently accepted, whether that's an
  // undecided one, a fresh reroll, or one the reviewer just un-accepted this session.
  //
  // Narrowed to shots because the "Next" button it drives is the shot list's own header control
  // (`noun="shot"`): the beds sit in another panel and are reached by picking the Soundtrack card,
  // so counting them here would send the reviewer looking for a shot that is not there. The beds
  // are still a unit of `pendingUnits` above, which is what "Accept all" and its label read.
  const unreviewedShotIds = useMemo(
    () => pendingUnits.flatMap((u) => (u.kind === "shot" ? [u.shotId] : [])),
    [pendingUnits],
  );

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
      const stem = state.timelineStem;
      if (soundtrackFocused && stem) {
        session.addPending(stem.address, text, { annotation: null, time });
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
    [state.shots, state.timelineStem, soundtrackFocused, session, shotFeedbackAddress, noteDraft],
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
      for (const f of saved) {
        if (session.deletedFeedbackIds.has(f.id)) continue;
        if (session.hideStale && f.stale) continue;
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
    return out;
  }, [
    state.shots,
    state.timelineStem,
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
      soundtrackFocused
        ? displayComments.filter((c) => c.address === state.timelineStem?.address)
        : displayComments.filter((c) => c.shotId === focusedShot?.shotId),
    [displayComments, soundtrackFocused, state.timelineStem, focusedShot],
  );

  const noteCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of displayComments) {
      if (c.shotId) counts[c.shotId] = (counts[c.shotId] ?? 0) + 1;
    }
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
      [...state.shots.flatMap((s) => s.feedback), ...(state.timelineStem?.feedback ?? [])],
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
    return out;
  }, [
    state.shots,
    state.timelineStem,
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
    async ({ addedFeedback, feedbackPatches, overallComment }: SubmitInput) => {
      // Where the comment was written, and nothing about what it was written against: the handler
      // derives the subject from the definition and the whole-view snapshots below. The page cannot
      // narrow a subject it does not send.
      const added = addedFeedback.map((pf) => ({
        address: pf.address,
        text: pf.text,
        annotation: pf.annotation,
        time: pf.time,
      }));
      const notes = addedFeedback.map((pf) => ({
        time: pf.time ?? 0,
        shotId: pf.shotId,
        address: pf.address,
        text: pf.text,
        ...(pf.annotation ? { x: pf.annotation.x, y: pf.annotation.y } : {}),
      }));
      // Snapshot the variant shown for every reviewable asset (preview override
      // wins over the resolved/accepted variant), so submit accepts exactly what
      // the reviewer saw — never a variant a reroll produced mid-review.
      //
      // Seeded with what the compositions were rendered from, since a composite draws addresses the
      // arrays below do not carry (a board panel, a reference sheet). The loops then overwrite every
      // address this page can switch a take on, so a gallery pick still wins.
      const displayedVariants: Record<string, string> = { ...state.compositionRefVariants };
      // Every take the gallery offered beside it. An accept dismisses the ones it did not choose,
      // and only the page knows which were on screen — a reroll that landed mid-review is in state
      // but was never a candidate this reviewer passed over.
      const displayedCandidates: Record<string, string[]> = {};
      for (const shot of state.shots) {
        for (const a of shot.assets) {
          const vid = effectiveVariants[a.address] ?? a.variantId;
          if (vid) displayedVariants[a.address] = vid;
          displayedCandidates[a.address] = a.variants.map((v) => v.variantId);
        }
      }
      for (const a of state.audioAssets) {
        const vid = effectiveVariants[a.address] ?? a.variantId;
        if (vid) displayedVariants[a.address] = vid;
        displayedCandidates[a.address] = a.variants.map((v) => v.variantId);
      }
      // The materialized leaves the page was served: their live definition, which no take carries,
      // and — for a composition — the accepted variant it was showing. A stem's own take is left
      // out: the preview renders it live, so the accepted variant is not what played.
      const displayedDefinitionHashes: Record<string, string> = {};
      for (const shot of state.shots) {
        if (shot.compositionAddress) {
          if (shot.compositionVariantId) {
            displayedVariants[shot.compositionAddress] = shot.compositionVariantId;
          }
          if (shot.compositionDefinitionHash) {
            displayedDefinitionHashes[shot.compositionAddress] = shot.compositionDefinitionHash;
          }
        }
        for (const stem of shot.stems) {
          if (stem.definitionHash) displayedDefinitionHashes[stem.address] = stem.definitionHash;
        }
      }
      if (state.timelineStem?.definitionHash) {
        displayedDefinitionHashes[state.timelineStem.address] = state.timelineStem.definitionHash;
      }
      // Which shots stood in, snapshotted like `displayedVariants`: a build dependency finishing
      // mid-review flips it, and submit drops any verdict on one — accepting it would sign off a
      // composition nobody has seen.
      const displayedStandInShotIds = state.shots
        .filter((s) => s.showingStandIn)
        .map((s) => s.shotId);
      await submitReview(decisions, notes.length > 0 ? notes : undefined, reelStage, {
        ...(timelineStemDecision ? { timelineStemDecision } : {}),
        addedFeedback: added,
        feedbackPatches,
        displayedVariants,
        displayedDefinitionHashes,
        displayedCandidates,
        displayedStandInShotIds,
        ...(overallComment ? { overallComment } : {}),
        ...(keepChoices.length > 0
          ? { keep: keepDecisions(keepChoices), regenerate: regenerateDecisions(keepChoices) }
          : {}),
      });
    },
    [
      keepChoices,
      decisions,
      timelineStemDecision,
      effectiveVariants,
      reelStage,
      state.shots,
      state.audioAssets,
      state.timelineStem,
      state.compositionRefVariants,
    ],
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
    else if (focusedShot) toggleShotDecision(focusedShot.shotId);
  }, [soundtrackFocused, toggleTimelineStem, focusedShot, toggleShotDecision]);

  useReviewShortcuts({
    blocked:
      session.gallery !== null || infoTake !== null || session.submitOpen || keepAsking !== null,
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

  // "Needs review" narrows to what still needs attention: acceptable shots not yet accepted
  // (shotAccepted already folds in a stale composition/stem and an undecided newer take), and
  // audio not yet accepted. A pending shot can never be accepted, so it would never leave the
  // filter — it is not what still needs the reviewer's attention.
  const visibleShots = useMemo(
    () =>
      session.showChangedOnly
        ? acceptableShots.filter((s) => !shotAccepted[s.shotId])
        : state.shots,
    [session.showChangedOnly, acceptableShots, state.shots, shotAccepted],
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
                    : !!focusedShot && !!shotAccepted[focusedShot.shotId],
                  what: soundtrackFocused ? "soundtrack" : `shot ${focusedShot?.shotId ?? ""}`,
                  disabled: soundtrackFocused
                    ? !state.timelineStem
                    : !(focusedShot && shotAcceptable(focusedShot)),
                  onClick: acceptFocused,
                }
              : undefined
          }
          acceptAll={{
            done: everythingAccepted,
            what: "every shot and all audio",
            onClick: handleAcceptAll,
          }}
          reset={{
            disabled: !session.hasPendingChanges,
            onClick: () => {
              setDecisions({});
              setTimelineStemDecision(undefined);
              resetKeep();
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
                onReady={() => playerRef.current?.setPlaybackRate(playbackRateRef.current)}
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
          <div className="vp-col vp-col-notes">
            <CommentsPanel
              subject={
                soundtrackFocused ? "Soundtrack" : focusedShot && `Shot ${focusedShot.shotId}`
              }
              pinnable={!soundtrackFocused}
              script={soundtrackFocused ? undefined : focusedShot?.script}
              moves={soundtrackFocused ? undefined : focusedShot?.moves}
              handoffNotes={soundtrackFocused ? undefined : focusedShot?.handoffNotes}
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
            {state.timelineStem && !(session.showChangedOnly && timelineStemAccepted) && (
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
            <ShotList
              shots={visibleShots}
              progress={{
                accepted: acceptableShots.length - unreviewedShotIds.length,
                total: acceptableShots.length,
              }}
              shotAccepted={shotAccepted}
              decisions={decisions}
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
            return (
              <VariantGallery
                label={asset.assetName}
                kind={asset.mediaKind}
                variants={asset.variants}
                selectedVariantId={effectiveVariants[session.gallery.address] ?? asset.variantId}
                onUse={(variantId) => session.useVariant(session.gallery!.address, variantId)}
                onOpenInfo={(variantId) => setInfoTake({ address: asset.address, variantId })}
                infoOpen={infoTake !== null}
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

        {infoTake &&
          (() => {
            const asset = assetByAddress.get(infoTake.address);
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
