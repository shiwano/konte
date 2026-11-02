import type React from "react";

import type { DirectionLyricsInfo } from "../../types.js";
import { DirTable, type NotesRenderer } from "./dir-table.js";

// The song's words as one part: the box takes one note and one Accept.
export function DirectionLyrics({
  lyrics,
  renderNotes,
}: {
  lyrics: DirectionLyricsInfo;
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <DirTable
      headers={["Sung by", "Lines"]}
      rows={[
        {
          key: "lyrics",
          name: [...new Set(lyrics.sections.flatMap((s) => s.singer))].join(", "),
          value: (
            <>
              {lyrics.sections.map((section, s) => (
                <div key={s} className="direction-lyrics-section">
                  <span className="dir-inline-label">{section.label}</span>
                  <span className="direction-policy-gloss">{section.singer.join(", ")}</span>
                  <ul className="direction-brief-list">
                    {section.lines.map((line, l) => (
                      <li key={l}>
                        {line.text}
                        {line.singer !== null && (
                          <span className="direction-policy-gloss">
                            sung by {line.singer.join(", ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          ),
          part: lyrics,
        },
      ]}
      renderNotes={renderNotes}
    />
  );
}
