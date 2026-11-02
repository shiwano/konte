import type React from "react";

import type { DirectionWaiverInfo } from "../../types.js";
import type { NotesRenderer } from "./dir-table.js";

// The one place an agent overrules the checker on its own authority: each row is a rule the
// direction breaks, plus the author's argument for breaking it. Nothing here blocks generation — a
// waiver is what got the direction past the gate — so if the reviewer never reads this section, no
// one ever checked those arguments. Hence: the reasons lead, and the finding `code` (a machine
// contract, useless to a reader) is demoted to a footnote on the rule it names.
export function DirectionWaivers({
  waivers,
  renderNotes,
}: {
  waivers: DirectionWaiverInfo[];
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <table className="dir-table">
      <thead>
        <tr>
          <th className="dir-col-syn">What was flagged</th>
          <th className="dir-col-syn">The author&rsquo;s argument</th>
          <th className="dir-col-notes">Notes</th>
        </tr>
      </thead>
      <tbody>
        {waivers.map((w) => (
          <tr key={w.address} className="dir-row">
            <td className="dir-col-syn">
              {w.message}
              <span className="dir-waiver-code">
                {w.code}
                {w.subject && `: ${w.subject}`}
              </span>
            </td>
            <td className="dir-col-syn">{w.reason}</td>
            <td className="dir-col-notes">{renderNotes(w)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
