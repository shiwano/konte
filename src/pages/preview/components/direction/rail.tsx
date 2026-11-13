import type React from "react";
import { useContext, useState } from "react";

import { formatTimecode } from "../../format-time.js";
import type {
  DirectionPartInfo,
  DirectionPreviewState,
  DirectionSection,
  DirectionSequenceInfo,
  DirectionShotInfo,
} from "../../types.js";
import { ChevronRightIcon, CommentIcon, JumpIcon, PanelRightIcon } from "../icons.js";
import { PartMarkTag, PartMarksContext } from "./marks.js";

// A place under the script the index jumps to: a section, or one part of one.
export interface RailLink {
  target: string;
  label: string;
  parts: DirectionPartInfo[];
  // A part of it was removed since its accept.
  trimmed: boolean;
}

interface RailContext {
  // The part the side panel shows.
  peeked: string | null;
  // The shots showing each roster part, by part address.
  appearances: ReadonlyMap<string, readonly string[]>;
  hasNotes: (part: DirectionPartInfo) => boolean;
  focusedShotId: string | null;
  onPeek: (address: string) => void;
  onJumpPart: (address: string) => void;
  onJumpShot: (shotId: string) => void;
}

// The page's index, beside the script for as long as it is read: the acts to jump to, the roster
// to look an entry up in, and the sections below the script.
export function DirectionRail({
  state,
  shots,
  links,
  cut,
  trimmed,
  open,
  tools,
  ...ctx
}: {
  state: DirectionPreviewState;
  // Every shot, in clock order.
  shots: readonly DirectionShotInfo[];
  links: RailLink[];
  // The roster sections whose accepted entries are all gone.
  cut: ReadonlySet<DirectionSection>;
  // The sections an accepted part was removed from.
  trimmed: ReadonlySet<DirectionSection>;
  open: boolean;
  // The header's controls a phone's one-row bar has no room for.
  tools: React.ReactNode;
} & RailContext): React.ReactElement {
  const declared = new Set(state.locations.map((l) => l.id));
  const strays = state.setups.filter((s) => !declared.has(s.locationId));
  const total = shots.reduce<number | null>(
    (acc, s) => (acc === null || s.duration === null ? null : acc + s.duration),
    0,
  );
  const [unfoldedPlaces, setUnfoldedPlaces] = useState<ReadonlySet<string>>(new Set());
  const togglePlace = (id: string) =>
    setUnfoldedPlaces((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const setupRow = (s: DirectionPreviewState["setups"][number]) => (
    <EntryRow
      key={s.id}
      part={s}
      name={s.name}
      lead={<span className="dir-rail-size">{s.framing}</span>}
      nested
      ctx={ctx}
    />
  );
  return (
    <nav
      className={`dir-rail${open ? " dir-rail--open" : ""}`}
      aria-label="Direction index"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="dir-rail-scroll dir-scroll">
        <RailGroup title="Flow">
          <EntryRow
            part={state.sequence}
            name="Whole piece"
            meta={`${shots.length} shots${total === null ? "" : ` · ${formatTimecode(total)}`}`}
            ctx={ctx}
          />
          {(state.sequences ?? []).map((seq) => (
            <Act key={seq.id} sequence={seq} depth={0} ctx={ctx} />
          ))}
          {!state.sequences?.length && <ShotIndex shots={shots} nested={false} ctx={ctx} />}
        </RailGroup>

        {(state.characters.length > 0 || state.narrator || cut.has("characters")) && (
          <RailGroup title="Cast" section="characters">
            {cut.has("characters") ? (
              <CutNote>The cast you accepted has been removed.</CutNote>
            ) : (
              trimmed.has("characters") && <CutNote>{TRIMMED_TEXT}</CutNote>
            )}
            {state.characters.map((c) => (
              <EntryRow
                key={c.id}
                part={c}
                name={c.name}
                noted={c.voice ? [c.voice] : []}
                ctx={ctx}
              />
            ))}
            {state.narrator && <EntryRow part={state.narrator} name="Narrator" ctx={ctx} />}
          </RailGroup>
        )}

        {(state.props.length > 0 || cut.has("props")) && (
          <RailGroup title="Props" section="props">
            {cut.has("props") ? (
              <CutNote>The props you accepted have been removed.</CutNote>
            ) : (
              trimmed.has("props") && <CutNote>{TRIMMED_TEXT}</CutNote>
            )}
            {state.props.map((p) => (
              <EntryRow key={p.id} part={p} name={p.name} ctx={ctx} />
            ))}
          </RailGroup>
        )}

        {(state.locations.length > 0 || strays.length > 0 || cut.has("locations")) && (
          <RailGroup title="Places" section="locations">
            {cut.has("locations") ? (
              <CutNote>The places and setups you accepted have been removed.</CutNote>
            ) : (
              trimmed.has("locations") && <CutNote>{TRIMMED_TEXT}</CutNote>
            )}
            {state.locations.map((l) => {
              const setups = state.setups.filter((s) => s.locationId === l.id);
              // A place holding the setup the panel is on stays open under it.
              const unfolded =
                unfoldedPlaces.has(l.id) || setups.some((s) => s.address === ctx.peeked);
              return (
                <div key={l.id}>
                  <EntryRow
                    part={l}
                    name={l.name}
                    noted={unfolded ? [] : setups}
                    fold={
                      setups.length > 0
                        ? { open: unfolded, onToggle: () => togglePlace(l.id) }
                        : undefined
                    }
                    ctx={ctx}
                  />
                  {unfolded && setups.map(setupRow)}
                </div>
              );
            })}
            {strays.length > 0 && (
              <>
                <span className="dir-rail-sub">Set in no declared place</span>
                {strays.map(setupRow)}
              </>
            )}
          </RailGroup>
        )}

        {links.length > 0 && (
          <RailGroup title="More">
            {links.map((link) => (
              <SectionLink key={link.target} link={link} ctx={ctx} />
            ))}
          </RailGroup>
        )}

        <section className="dir-rail-group dir-rail-tools">
          <h2 className="dir-rail-title">Review</h2>
          <div className="dir-rail-tools-body">{tools}</div>
        </section>
      </div>
    </nav>
  );
}

const TRIMMED_TEXT = "An entry you accepted has been removed since.";

function RailGroup({
  title,
  section,
  children,
}: {
  title: string;
  // The roster section this group is, as a jump target.
  section?: DirectionSection;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="dir-rail-group" data-section={section}>
      <h2 className="dir-rail-title">{title}</h2>
      {children}
    </section>
  );
}

function CutNote({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="dir-rail-cut">{children}</p>;
}

// An act, then the acts under it.
function Act({
  sequence,
  depth,
  ctx,
}: {
  sequence: DirectionSequenceInfo;
  depth: number;
  ctx: RailContext;
}): React.ReactElement {
  const [unfolded, setUnfolded] = useState(false);
  const shots = sequence.shots ?? [];
  return (
    <>
      <div className={`dir-rail-row${depth > 0 ? " dir-rail-row--nested" : ""}`}>
        {shots.length > 0 && (
          <button
            type="button"
            className="dir-rail-fold"
            aria-expanded={unfolded}
            aria-label={`${unfolded ? "Hide" : "Show"} the shots in ${sequence.id}`}
            onClick={() => setUnfolded((v) => !v)}
          >
            <ChevronRightIcon size={12} />
          </button>
        )}
        <button
          type="button"
          className="dir-rail-open"
          onClick={() => ctx.onJumpPart(sequence.address)}
        >
          <span className="dir-rail-name">{sequence.id}</span>
          <PartMarkTag address={sequence.address} />
          {sequence.roleFunctionLabel && (
            <span className="dir-rail-meta">{sequence.roleFunctionLabel}</span>
          )}
          <Hint kind="jump" />
        </button>
      </div>
      {unfolded && <ShotIndex shots={shots} nested={depth > 0} ctx={ctx} />}
      {(sequence.sequences ?? []).map((child) => (
        <Act key={child.id} sequence={child} depth={depth + 1} ctx={ctx} />
      ))}
    </>
  );
}

// A run of shots as cells in its roles' colors, each jumping to its shot in the script.
function ShotIndex({
  shots,
  nested,
  ctx,
}: {
  shots: readonly DirectionShotInfo[];
  nested: boolean;
  ctx: RailContext;
}): React.ReactElement {
  return (
    <div className={`dir-rail-shots${nested ? " dir-rail-shots--nested" : ""}`}>
      {shots.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`dir-rail-shot${s.beatFunction ? ` direction-fn--${s.beatFunction}` : ""}`}
          aria-current={ctx.focusedShotId === s.id}
          title={s.roleFunctionLabel ? `${s.id} · ${s.roleFunctionLabel}` : s.id}
          onClick={() => ctx.onJumpShot(s.id)}
        >
          {s.id}
        </button>
      ))}
    </div>
  );
}

