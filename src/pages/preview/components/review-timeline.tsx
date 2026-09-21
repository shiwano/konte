import type React from "react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { formatTimecode } from "../format-time.js";
import { shotChangedSinceAccept } from "../review/changed-since-accept.js";
import type { Playhead } from "../review/playhead.js";
import { useScrubPreview } from "../review/use-scrub-preview.js";
import {
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  ZOOM_STEP,
  tickInterval,
  tickLabel,
  useTimelineZoom,
} from "../review/use-timeline-zoom.js";
import type { AudioTrackAssetInfo, ShotInfo, VariantInfo, TimelineNote } from "../types.js";
import { FilmIcon, FitIcon, GridIcon, ImageIcon, InfoIcon, VolumeIcon } from "./icons.js";
import { PlayheadLine, ScrubPreview } from "./scrub-preview.js";
import { StatusBadge } from "./status-badge.js";
import { VariantSummaryLabel } from "./variant-summary-button.js";

const LABEL_W = 84;
// Height of one sub-row on the clip tracks — matched to the shot track so every clip reads as
// the same weight. A track grows by this much per stacked clip rather than dividing a fixed
// height, so a clip never shrinks below its label.
const SUBROW_H = 30;

// Pack cues into sub-rows so overlapping ones stack vertically instead of covering each
// other. Greedy earliest-start: a cue joins the first sub-row whose last cue has already ended,
// so a track is only as deep as the audio actually overlaps.
function packIntoSubRows<T extends { cue: { start: number; end: number } }>(
  items: T[],
): { placed: Array<T & { subRow: number }>; subRowCount: number } {
  const ends: number[] = [];
  const placed = [...items]
    .sort((a, b) => a.cue.start - b.cue.start)
    .map((item) => {
      let subRow = ends.findIndex((end) => end <= item.cue.start + 1e-6);
      if (subRow === -1) subRow = ends.push(0) - 1;
      ends[subRow] = item.cue.end;
      return { ...item, subRow };
    });
  return { placed, subRowCount: Math.max(ends.length, 1) };
}

