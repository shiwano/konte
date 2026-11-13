import type React from "react";

import type { DirectionPartInfo } from "../../types.js";
import { PartMarkTag } from "./marks.js";

export type NotesRenderer = (part: DirectionPartInfo) => React.ReactElement;

// A name / value / notes table — the shape the brief, the policy and the props share, one part
// per row.
export function DirTable({
  headers: [nameHeader, valueHeader],
  rows,
  renderNotes,
}: {
  headers: [string, string];
  rows: Array<{
    key: string;
    name: React.ReactNode;
    value: React.ReactNode;
    part: DirectionPartInfo;
  }>;
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <table className="dir-table">
      <thead>
        <tr>
          <th className="dir-col-name">{nameHeader}</th>
          <th className="dir-col-syn">{valueHeader}</th>
          <th className="dir-col-notes">Notes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="dir-row" data-part={r.part.address}>
            <td className="dir-col-name">
              {r.name} <PartMarkTag address={r.part.address} />
            </td>
            <td className="dir-col-syn">{r.value}</td>
            <td className="dir-col-notes">{renderNotes(r.part)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
