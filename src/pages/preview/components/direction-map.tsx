import type React from "react";
import { useMemo } from "react";
import { formatTimecode } from "../format-time.js";
import {
  ZOOM_STEP,
  tickInterval,
  tickLabel,
  useTimelineZoom,
} from "../review/use-timeline-zoom.js";
import type { BeatFunction, DirectionSequenceInfo, DirectionShotInfo } from "../types.js";
import { CommentIcon, FitIcon } from "./icons.js";

const LABEL_W = 76;
const ARC_H = 52;
const ACT_ROW_H = 20;
// Keeps the peak's and the floor's dots off the row's edges rather than clipping them.
const ARC_PAD = 7;

// Tension, 0 (the piece's floor) to 1 (its peak) — where each dramatic function enters its stretch
// of the piece and where it leaves it. A run of one function travels its band, so three `build`
// shots climb rather than flatline; `settle` runs downhill (it lets the payoff go); `payoff` is the
// peak by definition and has nowhere to travel. The numbers are a reading aid, not a theory: what
// they have to get right is the order — ground below turn below build below payoff — and that a run
// of anything moves.
const FUNCTION_BAND: Record<BeatFunction, readonly [number, number]> = {
  ground: [0.06, 0.14],
  turn: [0.34, 0.44],
  build: [0.46, 0.86],
  payoff: [1, 1],
  settle: [0.5, 0.22],
};

// Each item's own value within its parent's arc: its function's band, and how far along a run of
// that same function it sits. A lone item takes the band's middle — it is the whole of its run, not
// the start of one.
function runValues(fns: readonly (BeatFunction | null)[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < fns.length; ) {
    let j = i;
    while (j < fns.length && fns[j] === fns[i]) j++;
    const [entry, exit] = FUNCTION_BAND[fns[i] ?? "ground"];
    const n = j - i;
    for (let k = 0; k < n; k++) {
      out.push(entry + (exit - entry) * (n === 1 ? 0.5 : k / (n - 1)));
    }
    i = j;
  }
  return out;
}

// Mirrors BEAT_FUNCTION_LABEL (core/lenses.ts) — the five words this page is allowed to spend on
// structure, chosen so a reviewer can dispute them without knowing the craft vocabulary behind them.
const FUNCTION_LABELS: Array<[BeatFunction, string]> = [
  ["ground", "opening"],
  ["build", "rising"],
  ["turn", "turning point"],
  ["payoff", "payoff"],
  ["settle", "closing"],
];

interface FlatShot {
  shot: DirectionShotInfo;
  start: number;
}

// One act as a span of the piece's time, at its level of the arc tree. `span` is how many act rows
// its box fills: one for an act that has children (they fill the rows below it), and all the way
// down to the shots for an act that has none — so every act's box ends flush on the shots it holds.
interface Band {
  key: string;
  seq: DirectionSequenceInfo;
  start: number;
  duration: number;
  depth: number;
  span: number;
}

// Every leaf shot under a node, in order — a leaf act yields its shots, a branch act flattens its
// children recursively, so the pacing strip reads the whole piece however deep the tree nests.
function collectShots(node: DirectionSequenceInfo): DirectionShotInfo[] {
  return node.shots ?? (node.sequences ?? []).flatMap(collectShots);
}

function nodeDuration(node: DirectionSequenceInfo): number {
  return collectShots(node).reduce((acc, s) => acc + s.duration, 0);
}

// How high an act lets the shots inside it climb, as a share of the range the act itself was given.
// An act's own function says where the act sits in its parent's arc, but a `setup-act` still runs a
// whole arc of its own — cap it at the 0.10 its `ground` band would give a *shot* and the mini-drama
// inside it flattens into the floor. So the value is lifted into [ACT_FLOOR, 1]: the ordering
// survives (only a payoff act reaches the top) while every act keeps room to show its shape.
const ACT_FLOOR = 0.4;

const actCeiling = (value: number): number => ACT_FLOOR + value * (1 - ACT_FLOOR);

// The band an act hands its own body, measured on the piece's own scale rather than as a share of
// what the act was given. That is what lets the tree nest: were the children to divide the parent's
// range, each level would multiply the last and an hour-long piece — acts over sequences over scenes
// over shots — would press its opening scene into a few flat pixels, the same way capping a
// `setup-act` at a shot's `ground` band once flattened the whole act.
const ACT_SPAN = 0.4;

