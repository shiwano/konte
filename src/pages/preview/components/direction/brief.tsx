import type React from "react";

import type {
  BriefReferenceInfo,
  BriefSourceInfo,
  DirectionBriefField,
  DirectionBriefFieldInfo,
  DirectionBriefListField,
} from "../../types.js";
import { DirTable, type NotesRenderer } from "./dir-table.js";

const BRIEF_FIELD_LABELS: Record<DirectionBriefField, string> = {
  logline: "Logline",
  hook: "Hook",
  audience: "Audience",
  tone: "Tone",
  look: "Look",
  outOfScope: "Out of scope",
  tolerances: "Tolerances",
  references: "References",
  source: "Adapted from",
};

// An empty list field still gets a row — "the piece bans nothing", "the piece tolerates nothing" is
// a position, and the reviewer's note on it is how an entry gets added.
const BRIEF_EMPTY_LIST_TEXT: Record<DirectionBriefListField, string> = {
  outOfScope: "Nothing excluded",
  tolerances: "Nothing tolerated",
};

function BriefReference({ reference }: { reference: BriefReferenceInfo }): React.ReactElement {
  const clip = reference.clip.split("/").at(-1) ?? reference.clip;
  return (
    <div className="direction-brief-ref">
      <div className="direction-brief-ref-text">
        <div>
          <span className="dir-inline-label">Take</span> {reference.variant}
        </div>
        <div>
          <span className="dir-inline-label">Avoid</span> {reference.avoid}
        </div>
        <div className="direction-brief-ref-source">
          {clip}
          {reference.link && (
            <>
              {" · "}
              <a href={reference.link} target="_blank" rel="noopener noreferrer">
                {reference.link}
              </a>
            </>
          )}
        </div>
      </div>
      {reference.sheets.length > 0 && (
        <div className="direction-brief-ref-sheets">
          {reference.sheets.map((src) => (
            <a key={src} href={src} target="_blank" rel="noopener noreferrer">
              <img src={src} alt={clip} loading="lazy" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// The chapters the piece is adapted from, and the adaptation map's keep and drop, each glossed.
function BriefSource({ source }: { source: BriefSourceInfo }): React.ReactElement {
  const list = (label: string, gloss: string, items: string[]) =>
    items.length > 0 && (
      <div className="dir-source-group">
        <span className="dir-source-group-label">{label}</span>
        <span className="dir-source-group-gloss">{gloss}</span>
        <ul className="direction-brief-list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="direction-brief-source">
      <div className="dir-source-span">{source.span}</div>
      {list("Keep", "must come through on screen", source.keep)}
      {list("Drop", "left out of the piece", source.drop)}
    </div>
  );
}

function briefValue(f: DirectionBriefFieldInfo): React.ReactNode {
  if ("references" in f) {
    return f.references.map((r, i) => <BriefReference key={i} reference={r} />);
  }
  if ("source" in f) return <BriefSource source={f.source} />;
  if (!("items" in f)) return f.text;
  return f.items.length > 0 ? (
    <ul className="direction-brief-list">
      {f.items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  ) : (
    <span className="direction-brief-empty">{BRIEF_EMPTY_LIST_TEXT[f.field]}</span>
  );
}

// The agreed concept opens the review: the reviewer judges the shots against what the piece is
// supposed to be, so the brief reads first, each field taking feedback of its own.
export function DirectionBrief({
  fields,
  renderNotes,
}: {
  fields: DirectionBriefFieldInfo[];
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <DirTable
      headers={["Field", "Value"]}
      rows={fields.map((f) => ({
        key: f.field,
        name: BRIEF_FIELD_LABELS[f.field],
        value: briefValue(f),
        part: f,
      }))}
      renderNotes={renderNotes}
    />
  );
}
