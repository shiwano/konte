import type { SrtEntry } from "../../srt.js";

type DivElementProps = React.ComponentPropsWithoutRef<"div">;

export interface SubtitleEntry {
  start: number;
  end: number;
  text: string;
}

export type SubtitleProps = DivElementProps & {
  entries: readonly SubtitleEntry[];
};

export function Subtitle({ entries, ...rest }: SubtitleProps): React.ReactElement | null {
  if (entries.length === 0) {
    return null;
  }
  return <>{renderEntries(toSrtEntries(entries), rest)}</>;
}

function toSrtEntries(entries: readonly SubtitleEntry[]): SrtEntry[] {
  return entries.map((e, i) => ({
    index: i + 1,
    startSeconds: e.start,
    endSeconds: e.end,
    text: e.text,
  }));
}

function renderEntries(entries: SrtEntry[], rest: DivElementProps): React.ReactElement[] {
  return entries.map((entry) => {
    const duration = entry.endSeconds - entry.startSeconds;
    return (
      <div
        key={entry.index}
        {...rest}
        className={`konte-clip konte-subtitle flex items-end justify-center text-center text-white font-semibold drop-shadow-lg${rest.className ? ` ${rest.className}` : ""}`}
        data-start={entry.startSeconds}
        data-duration={duration}
        data-track-index={10}
      >
        {entry.text}
      </div>
    );
  });
}
