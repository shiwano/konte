import type { SrtEntry } from "../../srt.js";

type DivElementProps = React.ComponentPropsWithoutRef<"div">;
type SpanElementProps = React.ComponentPropsWithoutRef<"span">;

export interface SubtitleEntry {
  start: number;
  end: number;
  text: string;
}

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
  if (entries.length === 0) {
    return null;
  }
  return (
    <>
      {renderEntries(toSrtEntries(entries), rest, { className: lineClassName, style: lineStyle })}
    </>
  );
}

function toSrtEntries(entries: readonly SubtitleEntry[]): SrtEntry[] {
  return entries.map((e, i) => ({
    index: i + 1,
    startSeconds: e.start,
    endSeconds: e.end,
    text: e.text,
  }));
}

function renderEntries(
  entries: SrtEntry[],
  rest: DivElementProps,
  line: SpanElementProps,
): React.ReactElement[] {
  return entries.map((entry) => {
    const duration = entry.endSeconds - entry.startSeconds;
    return (
      <div
        key={entry.index}
        {...rest}
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