// What a row does, shown as it is pointed at: opens the side panel, or moves the page.
function Hint({ kind }: { kind: "peek" | "jump" }): React.ReactElement {
  return (
    <span
      className="dir-rail-hint"
      title={kind === "peek" ? "Opens beside the page" : "Jumps to it"}
    >
      {kind === "peek" ? <PanelRightIcon size={13} /> : <JumpIcon size={13} />}
    </span>
  );
}

function NoteDot(): React.ReactElement {
  return (
    <span className="dir-rail-noted" title="Has notes">
      <CommentIcon size={11} />
    </span>
  );
}

// One part the side panel opens: a roster entry, or the piece as a whole.
function EntryRow({
  part,
  name,
  lead,
  meta,
  nested = false,
  noted,
  fold,
  ctx,
}: {
  part: DirectionPartInfo;
  name: string;
  // Before the name: a setup's size.
  lead?: React.ReactNode;
  meta?: string;
  nested?: boolean;
  // Parts read inside this entry whose notes its row answers for.
  noted?: readonly DirectionPartInfo[];
  // The disclosure of the rows under this one.
  fold?: { open: boolean; onToggle: () => void };
  ctx: RailContext;
}): React.ReactElement {
  const parts = [part, ...(noted ?? [])];
  const trailing = meta ?? ctx.appearances.get(part.address)?.length;
  return (
    <div
      data-part={part.address}
      className={`dir-rail-row${nested ? " dir-rail-row--nested" : ""}${
        ctx.peeked === part.address ? " dir-rail-row--current" : ""
      }`}
    >
      {fold && (
        <button
          type="button"
          className="dir-rail-fold"
          aria-expanded={fold.open}
          aria-label={`${fold.open ? "Hide" : "Show"} the setups in ${name}`}
          onClick={fold.onToggle}
        >
          <ChevronRightIcon size={12} />
        </button>
      )}
      <button
        type="button"
        className="dir-rail-open"
        aria-current={ctx.peeked === part.address}
        onClick={() => ctx.onPeek(part.address)}
      >
        {lead}
        <span className="dir-rail-name">{name}</span>
        {parts.map((p) => (
          <PartMarkTag key={p.address} address={p.address} />
        ))}
        {parts.some(ctx.hasNotes) && <NoteDot />}
        {trailing !== undefined && <span className="dir-rail-meta">{trailing}</span>}
        <Hint kind="peek" />
      </button>
    </div>
  );
}

function SectionLink({ link, ctx }: { link: RailLink; ctx: RailContext }): React.ReactElement {
  const marks = useContext(PartMarksContext);
  const marked = link.parts.filter((p) => marks.has(p.address)).length;
  return (
    <button type="button" className="dir-rail-row" onClick={() => ctx.onJumpPart(link.target)}>
      <span className="dir-rail-name">{link.label}</span>
      {(marked > 0 || link.trimmed) && (
        <span className="dir-mark dir-mark--changed">{marked > 0 ? marked : "cut"}</span>
      )}
      {link.parts.some(ctx.hasNotes) && <NoteDot />}
      <Hint kind="jump" />
    </button>
  );
}
