import type React from "react";
import { Fragment, useCallback, useState } from "react";

import type {
  DirectionCharacterInfo,
  DirectionLandmarkInfo,
  DirectionLocationInfo,
  DirectionPropInfo,
  DirectionSetupInfo,
  DirectionVoiceInfo,
} from "../../types.js";
import { DirTable, type NotesRenderer } from "./dir-table.js";

// The characters read before the shots: a shot action names its characters, so the roster is what
// makes the shots legible rather than a footnote to them. A character's voice takes a row of its own
// because it takes its own note and its own sign-off; the stylesheet is what joins the pair back into
// one entry. The narrator closes the table as an entry of its own, with no look to describe.
export function DirectionCharacters({
  characters,
  narrator,
  renderNotes,
}: {
  characters: DirectionCharacterInfo[];
  narrator: DirectionVoiceInfo | undefined;
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <table className="dir-table">
      <thead>
        <tr>
          <th className="dir-col-name">Character</th>
          <th className="dir-col-syn">Description</th>
          <th className="dir-col-notes">Notes</th>
        </tr>
      </thead>
      <tbody>
        {characters.map((c) => (
          <Fragment key={c.id}>
            <tr className={`dir-row${c.voice ? " dir-row--voiced" : ""}`}>
              <td className="dir-col-name">{c.name}</td>
              <td className="dir-col-syn">{c.description}</td>
              <td className="dir-col-notes">{renderNotes(c)}</td>
            </tr>
            {c.voice && (
              <tr className="dir-row dir-row--voice">
                <td className="dir-col-name dir-voice-label">voice</td>
                <td className="dir-col-syn">{c.voice.description}</td>
                <td className="dir-col-notes">{renderNotes(c.voice)}</td>
              </tr>
            )}
          </Fragment>
        ))}
        {narrator && (
          <tr className="dir-row">
            <td className="dir-col-name">Narrator</td>
            <td className="dir-col-syn">{narrator.description}</td>
            <td className="dir-col-notes">{renderNotes(narrator)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// The recurring props: objects that must look the same wherever they appear, read like the characters (a
// shot action names them) but never speaking.
export function DirectionProps({
  props,
  renderNotes,
}: {
  props: DirectionPropInfo[];
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <DirTable
      headers={["Prop", "Description"]}
      rows={props.map((p) => ({ key: p.id, name: p.name, value: p.description, part: p }))}
      renderNotes={renderNotes}
    />
  );
}

// The places the piece is set in, each followed by the frames taken there. Read down, that is the
// coverage plan: how many ways the piece looks at each set, and at what size. The location leads its
// group because a frame is judged against the set it looks at — a second angle on a room the reviewer
// has just read is a question about that room, not about a roster of frames somewhere else.
//
// A location keeps its own row (its own note, its own part) even with no setups under it: an empty
// group is the checker's `unused-location` made visible.
export function DirectionLocations({
  locations,
  setups,
  renderNotes,
}: {
  locations: DirectionLocationInfo[];
  setups: DirectionSetupInfo[];
  renderNotes: NotesRenderer;
}): React.ReactElement {
  // Folded groups, by location id. Every group starts folded, so the section opens as the list of
  // places the piece is set in — the coverage plan is read one set at a time, and a roster of frames
  // long enough to bury the boxes under it never lands on the page whole.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(setups.map((s) => s.locationId)),
  );
  const toggle = useCallback((locationId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(locationId)) next.add(locationId);
      return next;
    });
  }, []);
  const declared = new Set(locations.map((l) => l.id));
  const setupsOf = (locationId: string) => setups.filter((s) => s.locationId === locationId);
  // A frame set somewhere the roster does not declare (`setup-unknown-location`) still has to reach
  // the page — it is a part, so it needs its note and its Accept — so it lands in a group of its own
  // rather than in a location's.
  const strayIds = [
    ...new Set(setups.filter((s) => !declared.has(s.locationId)).map((s) => s.locationId)),
  ];
  return (
    <table className="dir-table">
      <thead>
        <tr>
          <th className="dir-col-name">Location / Setup</th>
          <th className="dir-col-frame">Frame</th>
          <th className="dir-col-holds">Holds</th>
          <th className="dir-col-syn">Description</th>
          <th className="dir-col-notes">Notes</th>
        </tr>
      </thead>
      <tbody>
        {locations.map((l) => (
          <LocationGroup
            key={l.id}
            label={l.name}
            description={l.description}
            landmarks={l.landmarks}
            setups={setupsOf(l.id)}
            collapsed={collapsed.has(l.id)}
            onToggle={() => toggle(l.id)}
            notes={renderNotes(l)}
            renderNotes={renderNotes}
          />
        ))}
        {strayIds.map((id) => (
          <LocationGroup
            key={id}
            label={id}
            unknown
            description="Not a declared location"
            setups={setupsOf(id)}
            collapsed={collapsed.has(id)}
            onToggle={() => toggle(id)}
            notes={null}
            renderNotes={renderNotes}
          />
        ))}
      </tbody>
    </table>
  );
}

// A place and the frames taken in it. The place chip doubles as the group's disclosure — the row
// that heads the frames is the row that folds them. The count beside it says what the group holds
// (a folded setup can be carrying a note, and a reviewer must not have to open a group to learn
// that) and it stands in both states: a tally that appeared on folding would move the name column
// under the eye reading down it.
function LocationGroup({
  label,
  unknown = false,
  description,
  landmarks = [],
  setups,
  collapsed,
  onToggle,
  notes,
  renderNotes,
}: {
  label: string;
  unknown?: boolean;
  description: string;
  landmarks?: DirectionLandmarkInfo[];
  setups: DirectionSetupInfo[];
  collapsed: boolean;
  onToggle: () => void;
  notes: React.ReactNode;
  renderNotes: NotesRenderer;
}): React.ReactElement {
  const noteCount = setups.filter((s) => s.feedback.length > 0 || s.handoffNote).length;
  const chip = (
    <span className={`dir-location${unknown ? " dir-location--unknown" : ""}`}>{label}</span>
  );
  return (
    <Fragment>
      <tr className={`dir-row dir-row--place${unknown ? " dir-row--place-unknown" : ""}`}>
        <td className="dir-col-name">
          {setups.length > 0 ? (
            <button
              type="button"
              className="dir-place-toggle"
              onClick={onToggle}
              aria-expanded={!collapsed}
              title={collapsed ? "Show setups" : "Hide setups"}
            >
              <span className="dir-place-caret" aria-hidden="true">
                {collapsed ? "▸" : "▾"}
              </span>
              {chip}
              <span className="dir-place-count">
                {setups.length} {setups.length === 1 ? "setup" : "setups"}
                {noteCount > 0 && ` · ${noteCount} ${noteCount === 1 ? "note" : "notes"}`}
              </span>
            </button>
          ) : (
            chip
          )}
        </td>
        <td className="dir-col-frame" />
        <td className="dir-col-holds" />
        <td className="dir-col-syn">
          {description}
          {/* What only this place has — what a setup's `holds` names and the prompt that first
              draws the frame must ask for. Reviewed with the place, so they carry no Accept of
              their own. */}
          {landmarks.length > 0 && (
            <ul className="dir-landmarks">
              {landmarks.map((l) => (
                <li key={l.id}>
                  <span className="dir-landmark-name">{l.name}</span>
                  {l.description}
                </li>
              ))}
            </ul>
          )}
        </td>
        <td className="dir-col-notes">{notes}</td>
      </tr>
      {!collapsed && setups.map((s) => <SetupRow key={s.id} setup={s} renderNotes={renderNotes} />)}
    </Fragment>
  );
}

// One camera position under the set it looks at. `Frame` is the size every shot taken on it inherits
// — with the wider frame this one is a window of beneath it — and `Holds` is what of the place this frame carries, left to right, which is
// what makes it recognizable as that place at all.
function SetupRow({
  setup,
  renderNotes,
}: {
  setup: DirectionSetupInfo;
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <tr className="dir-row dir-row--setup">
      <td className="dir-col-name">{setup.name}</td>
      <td className="dir-col-frame">
        <span className={`dir-framing dir-framing--${setup.framing}`}>{setup.framing}</span>
        {setup.view ? <span className="dir-view">{setup.view}</span> : null}
        <span className="dir-within">
          {setup.within === undefined ? "—" : setup.within === null ? "root" : `▸ ${setup.within}`}
        </span>
      </td>
      {/* Left to right on screen. An insert holds nothing, and says so rather than reading as a
          frame whose contents were left out. */}
      <td className="dir-col-holds">
        {setup.holds.length > 0 ? (
          setup.holds.join(" | ")
        ) : (
          <span className="dir-holds-none">—</span>
        )}
      </td>
      <td className="dir-col-syn">{setup.description}</td>
      <td className="dir-col-notes">{renderNotes(setup)}</td>
    </tr>
  );
}
