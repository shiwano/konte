// The subtitle a script-line `<Subtitle>` entry shows, timed off where its line is heard on the reel
// (`reelLineTimings`).

import { KonteError } from "./errors.js";
import type { RenderPlan } from "./render-plan.js";
import type { StageDefinition } from "./types/index.js";

export interface LineTiming {
  shotId: string;
  // The line's number in the shot's script, 1-based.
  line: number;
  text: string;
  // The take that says it on the reel; null where no clip sounds it.
  take: { address: string; variantId: string } | null;
  // The reel second each character is heard at, null where unheard; null where the take was not heard.
  charAt: (number | null)[] | null;
  // Where each character is heard outside what the clip plays of the take.
  clipped: boolean[] | null;
  // Every heard token's reel second on the take, ascending.
  onsets: number[];
  // The take's sound on the reel, cut to what the clip plays; null where unmeasured.
  sound: [number, number] | null;
  // The silences inside `sound`, numbered from 1 in this order.
  pauses: [number, number][];
  // The lines the take says, this one among them, in the order it says them.
  takeLines: { line: number; text: string }[];
}

/**
 * Where the lines a stage's overlay subtitles are heard on the reel `plan` resolves; undefined where
 * the overlay subtitles none.
 */
export type LineTimer = (
  video: StageDefinition,
  plan: () => RenderPlan,
) => Promise<ReadonlyMap<string, LineTiming> | undefined>;

export function lineTimingKey(shotId: string, line: number): string {
  return `${shotId}:${line}`;
}

/** A `<Subtitle>` entry naming a script line: what is shown while it is said. */
export type SubtitleLineEntry = { shot: string; line: number; start?: never; end?: never } & (
  | { text: string; parts?: never; take?: never; pauses?: never }
  | {
      parts: readonly (readonly [said: string, text: string])[];
      text?: never;
      take?: never;
      pauses?: never;
    }
  | { take: string; pauses: readonly number[]; text: readonly string[]; parts?: never }
);

export interface TimedSubtitle {
  start: number;
  end: number;
  text: string;
}

// How long a heard character is taken to sound where the next one does not cut it short.
const CHAR_SEC = 0.3;

const letterCount = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

function heardEnd(timing: LineTiming, onset: number): number {
  const next = timing.onsets.find((t) => t > onset);
  if (next === undefined && timing.sound && timing.sound[1] > onset) return timing.sound[1];
  return Math.min(onset + CHAR_SEC, next ?? Number.POSITIVE_INFINITY);
}

// The span of characters [from, to) of the line, as heard; null where none of them is.
function heardSpan(timing: LineTiming, from: number, to: number): [number, number] | null {
  const heard = (timing.charAt ?? []).slice(from, to).filter((t): t is number => t !== null);
  if (heard.length === 0) return null;
  return [Math.min(...heard), heardEnd(timing, Math.max(...heard))];
}

// The share of `span` the letters [from, to) of `text` take, letters counted from its start.
function apportion(
  span: [number, number],
  text: string,
  from: number,
  to: number,
): [number, number] {
  const total = Math.max(1, letterCount(text));
  const at = (i: number) => span[0] + ((span[1] - span[0]) * letterCount(text.slice(0, i))) / total;
  return [at(from), at(to)];
}

// Whether the characters [from, to) are all cut by the clip where any is heard.
function cut(timing: LineTiming, from: number, to: number): boolean {
  return (timing.clipped ?? []).slice(from, to).some(Boolean);
}

function lineSpan(timing: LineTiming): [number, number] | null {
  const heard = heardSpan(timing, 0, timing.text.length);
  if (heard) return heard;
  if (!timing.sound || cut(timing, 0, timing.text.length)) return null;
  const joined = timing.takeLines.map((l) => l.text).join(" ");
  const k = timing.takeLines.findIndex((l) => l.line === timing.line);
  if (k < 0) return timing.sound;
  const from = timing.takeLines.slice(0, k).reduce((n, l) => n + l.text.length + 1, 0);
  return apportion(timing.sound, joined, from, from + timing.text.length);
}

