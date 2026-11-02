import type React from "react";

import type { DirectionPolicyFieldInfo } from "../../types.js";
import { DirTable, type NotesRenderer } from "./dir-table.js";

// The value cell for one policy field, rendered from its structured shape. Each pairs a plain
// value with a gloss a reviewer can take a position on — "any backend allowed", not a bare "all".
function policyValue(field: DirectionPolicyFieldInfo): React.ReactElement {
  switch (field.field) {
    case "format":
      return (
        <>
          {field.aspects.join(", ")}
          <span className="direction-policy-gloss">
            {field.base.width}×{field.base.height} ({field.megapixels} Mpx) → {field.delivery.width}
            ×{field.delivery.height}, {field.fps} fps
          </span>
        </>
      );
    case "lang": {
      const name = languageName(field.lang);
      return (
        <>
          {field.lang}
          {name ? <span className="direction-policy-gloss">{name}</span> : null}
        </>
      );
    }
    case "fonts": {
      if (field.fonts.length === 0) {
        return (
          <>
            None
            <span className="direction-policy-gloss">
              text falls to the rendering machine&apos;s own faces
            </span>
          </>
        );
      }
      return (
        <>
          {field.fonts.join(", ")}
          <span className="direction-policy-gloss">fallback order, resolved per character</span>
        </>
      );
    }
    case "song":
      return (
        <>
          reference:{field.song}
          <span className="direction-policy-gloss">
            the piece is cut to it; every shot is counted in its beats
          </span>
        </>
      );
  }
}

// The tag spelled out for a reader who does not read BCP-47 ("ja" → "Japanese"). Null when the
// runtime cannot name it.
function languageName(tag: string): string | null {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    return name && name !== tag ? name : null;
  } catch {
    return null;
  }
}

const POLICY_FIELD_LABELS: Record<DirectionPolicyFieldInfo["field"], string> = {
  format: "Format",
  lang: "Language",
  fonts: "Fonts",
  song: "Song",
};

// The machine-checked constraints the piece renders under — canvas, language, fonts, song. Each is a
// deliberate choice in the acceptance hash (editing one re-blocks the direction), so each is reviewed
// on its own line: the reviewer can object to the fonts without touching the canvas.
export function DirectionPolicy({
  fields,
  renderNotes,
}: {
  fields: DirectionPolicyFieldInfo[];
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <DirTable
      headers={["Field", "Value"]}
      rows={fields.map((f) => ({
        key: f.field,
        name: POLICY_FIELD_LABELS[f.field],
        value: policyValue(f),
        part: f,
      }))}
      renderNotes={renderNotes}
    />
  );
}