// The range an act hands to its own body: its function fixes the ceiling, and the band hangs off
// that. The band is allowed below zero — clamping it there is what would re-crush the low branches,
// since an act deep inside a `setup-act` has its ceiling near the floor and no room underneath.
// `normalize` lifts the whole curve afterwards instead. An act with no function is a container (a
// custom lens' fn-less beat, or a role its lens does not declare) and claims nothing about tension,
// so it passes its parent's range straight through — cap it and the piece inside it could never
// reach its own payoff.
function actRange(
  act: DirectionSequenceInfo,
  value: number,
  lo: number,
  hi: number,
): [number, number] {
  if (act.beatFunction === null) return [lo, hi];
  const ceiling = lo + actCeiling(value) * (hi - lo);
  return [ceiling - ACT_SPAN, ceiling];
}

// Lift the curve so its lowest shot sits on the floor. Only the floor moves: 1 stays 1, so the top
// of the chart keeps meaning "the piece's payoff" and a piece that never reaches one is not stretched
// into a peak it does not have.
function normalize(out: Map<string, number>): void {
  let min = 0;
  for (const value of out.values()) min = Math.min(min, value);
  if (min === 0) return;
  for (const [id, value] of out) out.set(id, (value - min) / (1 - min));
}

// The level the last narrative shot placed, carried across the whole walk. An aside holds it, so the
// line runs level across the span instead of moving — and it has to cross leaf boundaries: an
// eyecatch opening act 2 is the common case, and reading act 2's own first shot there would draw the
// piece dropping to that shot's level before the act it belongs to has started.
type TensionCarry = { level: number | null };

// One leaf's shots placed on the curve. Asides are outside the arc, so they are outside the curve.
// Dropping them before `runValues` matters twice: an aside drawn at the `ground` band would read as a
// dip the piece never takes, and — because runs of one function are interpolated together — one
// sitting inside a run would split it and move the shots around it. Both the flat root and a nested
// leaf go through here, or the same shots would draw differently depending on how they were nested.
function leafTension(
  shots: readonly DirectionShotInfo[],
  lo: number,
  hi: number,
  out: Map<string, number>,
  carry: TensionCarry,
): void {
  const arcShots = shots.filter((s) => !s.aside);
  const values = runValues(arcShots.map((s) => s.beatFunction));
  arcShots.forEach((s, i) => out.set(s.id, lo + values[i]! * (hi - lo)));
  for (const s of shots) {
    if (!s.aside) {
      carry.level = out.get(s.id)!;
      continue;
    }
    // Nothing has been drawn yet (the piece opens on an aside): fall to this leaf's own first shot,
    // and to its floor when the leaf has no shot of its own at all.
    carry.level ??= values[0] === undefined ? lo : lo + values[0] * (hi - lo);
    out.set(s.id, carry.level);
  }
}

// Every shot's tension, walking the arc tree: an act's function caps how high its shots climb, so a
// `setup-act`'s high point stays below the `climax-act`'s and only the piece's real payoff reaches
// the top. Only the peak is contained — an act's own arc is free to dip below the act before it,
// which is what a real curve does and what keeps each act's shape readable at any depth.
function walkTension(
  node: DirectionSequenceInfo,
  lo: number,
  hi: number,
  out: Map<string, number>,
  carry: TensionCarry,
): void {
  if (node.shots) {
    leafTension(node.shots, lo, hi, out, carry);
    return;
  }
  const kids = node.sequences ?? [];
  const values = runValues(kids.map((k) => k.beatFunction));
  kids.forEach((k, i) => walkTension(k, ...actRange(k, values[i]!, lo, hi), out, carry));
}

// The act tree flattened to boxes over the piece's time — each act at the time it starts and the
// level it sits at, so an act brackets exactly the shots below it however deep it nests.
function actBands(
  nodes: readonly DirectionSequenceInfo[],
  start: number,
  depth: number,
  out: Band[],
): void {
  let acc = start;
  for (const seq of nodes) {
    const duration = nodeDuration(seq);
    out.push({ key: `${depth}:${acc}:${seq.id}`, seq, start: acc, duration, depth, span: 1 });
    if (seq.sequences) actBands(seq.sequences, acc, depth + 1, out);
    acc += duration;
  }
}