// The span of characters [from, to) of the line: as heard, else between the heard characters
// around it, else its share of the line; null where the clip cuts them.
function partSpan(
  timing: LineTiming,
  span: [number, number],
  from: number,
  to: number,
): [number, number] | null {
  const heard = heardSpan(timing, from, to);
  if (heard) return heard;
  if (cut(timing, from, to)) return null;
  if (!timing.charAt) return apportion(span, timing.text, from, to);
  const before = timing.charAt.slice(0, from).filter((t): t is number => t !== null);
  const after = timing.charAt.slice(to).find((t): t is number => t !== null);
  const start = before.length > 0 ? heardEnd(timing, Math.max(...before)) : span[0];
  const end = after ?? span[1];
  return end > start ? [start, end] : apportion(span, timing.text, from, to);
}

function invalid(spec: SubtitleLineEntry, what: string): KonteError {
  return new KonteError(
    "SUBTITLE_LINE_INVALID",
    `<Subtitle> line ${spec.line} of shot "${spec.shot}": ${what}`,
  );
}

/**
 * What `spec` shows and when, timed off `timings`. Empty where nothing on the reel says the line.
 */
export function timeSubtitleLine(
  spec: SubtitleLineEntry,
  timings: ReadonlyMap<string, LineTiming>,
): TimedSubtitle[] {
  const timing = timings.get(lineTimingKey(spec.shot, spec.line));
  if (!timing) throw invalid(spec, "the direction gives the shot no such line");
  if (spec.pauses && spec.text.length !== spec.pauses.length + 1) {
    throw invalid(
      spec,
      `${spec.pauses.length} pauses split it into ${spec.pauses.length + 1} texts, not ${spec.text.length}`,
    );
  }
  const span = lineSpan(timing);
  if (!span) return [];
  if (spec.parts) {
    let cursor = 0;
    return spec.parts.flatMap(([said, text]) => {
      const at = timing.text.indexOf(said, cursor);
      if (said === "" || at < 0) {
        throw invalid(
          spec,
          `"${said}" is not in its words${cursor > 0 ? ` after "${timing.text.slice(0, cursor)}"` : ""}; the line reads "${timing.text}"`,
        );
      }
      cursor = at + said.length;
      const part = partSpan(timing, span, at, cursor);
      return part ? [{ start: part[0], end: part[1], text }] : [];
    });
  }
  if (spec.pauses) return pauseSplit(spec, timing, span);
  return [{ start: span[0], end: span[1], text: spec.text }];
}

// The line's texts between the pauses it is split at — over the take's sound when the pauses were
// read off the take that plays, else each text's share of the line.
function pauseSplit(
  spec: Extract<SubtitleLineEntry, { pauses: readonly number[] }>,
  timing: LineTiming,
  span: [number, number],
): TimedSubtitle[] {
  const texts = spec.text;
  if (!timing.sound || timing.take?.variantId !== spec.take) {
    const joined = texts.join("");
    let at = 0;
    return texts.map((text) => {
      const [start, end] = apportion(span, joined, at, at + text.length);
      at += text.length;
      return { start, end, text };
    });
  }
  const breaks = spec.pauses.map((n, i) => {
    const pause = timing.pauses[n - 1];
    if (!Number.isInteger(n) || !pause || (i > 0 && n <= spec.pauses[i - 1]!)) {
      throw invalid(
        spec,
        `pause ${n} is not one of take ${spec.take}'s ${timing.pauses.length}, in order; \`konte probe reel-lines\` lists them`,
      );
    }
    return pause;
  });
  const bounds = [timing.sound[0], ...breaks.flat(), timing.sound[1]];
  return texts.map((text, i) => ({ start: bounds[2 * i]!, end: bounds[2 * i + 1]!, text }));
}
