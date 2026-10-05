import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatPlayerTime } from "../format-time.js";
import { Playhead, usePlayheadTime } from "../review/playhead.js";
import { useReviewShortcuts } from "../review/use-review-shortcuts.js";
import { useScrubPreview } from "../review/use-scrub-preview.js";
import {
  ZOOM_STEP,
  tickInterval,
  tickLabel,
  useTimelineZoom,
} from "../review/use-timeline-zoom.js";
import { formatSongTempo, songBeatAt, songGridBeats, songTempo } from "../../../core/song-grid.js";
import type { SongLineEdit, SongReadingInfo } from "../types.js";
import { FitIcon, PauseIcon, PlayIcon, SkipToStartIcon, VolumeIcon } from "./icons.js";
import { PlayheadLine } from "./scrub-preview.js";

// The lines the reviewer has placed on the song's takes this session, sent with the review. Absent
// where the page has no review to send them with, and the track is then read-only.
export const SongLineEditsContext = createContext<{
  edits: readonly SongLineEdit[];
  place: (edit: SongLineEdit) => void;
  discard: (variantId: string, key: string) => void;
  // Every line this review placed or let go on one take, undone together.
  reset: (variantId: string) => void;
} | null>(null);

type Span = { startSec: number; endSec: number };
type TrackLine = SongReadingInfo["lines"][number] & { pending: boolean };

// The reading as this review would leave it: a line placed here where it was placed, one sent back
// to the reading unplaced until the review is sent and the take read again.
function linesUnderEdits(
  song: SongReadingInfo,
  edits: readonly SongLineEdit[] | undefined,
): TrackLine[] {
  return song.lines.map((line) => {
    const edit = edits?.find((e) => e.variantId === song.variantId && e.key === line.key);
    if (!edit) return { ...line, pending: false };
    return edit.span
      ? { ...line, ...edit.span, set: true, pending: true }
      : { ...line, startSec: null, endSec: null, set: false, pending: true };
  });
}

// How many of a take's lines stand placed nowhere, as this review would leave them.
export function unplacedLineCount(
  song: SongReadingInfo,
  edits: readonly SongLineEdit[] | undefined,
): number {
  return linesUnderEdits(song, edits).filter((l) => l.startSec === null).length;
}

// A take of the song on a card: how its lines stand, and the way into the track — the only place
// it plays.
export function SongSummary({
  song,
  onOpen,
}: {
  song: SongReadingInfo;
  onOpen: () => void;
}): React.ReactElement {
  const editing = useContext(SongLineEditsContext);
  const lines = linesUnderEdits(song, editing?.edits);
  const unplaced = lines.filter((l) => l.startSec === null).length;
  const changed = lines.filter((l) => l.pending).length;
  return (
    <div className="song-summary">
      <span className="reference-card-audio-glyph">
        <VolumeIcon size={32} />
      </span>
      <span className="song-summary-count">
        {lines.length - unplaced} of {lines.length} lines placed
        {unplaced > 0 && <span className="song-summary-unplaced"> · {unplaced} unplaced</span>}
        {changed > 0 && <span className="song-summary-changed"> · {changed} changed</span>}
      </span>
      <button
        type="button"
        className="ctrl-btn"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        Open the song
      </button>
    </div>
  );
}

// The label gutter and lane heights of the review timeline.
const LABEL_W = 84;
const LANE_PX = 44;
const EDGE_PX = 8;
const SNAP_PX = 8;
const MIN_LINE_SEC = 0.2;
const STEP_SEC = 0.1;

type Drag = {
  key: string;
  mode: "move" | "start" | "end" | "new";
  // Where the pointer took hold, in take-seconds, and the span it took hold of.
  grabSec: number;
  from: Span;
  span: Span;
  // A line dragged in from the tray lands only where it is let go over the lyrics track.
  over: boolean;
};