/**
 * The direction as a picture instead of a list, on the same zoomable time-proportional track the video
 * review's timeline uses. Top to bottom: a ruler, the arc line the shots' dramatic functions trace,
 * then how that shape is built — the acts (one row per level of the arc tree) as boxes closed by
 * the shots they hold, each sized by its duration. Fit to width until the reviewer zooms, so the
 * whole shape reads at a glance and a long-form direction — where a shot would otherwise be a sliver —
 * can still be read up close. Media-less: nothing plays, so there is no playhead and clicking a
 * shot jumps to its row below.
 */
export function DirectionMap({
  kind,
  shots,
  sequences,
  focusedShotId,
  onSelectShot,
}: {
  kind: "flat" | "sequenced";
  shots?: DirectionShotInfo[];
  sequences?: DirectionSequenceInfo[];
  focusedShotId: string | null;
  onSelectShot: (id: string) => void;
}): React.ReactElement | null {
  const flatShots = useMemo<FlatShot[]>(() => {
    const source = kind === "sequenced" ? (sequences ?? []).flatMap(collectShots) : (shots ?? []);
    let acc = 0;
    return source.map((shot) => {
      const flatShot = { shot, start: acc };
      acc += shot.duration;
      return flatShot;
    });
  }, [kind, shots, sequences]);

  const totalDuration = useMemo(
    () => flatShots.reduce((acc, b) => acc + b.shot.duration, 0),
    [flatShots],
  );

  // Shot id → tension. The root's own children divide the piece's full range, so the shot under the
  // act (or, on a flat direction, the shot) that carries the payoff reaches 1.
  const tension = useMemo(() => {
    const out = new Map<string, number>();
    const carry: TensionCarry = { level: null };
    if (kind === "sequenced") {
      const kids = sequences ?? [];
      const values = runValues(kids.map((k) => k.beatFunction));
      kids.forEach((k, i) => walkTension(k, ...actRange(k, values[i]!, 0, 1), out, carry));
    } else {
      leafTension(shots ?? [], 0, 1, out, carry);
    }
    normalize(out);
    return out;
  }, [kind, shots, sequences]);

  const { bands, actRowCount } = useMemo(() => {
    if (kind !== "sequenced") return { bands: [] as Band[], actRowCount: 0 };
    const out: Band[] = [];
    actBands(sequences ?? [], 0, 0, out);
    const rowCount = out.reduce((max, b) => Math.max(max, b.depth + 1), 0);
    for (const b of out) if (!b.seq.sequences) b.span = rowCount - b.depth;
    return { bands: out, actRowCount: rowCount };
  }, [kind, sequences]);

  const {
    scrollRef,
    effectivePxPerSec,
    timelineWidth,
    zoomBy,
    resetZoom,
    panHandlers,
    wasDragged,
  } = useTimelineZoom({
    totalDuration,
    labelWidth: LABEL_W,
    noPanSelector: ".direction-map-label",
  });

  const ticks = useMemo(() => {
    if (totalDuration <= 0) return { step: 1, times: [] as number[] };
    const step = tickInterval(effectivePxPerSec);
    const times: number[] = [];
    for (let t = 0; t <= totalDuration + 0.001; t += step) times.push(t);
    return { step, times };
  }, [totalDuration, effectivePxPerSec]);

  if (flatShots.length === 0 || totalDuration <= 0) return null;

  // Arc line points at each shot's horizontal centre, at its tension. A shot whose role its lens
  // does not declare has no function; it reads as grounded rather than breaking the line.
  const points = flatShots.map((b) => ({
    x: (b.start + b.shot.duration / 2) * effectivePxPerSec,
    y: ARC_PAD + (1 - (tension.get(b.shot.id) ?? 0)) * (ARC_H - ARC_PAD * 2),
    fn: b.shot.beatFunction ?? "ground",
  }));

  return (
    <div className="direction-map">
      <div className="direction-map-header">
        <span className="direction-map-title">Pacing</span>
        <span className="direction-map-total">
          {flatShots.length} shot{flatShots.length === 1 ? "" : "s"} ·{" "}
          {formatTimecode(totalDuration)}
        </span>
        <span className="direction-map-legend">
          {FUNCTION_LABELS.map(([fn, label]) => (
            <span key={fn} className="direction-map-legend-item">
              <span className={`direction-map-legend-dot direction-fn--${fn}`} />
              {label}
            </span>
          ))}
        </span>
      </div>

      <div className="direction-map-scroll" ref={scrollRef} {...panHandlers}>
        <div className="direction-map-content" style={{ width: LABEL_W + timelineWidth }}>
          <div className="direction-map-row">
            <div className="direction-map-label direction-map-label--ruler" />
            <div className="direction-map-ruler" style={{ width: timelineWidth }}>
              {ticks.times.map((t) => (
                <div key={t} className="direction-map-tick" style={{ left: t * effectivePxPerSec }}>
                  <span className="direction-map-tick-label">{tickLabel(t, ticks.step)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* The shape the shots trace, read off their dramatic functions. It leads: the shape is
              what this section exists to put in front of someone with no craft vocabulary, and the
              acts and shots below are how it is built. */}
          <div className="direction-map-row">
            <div className="direction-map-label">
              <span className="direction-map-label-text">Arc</span>
            </div>
            <svg
              className="direction-map-arc"
              width={timelineWidth}
              height={ARC_H}
              aria-hidden="true"
            >
              <polyline
                className="direction-map-arc-line"
                points={points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
              />
              {points.map((p, i) => (
                <circle
                  key={flatShots[i]!.shot.id}
                  className={`direction-map-arc-dot direction-fn--${p.fn}`}
                  cx={p.x}
                  cy={p.y}
                  r={5}
                />
              ))}
            </svg>
          </div>

          {/* Long-form only. One box per act, stacked by level and flush on the shot row below —
              so an act reads as holding its shots rather than as a lane beside them. */}
          {bands.length > 0 && (
            <div className="direction-map-row">
              <div className="direction-map-label">
                <span className="direction-map-label-text">Acts</span>
              </div>
              <div
                className="direction-map-acts"
                style={{ width: timelineWidth, height: actRowCount * ACT_ROW_H }}
              >
                {bands.map((band) => (
                  <span
                    key={band.key}
                    className="direction-map-seq"
                    style={
                      {
                        left: band.start * effectivePxPerSec,
                        width: Math.max(band.duration * effectivePxPerSec, 8),
                        top: band.depth * ACT_ROW_H,
                        height: band.span * ACT_ROW_H,
                        "--dir-depth": band.depth,
                      } as React.CSSProperties
                    }
                    title={`${band.seq.id}: ${band.seq.synopsis}`}
                  >
                    <span className="direction-map-seq-id">{band.seq.id}</span>
                    <span className="direction-map-seq-role">{band.seq.beatFunctionLabel}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="direction-map-row">
            <div className="direction-map-label">
              <span className="direction-map-label-text">Shots</span>
            </div>
            <div
              className={`direction-map-track${bands.length > 0 ? " direction-map-track--under-acts" : ""}`}
              style={{ width: timelineWidth }}
            >
              {flatShots.map(({ shot, start }) => {
                const commentCount = shot.feedback.length;
                return (
                  <button
                    key={shot.id}
                    type="button"
                    className={`direction-map-shot ${
                      shot.aside
                        ? "direction-map-shot--aside"
                        : `direction-fn--${shot.beatFunction ?? "ground"}`
                    }${focusedShotId === shot.id ? " direction-map-shot--focused" : ""}`}
                    style={{
                      left: start * effectivePxPerSec,
                      width: Math.max(shot.duration * effectivePxPerSec, 8),
                    }}
                    title={`${shot.id}${shot.aside ? " · aside" : shot.beatFunctionLabel ? ` · ${shot.beatFunctionLabel}` : ""} · ${shot.duration}s: ${shot.action}`}
                    // A drag across the track pans it, so a pointer click that moved is the tail of
                    // that pan, not a pick. `detail === 0` is an activation with no pointer behind it
                    // (Enter/Space on the focused shot) — there was no drag to be the tail of, and
                    // asking would strand the keyboard on whatever the last mouse gesture left set.
                    onClick={(e) => {
                      if (e.detail !== 0 && wasDragged()) return;
                      onSelectShot(shot.id);
                    }}
                  >
                    {/* The band is the piece's *time* — which shot runs how long, in proportion. Its
                        role is named once, with its gloss, in the Shots table below; repeating it
                        here would make the band a second, worse copy of that table. */}
                    <span className="direction-map-shot-head">
                      <span className="direction-map-shot-id">{shot.id}</span>
                    </span>
                    <span className="direction-map-shot-dur">{shot.duration}s</span>
                    <span className="direction-map-shot-flags">
                      {commentCount > 0 && (
                        <span className="direction-map-shot-comments">
                          <CommentIcon size={9} />
                          {commentCount}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Zoom floats over the bottom-right of the track, as it does on the video review's timeline. */}
      <div className="direction-map-zoom">
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
    </div>
  );
}
