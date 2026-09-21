// Shared terminal primitives for drawing audio amplitude as a block-character sparkline, used by
// both `konte probe reel-audio` (timeline lanes) and `konte probe audio` (a single source's waveform).

const BLOCKS = "▁▂▃▄▅▆▇█";

// Map a 0-1 amplitude to a block glyph; "·" marks a scheduled-but-near-silent column so an active
// region stays visible even where it is quiet.
export function cell(v: number): string {
  if (v <= 0.02) return "·";
  const idx = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(v * (BLOCKS.length - 1))));
  return BLOCKS[idx]!;
}

// Peak-preserving downsample of `env` to `width` columns, so a brief transient never vanishes
// between buckets. f0/f1 select the fraction of the envelope to draw (0..1) — used to window a
// track that extends past the visible range while keeping it time-aligned.
export function resample(env: number[], width: number, f0 = 0, f1 = 1): number[] {
  if (width <= 0) return [];
  if (env.length === 0) return new Array<number>(width).fill(0);
  const i0 = f0 * env.length;
  const i1 = f1 * env.length;
  const out = new Array<number>(width).fill(0);
  for (let c = 0; c < width; c++) {
    const lo = Math.floor(i0 + (c / width) * (i1 - i0));
    const hi = Math.max(lo + 1, Math.floor(i0 + ((c + 1) / width) * (i1 - i0)));
    let m = 0;
    for (let i = lo; i < hi && i < env.length; i++) m = Math.max(m, env[i]!);
    out[c] = m;
  }
  return out;
}

// A "nice" tick spacing (1/2/5 × 10ⁿ) so the axis lands on round seconds.
function niceStep(span: number, targetTicks: number): number {
  const raw = span / Math.max(1, targetTicks);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

// Seconds, the unit the whole project speaks — shot durations, cue offsets, silence warnings and the
// track table are all in it, so an m:ss timecode here would only force the reader to convert back.
export function fmtSeconds(s: number): string {
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

// A time axis spanning [vStart, vEnd] over `graphW` columns: one row of labels at round seconds,
// exactly graphW wide. Callers prepend their own left gutter. Labels alone place the sparkline in
// time; a rule of ─ under them would cost a glyph per column and say nothing they don't.
export function buildTimeAxis(vStart: number, vEnd: number, graphW: number): string {
  const span = Math.max(0.001, vEnd - vStart);
  const colOf = (t: number): number => Math.round(((t - vStart) / span) * graphW);
  const step = niceStep(span, Math.max(4, Math.floor(graphW / 10)));
  const labelRow = new Array<string>(graphW).fill(" ");
  const firstTick = Math.ceil(vStart / step) * step;
  for (let t = firstTick; t <= vEnd + 1e-6; t += step) {
    const col = colOf(t);
    if (col < 0 || col >= graphW) continue;
    const lbl = fmtSeconds(t);
    for (let i = 0; i < lbl.length && col + i < graphW; i++) labelRow[col + i] = lbl[i]!;
  }
  return labelRow.join("");
}

export function normalize(values: number[]): number[] {
  const peak = Math.max(...values, 0);
  return peak > 0 ? values.map((v) => v / peak) : values;
}
