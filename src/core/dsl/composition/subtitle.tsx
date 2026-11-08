import { getRenderContext } from "../../jsx-html.js";
import type { SrtEntry } from "../../srt.js";
import { type SubtitleLineEntry, timeSubtitleLine } from "../../subtitle-timing.js";

type DivElementProps = React.ComponentPropsWithoutRef<"div">;
type SpanElementProps = React.ComponentPropsWithoutRef<"span">;

interface TimedEntry {
  start: number;
  end: number;
  text: string;
}

/**
 * Shown from `start` to `end`, seconds on the composition's clock; or a script line (`shot`,
 * `line`), timed off where the reel says it.
 */
export type SubtitleEntry = (TimedEntry & { shot?: never; line?: never }) | SubtitleLineEntry;

export type SubtitleProps = DivElementProps & {
  entries: readonly SubtitleEntry[];
  /** On the `<span>` holding each line's text. */
  lineClassName?: string;
  lineStyle?: SpanElementProps["style"];
};

export function Subtitle({
  entries,
  lineClassName,
  lineStyle,
  ...rest
}: SubtitleProps): React.ReactElement | null {
  const window = getRenderContext().window;
  const all = entries
    .flatMap((e) =>
      e.shot === undefined
        ? [{ start: e.start, end: e.end, text: e.text, attrs: {} }]
        : timedLine(e),
    )
    .filter((e) => !window || (e.end - window.start > EPSILON && window.end - e.start > EPSILON));
  if (all.length === 0) {
    return null;
  }
  return (
    <>{renderEntries(toSrtEntries(all), rest, { className: lineClassName, style: lineStyle })}</>
  );
}

type Attrs = Record<string, string>;

const EPSILON = 1e-6;

// A line's entries timed off the reel, or — on a render from the definition alone — each of its
// texts at 0. Each is marked with what times it — the line, the words it names, the take and pauses
// it splits at — so a change to any reaches the overlay's identity and a check reads them.
function timedLine(spec: SubtitleLineEntry): (TimedEntry & { attrs: Attrs })[] {
  const line: Attrs = {
    "data-konte-line": `${spec.shot}:${spec.line}`,
    ...(spec.take
      ? { "data-konte-take": spec.take, "data-konte-pauses": spec.pauses.join(",") }
      : {}),
  };
  const attrsAt = (i: number): Attrs =>
    spec.parts ? { ...line, "data-konte-said": spec.parts[i]![0] } : line;
  const timings = getRenderContext().lineTimings;
  if (timings) {
    return timeSubtitleLine(spec, timings).map((e, i) => ({ ...e, attrs: attrsAt(i) }));
  }
  const texts = spec.parts ? spec.parts.map(([, text]) => text) : [spec.text].flat();
  return texts.map((text, i) => ({ start: 0, end: 0, text, attrs: attrsAt(i) }));
}

function toSrtEntries(
  entries: readonly (TimedEntry & { attrs: Attrs })[],
): (SrtEntry & { attrs: Attrs })[] {
  return entries.map((e, i) => ({
    index: i + 1,
    startSeconds: e.start,
    endSeconds: e.end,
    text: e.text,
    attrs: e.attrs,
  }));
}

function renderEntries(
  entries: (SrtEntry & { attrs: Attrs })[],
  rest: DivElementProps,
  line: SpanElementProps,
): React.ReactElement[] {
  return entries.map((entry) => {
    const duration = entry.endSeconds - entry.startSeconds;
    return (
      <div
        key={entry.index}
        {...rest}
        {...entry.attrs}
        className={`konte-clip konte-subtitle${rest.className ? ` ${rest.className}` : ""}`}
        data-start={entry.startSeconds}
        data-duration={duration}
        data-track-index={10}
      >
        <span {...line}>{entry.text}</span>
      </div>
    );
  });
}