// A take of the song under the beats and the lines konte read off it, on the review timeline's own
// controls: the bars and beats, where the vocal track sings, and each lyric line as a clip on the
// take's clock. Accepting the take accepts this reading.
export function SongTrack({
  fileUrl,
  song,
}: {
  fileUrl: string;
  song: SongReadingInfo;
}): React.ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  const playhead = useMemo(() => new Playhead(), []);
  const now = usePlayheadTime(playhead);
  const [isPlaying, setIsPlaying] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const editing = useContext(SongLineEditsContext);
  const lines = linesUnderEdits(song, editing?.edits);

  const durationSec = song.durationSec ?? measured ?? 0;
  const firstBeatSet = song.firstBeatSet;
  const grid = useMemo(
    () => ({
      beats: song.beats,
      firstBeat: song.firstBeat,
      beatsPerBar: song.beatsPerBar,
      ...(firstBeatSet !== null ? { firstBeatSet } : {}),
    }),
    [song, firstBeatSet],
  );
  const gridBeats = useMemo(() => songGridBeats(grid, durationSec), [grid, durationSec]);
  const timeAt = useCallback(
    (clientX: number): number => {
      const rect = rulerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * durationSec;
    },
    [durationSec],
  );
  const seek = useCallback(
    (sec: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = sec;
      playhead.set(sec);
    },
    [playhead],
  );
  const playPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  const {
    scrollRef,
    effectivePxPerSec: pxPerSec,
    timelineWidth,
    zoomBy,
    resetZoom,
    panHandlers,
  } = useTimelineZoom({
    totalDuration: durationSec,
    labelWidth: LABEL_W,
    noPanSelector:
      ".song-track-line-grip, .song-track-edge, .song-track-line-undo, .rt-label, .rt-ruler",
    // A tap on a lyric line plays it from its head; anywhere else seeks there. The pan holds the
    // pointer, so the line is found under it rather than by the event's target.
    onTap: (e) => {
      const line = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>(".song-track-line");
      const start = line?.dataset.start;
      if (start === undefined) {
        seek(timeAt(e.clientX));
        return;
      }
      seek(Number(start));
      void audioRef.current?.play();
    },
  });
  const { handlers: scrubHandlers } = useScrubPreview(
    (clientX) => ({ time: timeAt(clientX), barTop: 0 }),
    seek,
  );
  const x = (sec: number) => sec * pxPerSec;

  useReviewShortcuts({
    blocked: false,
    onSubmit: () => {},
    handlers: {
      " ": playPause,
      ArrowRight: () => seek(Math.min(playhead.get() + STEP_SEC, durationSec)),
      ArrowLeft: () => seek(Math.max(playhead.get() - STEP_SEC, 0)),
      "+": () => zoomBy(ZOOM_STEP),
      "-": () => zoomBy(1 / ZOOM_STEP),
      "=": resetZoom,
    },
  });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let frame = 0;
    const tick = () => {
      playhead.set(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playhead]);

  useEffect(() => {
    if (!isPlaying) return;
    const follow = () => {
      const el = scrollRef.current;
      if (!el) return;
      const at = playhead.get() * pxPerSec + LABEL_W;
      if (at < el.scrollLeft + LABEL_W || at > el.scrollLeft + el.clientWidth - 24) {
        el.scrollLeft = playhead.get() * pxPerSec - 40;
      }
    };
    follow();
    return playhead.subscribe(follow);
  }, [playhead, isPlaying, pxPerSec, scrollRef]);

  // A dragged line keeps its place in the singing order: it opens after every placed line before it
  // and before every placed line after it.
  const bounds = (key: string): { min: number; max: number } => {
    const index = lines.findIndex((l) => l.key === key);
    let min = 0;
    let max = durationSec;
    lines.forEach((l, i) => {
      if (l.key === key || l.startSec === null) return;
      if (i < index) min = Math.max(min, l.startSec + 0.01);
      else max = Math.min(max, l.startSec - 0.01);
    });
    return { min, max };
  };
  const snapEdges = (song.phrases ?? []).flatMap((p) => [p.startSec, p.endSec]);
  const snap = (sec: number): number | null => {
    let best: number | null = null;
    for (const edge of snapEdges) {
      if (Math.abs(edge - sec) * pxPerSec > SNAP_PX) continue;
      if (best === null || Math.abs(edge - sec) < Math.abs(best - sec)) best = edge;
    }
    return best;
  };
  const dragged = (d: Drag, sec: number): Span => {
    const { min, max } = bounds(d.key);
    const delta = sec - d.grabSec;
    if (d.mode === "start") {
      const start = snap(d.from.startSec + delta) ?? d.from.startSec + delta;
      return {
        startSec: Math.min(Math.max(start, min), max, d.from.endSec - MIN_LINE_SEC),
        endSec: d.from.endSec,
      };
    }
    if (d.mode === "end") {
      const end = snap(d.from.endSec + delta) ?? d.from.endSec + delta;
      return {
        startSec: d.from.startSec,
        endSec: Math.max(Math.min(end, durationSec), d.from.startSec + MIN_LINE_SEC),
      };
    }
    const length = d.from.endSec - d.from.startSec;
    let start = d.from.startSec + delta;
    const snappedStart = snap(start);
    const snappedEnd = snap(start + length);
    if (snappedStart !== null) start = snappedStart;
    else if (snappedEnd !== null) start = snappedEnd - length;
    start = Math.max(0, Math.min(Math.max(start, min), max, durationSec - length));
    return { startSec: start, endSec: start + length };
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const rect = linesRef.current?.getBoundingClientRect();
      const over =
        !!rect &&
        e.clientY >= rect.top - 8 &&
        e.clientY <= rect.bottom + 8 &&
        e.clientX >= rect.left &&
        e.clientX <= rect.right;
      setDrag((d) => (d ? { ...d, over, span: dragged(d, timeAt(e.clientX)) } : d));
    };
    const onUp = () => {
      setDrag(null);
      if (!editing) return;
      const moved =
        Math.abs(drag.span.startSec - drag.from.startSec) > 0.005 ||
        Math.abs(drag.span.endSec - drag.from.endSec) > 0.005;
      if (drag.mode === "new" ? !drag.over : !moved) {
        if (drag.mode !== "new") {
          seek(drag.from.startSec);
          void audioRef.current?.play();
        }
        return;
      }
      const round = (sec: number) => Math.round(sec * 100) / 100;
      editing.place({
        variantId: song.variantId,
        key: drag.key,
        span: {
          startSec: round(drag.span.startSec),
          endSec: Math.min(round(drag.span.endSec), durationSec),
        },
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  });

  const playFrom = (sec: number) => {
    seek(sec);
    void audioRef.current?.play();
  };

  const grab = (e: React.PointerEvent, line: TrackLine, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!editing) {
      if (line.startSec !== null) {
        seek(line.startSec);
        void audioRef.current?.play();
      }
      return;
    }
    e.preventDefault();
    const sec = timeAt(e.clientX);
    const from =
      line.startSec !== null && line.endSec !== null
        ? { startSec: line.startSec, endSec: line.endSec }
        : { startSec: sec, endSec: sec + Math.min(3, Math.max(1, durationSec / 8)) };
    setDrag({
      key: line.key,
      mode,
      grabSec: mode === "new" ? from.startSec : sec,
      from,
      span: from,
      over: false,
    });
  };

  const shown = lines.map((line) =>
    drag?.key === line.key && (drag.mode !== "new" || drag.over)
      ? { ...line, startSec: drag.span.startSec, endSec: drag.span.endSec }
      : line,
  );
  // Lines sung over one another (a call and its answer) take a lane of their own.
  const placed = shown
    .filter((l): l is TrackLine & Span => l.startSec !== null && l.endSec !== null)
    .sort((a, b) => a.startSec - b.startSec);
  const laneEnds: number[] = [];
  const laneOf = new Map<string, number>();
  for (const line of placed) {
    let lane = laneEnds.findIndex((end) => end <= line.startSec);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = line.endSec;
    laneOf.set(line.key, lane);
  }
  const lanes = Math.max(1, laneEnds.length);
  const tray = shown.filter(
    (l) => l.startSec === null || (drag?.key === l.key && drag.mode === "new" && !drag.over),
  );
  const sung = placed.findLast((l) => l.startSec <= now && now < l.endSec);

  const per = song.beatsPerBar;
  const beatNow = Math.floor(songBeatAt(grid, now) + 1e-6);
  const position =
    beatNow < 0
      ? "before the first bar"
      : `bar ${Math.floor(beatNow / per) + 1} · beat ${(beatNow % per) + 1}`;
  const beatZeroSec = gridBeats.find((b) => b.beat === 0)?.sec ?? null;

  const bars = gridBeats.filter((b) => b.beat >= 0 && b.beat % per === 0);
  const gaps = gridBeats
    .slice(1)
    .map((b, i) => b.sec - gridBeats[i]!.sec)
    .sort((a, b) => a - b);
  const typicalBeatSec = gaps[Math.floor(gaps.length / 2)] ?? 0.5;
  const beatTicks = pxPerSec * typicalBeatSec >= 10;
  const shownBeats = gridBeats.filter((b) => beatTicks && b.beat % per !== 0);
  const tickStep = tickInterval(pxPerSec);
  const ticks: number[] = [];
  for (let t = 0; durationSec > 0 && t <= durationSec + 0.001; t += tickStep) ticks.push(t);

  return (
    <div className={`song-track${drag ? " song-track--dragging" : ""}`}>
      <audio
        ref={audioRef}
        src={fileUrl}
        preload="auto"
        onLoadedMetadata={(e) => setMeasured(e.currentTarget.duration)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      >
        <track kind="captions" />
      </audio>
      <div className="player-controls">
        <button
          type="button"
          className="ctrl-btn"
          onClick={() => seek(0)}
          title="Back to start"
          aria-label="Back to start"
        >
          <SkipToStartIcon size={14} />
        </button>
        <button
          type="button"
          className="ctrl-btn ctrl-btn--primary"
          onClick={playPause}
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
        </button>
        <span className="song-track-now">
          <span className="song-track-reading">
            {position} · {formatSongTempo(songTempo(grid))} · {per}/bar
            {beatZeroSec !== null && (
              <>
                {" "}
                · bar 1 at {beatZeroSec.toFixed(2)}s{firstBeatSet !== null && " (set by hand)"}
              </>
            )}
          </span>
          <span className="song-track-now-line">
            {sung && (
              <>
                <span className="song-track-now-text">{sung.text}</span>
                <span className="song-track-line-singer">{sung.singer.join(", ")}</span>
              </>
            )}
          </span>
        </span>
        <span className="player-time">
          {formatPlayerTime(now)}{" "}
          <span className="player-time-total">/ {formatPlayerTime(durationSec)}</span>
        </span>
      </div>
      {editing && (
        <div className="song-track-hint-row">
          <p className="song-track-hint">
            Drag each line by its ⠿ grip to where it is sung, and its edges to its first and last
            word. Click a line to hear it.
          </p>
          <button
            type="button"
            className="ctrl-btn"
            disabled={!lines.some((l) => l.pending)}
            title="Undo every change made to this take's lines in this review"
            onClick={() => editing.reset(song.variantId)}
          >
            Reset
          </button>
        </div>
      )}
      <div className="review-timeline">
        <div className="rt-scroll" ref={scrollRef} {...panHandlers}>
          <div className="rt-content" style={{ width: LABEL_W + timelineWidth }}>
            <div className="rt-row rt-row--ruler">
              <div className="rt-label rt-label--ruler" />
              <div
                className="rt-ruler"
                ref={rulerRef}
                style={{ width: timelineWidth }}
                {...scrubHandlers}
              >
                {ticks.map((t) => (
                  <div key={t} className="rt-tick" style={{ left: x(t) }}>
                    <span className="rt-tick-label">{tickLabel(t, tickStep)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rt-row">
              <div className="rt-label">
                <span className="rt-label-text">Bar</span>
              </div>
              <div className="rt-track song-track-bars" style={{ width: timelineWidth }}>
                {bars.map((b) => (
                  <span key={`bar${b.beat}`} className="song-track-bar" style={{ left: x(b.sec) }}>
                    {b.beat / per + 1}
                  </span>
                ))}
                {shownBeats.map((b) => (
                  <span key={b.beat} className="song-track-beat" style={{ left: x(b.sec) }} />
                ))}
              </div>
            </div>
            <div className="rt-row">
              <div className="rt-label">
                <span className="rt-label-text">Vocal</span>
              </div>
              <div className="rt-track song-track-vocal" style={{ width: timelineWidth }}>
                {song.phrases === null ? (
                  <span className="song-track-none">no vocal track could be separated</span>
                ) : (
                  song.phrases.map((p) => (
                    <span
                      key={p.startSec}
                      className="song-track-phrase"
                      style={{ left: x(p.startSec), width: x(p.endSec - p.startSec) }}
                    />
                  ))
                )}
              </div>
            </div>
            <div className="rt-row">
              <div className="rt-label">
                <VolumeIcon size={13} /> <span className="rt-label-text">Lyrics</span>
              </div>
              <div
                className="rt-track song-track-lines"
                ref={linesRef}
                style={{ width: timelineWidth, height: lanes * LANE_PX }}
              >
                {bars.map((b) => (
                  <span key={b.beat} className="song-track-gridline" style={{ left: x(b.sec) }} />
                ))}
                {placed.map((line) => (
                  /* A div: it holds the undo buttons, which a <button> cannot. */
                  /* oxlint-disable jsx-a11y/prefer-tag-over-role */
                  <div
                    key={line.key}
                    className={[
                      "song-track-line",
                      line === sung && "song-track-line--sung",
                      line.pending && "song-track-line--pending",
                      line.set && !line.pending && "song-track-line--set",
                      drag?.key === line.key && "song-track-line--dragged",
                      editing && "song-track-line--movable",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      left: x(line.startSec),
                      width: Math.max(4, x(line.endSec - line.startSec)),
                      top: (laneOf.get(line.key) ?? 0) * LANE_PX,
                    }}
                    title={`${line.key} · ${line.startSec.toFixed(2)}s–${line.endSec.toFixed(2)}s · ${line.singer.join(", ")}\n${line.text}`}
                    data-start={line.startSec}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") playFrom(line.startSec);
                    }}
                  >
                    {editing && (
                      <span
                        className="song-track-edge song-track-edge--start"
                        style={{ width: EDGE_PX }}
                        onPointerDown={(e) => grab(e, line, "start")}
                      />
                    )}
                    {editing && (
                      <span
                        className="song-track-line-grip"
                        title="Drag to where the line is sung"
                        onPointerDown={(e) => grab(e, line, "move")}
                      >
                        ⠿
                      </span>
                    )}
                    <span className="song-track-line-text">{line.text}</span>
                    <span className="song-track-line-singer">{line.singer.join(", ")}</span>
                    {editing && line.pending && (
                      <button
                        type="button"
                        className="song-track-line-undo"
                        title="Undo this change"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => editing.discard(song.variantId, line.key)}
                      >
                        ↶
                      </button>
                    )}
                    {editing && line.set && !line.pending && (
                      <button
                        type="button"
                        className="song-track-line-undo"
                        title="Leave this line to konte's reading again"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() =>
                          editing.place({ variantId: song.variantId, key: line.key, span: null })
                        }
                      >
                        ↺
                      </button>
                    )}
                    {editing && (
                      <span
                        className="song-track-edge song-track-edge--end"
                        style={{ width: EDGE_PX }}
                        onPointerDown={(e) => grab(e, line, "end")}
                      />
                    )}
                  </div>
                  /* oxlint-enable jsx-a11y/prefer-tag-over-role */
                ))}
              </div>
            </div>
            <PlayheadLine
              playhead={playhead}
              leftAt={(time) => LABEL_W + Math.min(time, durationSec) * pxPerSec}
            />
          </div>
        </div>
        <div className="rt-zoom">
          <button
            type="button"
            className="ctrl-btn"
            title="Zoom out (-)"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            −
          </button>
          <button
            type="button"
            className="ctrl-btn ctrl-btn--icon"
            title="Fit to width (=)"
            aria-label="Fit to width"
            onClick={resetZoom}
          >
            <FitIcon size={13} />
          </button>
          <button
            type="button"
            className="ctrl-btn"
            title="Zoom in (+)"
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            +
          </button>
        </div>
      </div>
      {tray.length > 0 && (
        <div className="song-track-tray">
          <span className="song-track-tray-label">
            {editing ? "Not placed — drag onto the Lyrics track where it is sung" : "Not placed"}
          </span>
          {tray.map((line) => (
            <span
              key={line.key}
              className={`song-track-chip${line.pending ? " song-track-chip--pending" : ""}${editing ? "" : " song-track-chip--readonly"}`}
              onPointerDown={(e) => grab(e, line, "new")}
            >
              <span className="song-track-line-text">{line.text}</span>
              <span className="song-track-line-singer">{line.singer.join(", ")}</span>
              {editing && line.pending && (
                <button
                  type="button"
                  className="song-track-line-undo"
                  title="Undo this change"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => editing.discard(song.variantId, line.key)}
                >
                  ↶
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