// A clip's asset-info trigger: opens the read-only panel of what the asset's declaration feeds a
// model.
function InfoButton({ assetName, onOpen }: { assetName: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="rt-clip-open rt-clip-info"
      title={`${assetName}: prompt and inputs`}
      aria-label={`${assetName}: prompt and inputs`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <InfoIcon size={11} />
    </button>
  );
}

// A clip's variant trigger: the same accepted/stale annotation the animatic shows
// under a panel, compacted to icon + count, opening the gallery on click. Null when the
// asset has no variants (nothing to open).
function VariantsButton({
  assetName,
  variants,
  hasNewerVariant,
  onOpen,
}: {
  assetName: string;
  variants: VariantInfo[];
  hasNewerVariant: boolean;
  onOpen: () => void;
}): React.ReactElement | null {
  if (variants.length === 0) return null;
  return (
    <button
      type="button"
      className="rt-clip-open"
      title={`${assetName}: open variants`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <VariantSummaryLabel variants={variants} hasNewerVariant={hasNewerVariant} compact />
    </button>
  );
}

// A clip track (Video or Image) — a labelled row whose height follows the deepest stack of
// clips in it. A track with nothing on it (an animatic draws no motion) is dropped rather than
// left as an empty lane, the same way an audio lane with no cues is.
function VisualTrack({
  rowClass,
  icon,
  label,
  width,
  clips,
  subRowCount,
}: {
  rowClass: string;
  icon: React.ReactElement;
  label: string;
  width: number;
  clips: React.ReactElement[];
  subRowCount: number;
}): React.ReactElement | null {
  if (clips.length === 0) return null;
  return (
    <div className={`rt-row ${rowClass}`}>
      <div className="rt-label">
        {icon} <span className="rt-label-text">{label}</span>
      </div>
      <div className="rt-track" style={{ width, height: subRowCount * SUBROW_H }}>
        {clips}
      </div>
    </div>
  );
}

// Zoom is driven from the timeline's own floating controls and from the review's keyboard
// shortcuts, which live a component up.
export interface ReviewTimelineRef {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export interface ReviewTimelineProps {
  timelineRef?: React.Ref<ReviewTimelineRef>;
  shots: ShotInfo[];
  audioAssets: AudioTrackAssetInfo[];
  totalDuration: number;
  playhead: Playhead;
  isPlaying: boolean;
  shotAccepted: Record<string, boolean>;
  focusedShotId?: string;
  // Whether the review's feedback panel is pointed at the soundtrack rather than a shot — a bed
  // clip belongs to no shot, so it takes its focus ring from this instead of `focusedShotId`.
  soundtrackFocused?: boolean;
  // A request to frame a span of the timeline: zoom it to fill the track and scroll it into
  // view. A shot's span, or the soundtrack beds' — the timeline only needs the range. `seq`
  // makes a repeat request on the same span a fresh one (clicking the same card twice).
  focusRequest?: { start: number; duration: number; seq: number };
  shotFrames: Record<string, { first: string | null; last: string | null }>;
  notes?: TimelineNote[];
  onSeek: (time: number) => void;
  onFocusSoundtrack?: () => void;
  onOpenGallery: (address: string) => void;
  // Opens the info panel on the take the reel shows at an address; undefined when that take has no
  // recorded declaration.
  infoOpener: (address: string) => (() => void) | undefined;
  onSeekToNote?: (note: TimelineNote) => void;
}

export function ReviewTimeline({
  timelineRef,
  shots,
  audioAssets,
  totalDuration,
  playhead,
  isPlaying,
  shotAccepted,
  focusedShotId,
  soundtrackFocused,
  focusRequest,
  shotFrames,
  notes,
  onSeek,
  onFocusSoundtrack,
  onOpenGallery,
  infoOpener,
  onSeekToNote,
}: ReviewTimelineProps): React.ReactElement {
  const rulerRef = useRef<HTMLDivElement>(null);

  const timeFromClientX = useCallback(
    (clientX: number): number | null => {
      const rect = rulerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      return ratio * totalDuration;
    },
    [totalDuration],
  );

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const t = timeFromClientX(clientX);
      if (t !== null) onSeek(t);
    },
    [timeFromClientX, onSeek],
  );

  // Pointer on the track lanes does double duty: a plain click seeks the playhead to that
  // position, while a drag pans the timeline. Interactive controls (the variant and info
  // buttons, labels) and the ruler (its own scrub handler) opt out. Variants open only from the
  // variant button — never from clicking a clip body.
  const {
    scrollRef,
    pxPerSec,
    setPxPerSec,
    effectivePxPerSec,
    timelineWidth,
    zoomBy,
    resetZoom,
    panHandlers,
  } = useTimelineZoom({
    totalDuration,
    labelWidth: LABEL_W,
    noPanSelector: ".rt-clip-open, .rt-label, .rt-ruler",
    onTap: (e) => seekFromClientX(e.clientX),
  });

  useImperativeHandle(
    timelineRef,
    () => ({
      zoomIn: () => zoomBy(ZOOM_STEP),
      zoomOut: () => zoomBy(1 / ZOOM_STEP),
      resetZoom,
    }),
    [zoomBy, resetZoom],
  );

  // Frame what the reviewer picked — a shot from the shot list, or the soundtrack: zoom so the
  // span fills most of the track, then scroll it to the left edge with a margin. Keyed on `seq`
  // (not the span) so re-picking the same one re-frames it after the reviewer has panned away.
  const lastFocusSeq = useRef(-1);
  // Scroll target parked until the zoom has widened the content. Assigning scrollLeft in the
  // same tick would clamp it against the old (narrower) content width.
  const pendingScrollLeft = useRef<number | null>(null);
  useEffect(() => {
    if (!focusRequest || focusRequest.seq === lastFocusSeq.current) return;
    lastFocusSeq.current = focusRequest.seq;
    const el = scrollRef.current;
    if (!el || focusRequest.duration <= 0) return;
    const track = Math.max(el.clientWidth - LABEL_W, 120);
    const margin = track * 0.06;
    const next = Math.min(
      Math.max((track - margin * 2) / focusRequest.duration, MIN_PX_PER_SEC),
      MAX_PX_PER_SEC,
    );
    const target = Math.max(focusRequest.start * next - margin, 0);
    if (next === pxPerSec) {
      // Same zoom (two spans of equal length): setPxPerSec would bail out, no re-render
      // would follow, and a parked target would sit unapplied until the next one. The content
      // width is unchanged, so scroll straight away.
      el.scrollLeft = target;
      return;
    }
    pendingScrollLeft.current = target;
    setPxPerSec(next);
  }, [focusRequest, pxPerSec, scrollRef, setPxPerSec]);

  useLayoutEffect(() => {
    if (pendingScrollLeft.current === null || !scrollRef.current) return;
    scrollRef.current.scrollLeft = pendingScrollLeft.current;
    pendingScrollLeft.current = null;
  });

  // Follow the playhead during playback: nudge the scroll so it stays in view. Driven off the
  // store's subscription rather than a render — scrolling is a DOM side effect, and re-rendering
  // the whole timeline 30×/s to compute it is exactly what the store exists to avoid.
  useEffect(() => {
    if (!isPlaying) return;
    const follow = () => {
      const el = scrollRef.current;
      if (!el) return;
      const time = playhead.get();
      const x = time * effectivePxPerSec + LABEL_W;
      const left = el.scrollLeft + LABEL_W;
      const right = el.scrollLeft + el.clientWidth;
      if (x < left || x > right - 24) el.scrollLeft = time * effectivePxPerSec - 40;
    };
    follow();
    return playhead.subscribe(follow);
  }, [playhead, isPlaying, effectivePxPerSec, scrollRef]);

  const scrubTimeAt = useCallback(
    (clientX: number) => {
      // Only ignore scrubbing over the sticky label gutter when the timeline is scrolled — the
      // gutter then covers real content. When it isn't scrolled, dragging to (or past) the left
      // edge should still clamp to 0, so the guard must not block reaching the start.
      const el = scrollRef.current;
      const scrollRect = el?.getBoundingClientRect();
      if (el && el.scrollLeft > 0 && scrollRect && clientX < scrollRect.left + LABEL_W) return null;
      const time = timeFromClientX(clientX);
      if (time === null) return null;
      return { time, barTop: rulerRef.current?.getBoundingClientRect().top ?? 0 };
    },
    [timeFromClientX, scrollRef],
  );
  const { scrub, handlers: scrubHandlers } = useScrubPreview(scrubTimeAt, onSeek);

  const ticks = useMemo(() => {
    if (totalDuration <= 0) return { step: 1, times: [] as number[] };
    const step = tickInterval(effectivePxPerSec);
    const times: number[] = [];
    for (let t = 0; t <= totalDuration + 0.001; t += step) times.push(t);
    return { step, times };
  }, [totalDuration, effectivePxPerSec]);

  // Two lanes under one "Audio" track: every per-shot cue in the first, timeline beds
  // (soundtracks, coloured differently) in the second below it. Cues are keyed to the clock, not
  // to the asset — a shot naming each of its lines separately would otherwise take a lane per
  // line — so a lane only stacks where two cues actually sound at once.
  const audioLanes = useMemo(() => {
    const cues = audioAssets.flatMap((asset) =>
      asset.cues.map((cue, cueIdx) => ({ asset, cue, cueIdx })),
    );
    return (["sound", "soundtrack"] as const)
      .map((kind) => ({ kind, cues: cues.filter((c) => c.asset.kind === kind) }))
      .filter((lane) => lane.cues.length > 0);
  }, [audioAssets]);

  // One lane's cues as positioned clips, stacked into sub-rows where they overlap in time.
  // Returns the sub-row count too, so the track can grow to fit them.
  const renderAudioLane = (
    laneCues: Array<{
      asset: AudioTrackAssetInfo;
      cue: AudioTrackAssetInfo["cues"][number];
      cueIdx: number;
    }>,
  ): { clips: React.ReactElement[]; subRowCount: number } => {
    const { placed, subRowCount } = packIntoSubRows(laneCues);
    const clips = placed.map(({ asset, cue, cueIdx, subRow }) => {
      const isBed = cue.shotId === undefined;
      const focused = isBed ? !!soundtrackFocused : cue.shotId === focusedShotId;
      const notReady = !asset.variantId;
      const openInfo = infoOpener(asset.address);
      const w = Math.max((cue.end - cue.start) * effectivePxPerSec, 8);
      return (
        <div
          key={`${asset.address}-${cueIdx}`}
          className={`rt-audio-clip${focused ? " rt-audio-clip--focused" : ""}${
            asset.kind === "soundtrack" ? " rt-audio-clip--soundtrack" : ""
          }${notReady ? " rt-audio-clip--not-ready" : ""}`}
          style={{
            left: cue.start * effectivePxPerSec,
            width: w,
            top: subRow * SUBROW_H + 2,
            height: SUBROW_H - 4,
          }}
          // Picking a bed points the feedback panel at the soundtrack — the clip is the other
          // place (beside the Soundtrack card) a reviewer would reach for to say something
          // about the beds. A cue answers to its shot, which the shot list already selects.
          {...(isBed && onFocusSoundtrack ? { onClick: onFocusSoundtrack } : {})}
          title={
            notReady
              ? `${asset.assetName}: not generated yet`
              : `${asset.assetName} · ${formatTimecode(cue.start)}–${formatTimecode(cue.end)}`
          }
        >
          <span className="rt-clip-name">{asset.assetName}</span>
          <VariantsButton
            assetName={asset.assetName}
            variants={asset.variants}
            hasNewerVariant={asset.hasNewerVariant}
            onOpen={() => onOpenGallery(asset.address)}
          />
          {openInfo && <InfoButton assetName={asset.assetName} onOpen={openInfo} />}
          {notReady && cueIdx === 0 && <StatusBadge status="not-ready" label="Not ready" />}
        </div>
      );
    });
    return { clips, subRowCount };
  };

  // Visual clips (video or image) as positioned bars, packed per shot into sub-rows the same way
  // the audio track packs cues: only layers covering the same span stack, so a shot's sequential
  // keyframe windows (a panel's `first` then `last`) sit side by side at full height. Returns the
  // deepest sub-row count so the track grows to fit.
  const renderVisualClips = (
    kind: "video" | "image",
  ): { clips: React.ReactElement[]; subRowCount: number } => {
    let maxSubRows = 1;
    const clips = shots.flatMap((shot) => {
      const { placed, subRowCount } = packIntoSubRows(
        shot.clips
          .filter((c) => c.mediaType === kind)
          .map((clip, i) => ({ clip, i, cue: { start: clip.start, end: clip.end } })),
      );
      maxSubRows = Math.max(maxSubRows, subRowCount);
      // Visual content is accepted with its shot, on the Shot track — here it only mirrors the
      // shot's focus.
      const focused = focusedShotId === shot.shotId;
      return placed.map(({ clip, i, subRow }) => {
        const addr = clip.address;
        const asset = addr ? shot.assets.find((a) => a.address === addr) : undefined;
        const notReady = clip.notReady;
        const openInfo = addr ? infoOpener(addr) : undefined;
        const start = shot.startTime + clip.start;
        const w = Math.max((clip.end - clip.start) * effectivePxPerSec, 8);
        return (
          <div
            key={`${shot.shotId}-${addr ?? kind}-${i}`}
            className={`rt-video-clip${focused ? " rt-video-clip--focused" : ""}${
              notReady ? " rt-video-clip--not-ready" : ""
            }`}
            style={{
              left: start * effectivePxPerSec,
              width: w,
              // 2px inset matches the shot/audio clips so every track reads with the same rhythm.
              top: subRow * SUBROW_H + 2,
              height: SUBROW_H - 4,
            }}
            title={
              notReady ? `${clip.assetName ?? kind}: not generated yet` : (clip.assetName ?? kind)
            }
          >
            <span className="rt-clip-name">{clip.assetName ?? kind}</span>
            {addr && asset && (
              <VariantsButton
                assetName={asset.assetName}
                variants={asset.variants}
                hasNewerVariant={asset.hasNewerVariant}
                onOpen={() => onOpenGallery(addr)}
              />
            )}
            {openInfo && asset && <InfoButton assetName={asset.assetName} onOpen={openInfo} />}
            {notReady && <StatusBadge status="not-ready" label="Not ready" />}
          </div>
        );
      });
    });
    return { clips, subRowCount: maxSubRows };
  };

  return (
    <div className="review-timeline">
      <div className="rt-scroll" ref={scrollRef} {...panHandlers}>
        <div className="rt-content" style={{ width: LABEL_W + timelineWidth }}>
          {/* Ruler — click / drag to seek. */}
          <div className="rt-row rt-row--ruler">
            <div className="rt-label rt-label--ruler" />
            <div
              className="rt-ruler"
              ref={rulerRef}
              style={{ width: timelineWidth }}
              {...scrubHandlers}
            >
              {ticks.times.map((t) => (
                <div key={t} className="rt-tick" style={{ left: t * effectivePxPerSec }}>
                  <span className="rt-tick-label">{tickLabel(t, ticks.step)}</span>
                </div>
              ))}
              {notes?.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={`rt-note-marker${n.stale ? " rt-note-marker--stale" : ""}`}
                  style={{ left: Math.min(n.time, totalDuration) * effectivePxPerSec }}
                  title={n.text}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    (onSeekToNote ?? (() => onSeek(n.time)))(n);
                  }}
                />
              ))}
            </div>
          </div>

          {/* Shot track — the review unit: shot id, duration and status, kept separate from the
              video content below. Click seeks; an accepted shot reads as a green fill. */}
          <div className="rt-row rt-row--shot">
            <div className="rt-label">
              <GridIcon size={13} /> <span className="rt-label-text">Shot</span>
            </div>
            <div className="rt-track" style={{ width: timelineWidth }}>
              {shots.map((shot, i) => {
                const accepted = shotAccepted[shot.shotId] ?? false;
                const continues = i > 0 && shot.join === "continuous";
                const continued = shots[i + 1]?.join === "continuous";
                const focused = focusedShotId === shot.shotId;
                const changed = shotChangedSinceAccept(shot);
                return (
                  <div
                    key={shot.shotId}
                    className={`rt-shot${accepted ? " rt-shot--accepted" : ""}${
                      focused ? " rt-shot--focused" : ""
                    }${shot.pending ? " rt-shot--pending" : ""}${
                      continues ? " rt-shot--continues" : ""
                    }${continued ? " rt-shot--continued" : ""}`}
                    style={{
                      left: shot.startTime * effectivePxPerSec,
                      width: shot.duration * effectivePxPerSec,
                    }}
                    title={`Shot ${shot.shotId}: ${shot.duration}s`}
                  >
                    <div className="rt-shot-head">
                      <span className="rt-shot-id">{shot.shotId}</span>
                      <span className="rt-shot-duration">{shot.duration}s</span>
                      {shot.pending && <StatusBadge status="pending" label="Pending" />}
                      {shot.notReady && !shot.showingStandIn && (
                        <StatusBadge status="not-ready" label="Not ready" />
                      )}
                      {changed && <StatusBadge status="changed" label="Changed" />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Video track — motion clips in absolute time. */}
          <VisualTrack
            rowClass="rt-row--video"
            icon={<FilmIcon size={13} />}
            label="Video"
            width={timelineWidth}
            {...renderVisualClips("video")}
          />

          {/* Image track — still layers, grouped below Video. */}
          <VisualTrack
            rowClass="rt-row--image"
            icon={<ImageIcon size={13} />}
            label="Image"
            width={timelineWidth}
            {...renderVisualClips("image")}
          />

          {/* Audio track — per-shot cues then timeline beds, all under one "Audio" label. */}
          {audioLanes.map((lane, laneIdx) => {
            const { clips, subRowCount } = renderAudioLane(lane.cues);
            return (
              <div className="rt-row rt-row--audio" key={lane.kind}>
                <div className="rt-label">
                  {laneIdx === 0 && (
                    <>
                      <VolumeIcon size={13} /> <span className="rt-label-text">Audio</span>
                    </>
                  )}
                </div>
                <div
                  className="rt-track"
                  style={{ width: timelineWidth, height: subRowCount * SUBROW_H }}
                >
                  {clips}
                </div>
              </div>
            );
          })}

          <PlayheadLine
            playhead={playhead}
            leftAt={(time) => LABEL_W + Math.min(time, totalDuration) * effectivePxPerSec}
          />
        </div>
      </div>

      {/* Zoom floats over the bottom-right of the tracks — the timeline has no header bar. */}
      <div className="rt-zoom">
        <button
          type="button"
          className="ctrl-btn"
          title="Zoom out"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          −
        </button>
        <button
          type="button"
          className="ctrl-btn ctrl-btn--icon"
          title="Fit to width"
          aria-label="Fit to width"
          onClick={resetZoom}
        >
          <FitIcon size={13} />
        </button>
        <button
          type="button"
          className="ctrl-btn"
          title="Zoom in"
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          +
        </button>
      </div>

      <ScrubPreview scrub={scrub} shots={shots} shotFrames={shotFrames} />
    </div>
  );
}
