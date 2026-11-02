import type React from "react";
import { createContext, useContext, useMemo, useRef } from "react";

import { formatSeconds } from "../../../../core/format-duration.js";
import { formatTimecode } from "../../format-time.js";
import { type MarkRange, markFragments } from "../../review/quote.js";
import type {
  DirectionPartInfo,
  DirectionPreviewState,
  DirectionSequenceInfo,
  DirectionShotInfo,
} from "../../types.js";
import { ChevronRightIcon } from "../icons.js";
import type { NotesRenderer } from "./dir-table.js";
import { QuoteTip, useQuoteComposer } from "./quote-composer.js";

// The meter a span is read in bars by — null on a piece with no song, whose spans are seconds.
const SongMeterContext = createContext<{ beatsPerBar: number | null } | null>(null);

const JOIN_LABEL: Record<NonNullable<DirectionShotInfo["join"]>, string> = {
  continuous: "continuous",
  "jump-back": "time jumps back",
  "jump-forward": "time jumps forward",
};

interface ScriptContext {
  focusedShotId: string | null;
  renderNotes: NotesRenderer;
  quotesFor: (part: DirectionPartInfo) => string[];
  isStagingOpen: (shotId: string) => boolean;
  onToggleStaging: (shotId: string) => void;
  // The shots that open a scene (a camera's location differs from the last camera shot's), and each
  // shot's start on the clock — null from the first shot with no span on.
  sceneOpeners: ReadonlySet<string>;
  starts: ReadonlyMap<string, number | null>;
}

// The shots as a screenplay: a scene heading where the location changes, each shot's action and
// lines, its staging folded away. A graphic shot or an aside heads no scene — it plays inside the
// scene around it. Selecting words in a shot offers to comment on them in a panel under the selection.
export function ShotScript({
  kind,
  shots,
  sequences,
  song,
  rootPleasure,
  focusedShotId,
  renderNotes,
  quotesFor,
  isStagingOpen,
  onToggleStaging,
  onAddComment,
}: {
  kind: DirectionPreviewState["kind"];
  shots: DirectionShotInfo[] | undefined;
  sequences: DirectionSequenceInfo[] | undefined;
  song: DirectionPreviewState["song"];
  rootPleasure: string;
  focusedShotId: string | null;
  renderNotes: NotesRenderer;
  quotesFor: (part: DirectionPartInfo) => string[];
  isStagingOpen: (shotId: string) => boolean;
  onToggleStaging: (shotId: string) => void;
  onAddComment: (address: string, text: string) => void;
}): React.ReactElement {
  const { sceneOpeners, starts } = useMemo(() => {
    const ordered = kind === "sequenced" ? (sequences ?? []).flatMap(collectShots) : (shots ?? []);
    const openers = new Set<string>();
    const startById = new Map<string, number | null>();
    let location: string | null = null;
    let clock: number | null = 0;
    for (const shot of ordered) {
      if (!shot.graphic && !shot.aside && shot.location !== null && shot.location !== location) {
        openers.add(shot.id);
        location = shot.location;
      }
      startById.set(shot.id, clock);
      clock = clock === null || shot.duration === null ? null : clock + shot.duration;
    }
    return { sceneOpeners: openers, starts: startById };
  }, [kind, shots, sequences]);

  const containerRef = useRef<HTMLDivElement>(null);
  const composer = useQuoteComposer(containerRef, onAddComment);

  const ctx: ScriptContext = {
    focusedShotId,
    renderNotes,
    // The words the open panel quotes stay marked while the comment is written.
    quotesFor: (part) =>
      composer.address === part.address
        ? [...quotesFor(part), ...composer.quotes]
        : quotesFor(part),
    isStagingOpen,
    onToggleStaging,
    sceneOpeners,
    starts,
  };

  return (
    <SongMeterContext.Provider value={song}>
      <div className="dir-sc" ref={containerRef}>
        {kind === "sequenced"
          ? (sequences ?? []).map((seq) => (
              <ScriptSequence
                key={seq.id}
                sequence={seq}
                depth={0}
                parentPleasure={rootPleasure}
                ctx={ctx}
              />
            ))
          : (shots ?? []).map((shot) => <ScriptShot key={shot.id} shot={shot} ctx={ctx} />)}
        <QuoteTip accepts={composer.accepts} onQuote={composer.quote} />
        {composer.panel}
      </div>
    </SongMeterContext.Provider>
  );
}

function ScriptSequence({
  sequence,
  depth,
  parentPleasure,
  ctx,
}: {
  sequence: DirectionSequenceInfo;
  depth: number;
  parentPleasure: string;
  ctx: ScriptContext;
}): React.ReactElement {
  return (
    <>
      <div className={`dir-sc-row dir-sc-act${depth > 0 ? " dir-sc-act--nested" : ""}`}>
        <div className="dir-sc-gutter">
          <span className="dir-sc-id">{sequence.id}</span>
          <span className="dir-sc-time">
            <SequenceSpan sequence={sequence} />
          </span>
        </div>
        <div className="dir-sc-body">
          <SequenceSummary sequence={sequence} parentPleasure={parentPleasure} />
        </div>
        <div className="dir-sc-notes">{ctx.renderNotes(sequence)}</div>
      </div>
      {sequence.shots
        ? sequence.shots.map((shot) => <ScriptShot key={shot.id} shot={shot} ctx={ctx} />)
        : (sequence.sequences ?? []).map((child) => (
            <ScriptSequence
              key={child.id}
              sequence={child}
              depth={depth + 1}
              parentPleasure={sequence.pleasure.name}
              ctx={ctx}
            />
          ))}
    </>
  );
}

function ScriptShot({
  shot,
  ctx,
}: {
  shot: DirectionShotInfo;
  ctx: ScriptContext;
}): React.ReactElement {
  const open = ctx.isStagingOpen(shot.id);
  const start = ctx.starts.get(shot.id) ?? null;
  // The quotable text in reading order: the action, each line's acting and words, the telop.
  const fields = [
    shot.action,
    ...shot.script.flatMap((line) => [line.acting ?? "", line.text]),
    ...shot.telop,
  ];
  const marks = markFragments(fields, ctx.quotesFor(shot));
  const marksAt = (i: number): MarkRange[] => marks[i] ?? [];
  return (
    <>
      {shot.join && shot.join !== "continuous" && (
        <div className="dir-sc-row">
          <div className="dir-sc-gutter" />
          <div className="dir-sc-body">
            <span className="dir-sc-join">{JOIN_LABEL[shot.join]}</span>
          </div>
          <div className="dir-sc-notes" />
        </div>
      )}
      {ctx.sceneOpeners.has(shot.id) && (
        <div className="dir-sc-row">
          <div className="dir-sc-gutter" />
          <h3 className="dir-sc-body dir-sc-scene">{shot.location}</h3>
        </div>
      )}
      <div
        data-shot-id={shot.id}
        className={`dir-sc-row dir-sc-shot${
          shot.beatFunction ? ` direction-fn--${shot.beatFunction}` : ""
        }${ctx.focusedShotId === shot.id ? " dir-sc-shot--focused" : ""}`}
      >
        <div className="dir-sc-gutter">
          <span className="dir-sc-id">{shot.id}</span>
          <span className="dir-sc-time">
            {start !== null && <>{formatTimecode(start)} · </>}
            <Span seconds={shot.duration} beats={shot.beats} />
          </span>
        </div>
        <div className="dir-sc-body" data-quote-address={shot.address}>
          <p className="dir-sc-action">
            <button
              type="button"
              className={`dir-sc-staging-btn dir-sc-unquotable${open ? " dir-sc-staging-btn--open" : ""}`}
              aria-expanded={open}
              aria-label={`Staging of shot ${shot.id}`}
              onClick={() => ctx.onToggleStaging(shot.id)}
            >
              <ChevronRightIcon size={18} />
            </button>
            {shot.aside && <span className="dir-sc-kind dir-sc-unquotable">aside</span>}
            {shot.graphic && <span className="dir-sc-kind dir-sc-unquotable">graphic</span>}
            <span data-quote-field={0}>
              <Marked text={shot.action} ranges={marksAt(0)} />
            </span>
          </p>
          {shot.script.map((line, i) => (
            // Keyed by position: a shot can repeat the same line.
            <div
              key={i}
              className={`dir-sc-line${line.speaker === null ? " dir-sc-line--narration" : ""}`}
            >
              {line.speaker !== null && (
                <span className="dir-sc-speaker dir-sc-unquotable">{line.speaker}</span>
              )}
              {line.acting && (
                <span className="dir-sc-acting" data-quote-field={1 + i * 2}>
                  <Marked text={line.acting} ranges={marksAt(1 + i * 2)} />
                </span>
              )}
              <span className="dir-sc-text" data-quote-field={2 + i * 2}>
                <Marked text={line.text} ranges={marksAt(2 + i * 2)} />
              </span>
            </div>
          ))}
          {shot.telop.map((text, j) => (
            <p key={j} className="dir-sc-aside-line">
              <span className="dir-sc-label dir-sc-unquotable">Telop</span>
              <span data-quote-field={1 + shot.script.length * 2 + j}>
                <Marked text={text} ranges={marksAt(1 + shot.script.length * 2 + j)} />
              </span>
            </p>
          ))}
          {shot.cutin && (
            <p className="dir-sc-aside-line dir-sc-unquotable">
              <span className="dir-sc-label">Cutin</span>
              {[shot.cutin.setup, ...shot.cutin.lineup].join(" · ")}
            </p>
          )}
          {open && <ShotStaging shot={shot} />}
        </div>
        <div className="dir-sc-notes">{ctx.renderNotes(shot)}</div>
      </div>
    </>
  );
}

// Where the shot is taken from and who it holds, folded under its action.
function ShotStaging({ shot }: { shot: DirectionShotInfo }): React.ReactElement {
  const hasLineup = shot.lineup.length > 0 || shot.lineupTo.length > 0 || shot.passing.length > 0;
  return (
    <dl className="dir-sc-staging dir-sc-unquotable">
      {(shot.roleFunctionLabel || shot.aside) && (
        <>
          <dt>Does</dt>
          <dd>{shot.aside ? "aside" : shot.roleFunctionLabel}</dd>
        </>
      )}
      <dt>Where</dt>
      <dd>
        {shot.graphic ? (
          <span className="dir-framing dir-framing--graphic">graphic</span>
        ) : (
          <Frame location={shot.location} framing={shot.framing} setup={shot.setup} />
        )}
        {shot.coverage && (
          <span className="dir-coverage">coverage · the model cuts after this frame</span>
        )}
      </dd>
      {/* The jumps head the shot in the script; an unbroken take into it is only told here. */}
      {shot.join === "continuous" && (
        <>
          <dt>Join</dt>
          <dd>continuous from the shot before</dd>
        </>
      )}
      {hasLineup && (
        <>
          <dt>Lineup (L→R)</dt>
          <dd>
            {shot.lineup.length > 0 && <Lineup names={shot.lineup} />}
            {shot.lineupTo.length > 0 && <Lineup names={shot.lineupTo} exit />}
            {shot.passing.length > 0 && <span>passing: {shot.passing.join(" · ")}</span>}
          </dd>
        </>
      )}
      {shot.cutin && (
        <>
          <dt>Cutin{shot.cutin.join ? ` · ${JOIN_LABEL[shot.cutin.join]}` : ""}</dt>
          <dd>
            <Frame
              location={shot.cutin.location}
              framing={shot.cutin.framing}
              setup={shot.cutin.setup}
            />
            {shot.cutin.lineup.length > 0 && <Lineup names={shot.cutin.lineup} />}
            {shot.cutin.lineupTo.length > 0 && <Lineup names={shot.cutin.lineupTo} exit />}
            {shot.cutin.passing.length > 0 && (
              <span>passing: {shot.cutin.passing.join(" · ")}</span>
            )}
          </dd>
        </>
      )}
    </dl>
  );
}

function Marked({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly MarkRange[];
}): React.ReactElement {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={i} className="dir-sc-mark">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

// A span as the direction wrote it: seconds, or on the song beats and the bars they make in the read
// take's meter, with the seconds they land on beneath — both absent while no take is read.
function Span({
  seconds,
  beats,
}: {
  seconds: number | null;
  beats: number | null;
}): React.ReactElement {
  const song = useContext(SongMeterContext);
  const sec = seconds === null ? null : formatSeconds(seconds, 2);
  if (beats === null || song === null) return <>{sec}</>;
  const bars = song.beatsPerBar === null ? null : Number((beats / song.beatsPerBar).toFixed(2));
  const gloss = [bars === null ? null : `${bars} bar${bars === 1 ? "" : "s"}`, sec].filter(
    (part) => part !== null,
  );
  return (
    <>
      {beats}
      {gloss.length > 0 && <span className="direction-policy-gloss">{gloss.join(" · ")}</span>}
    </>
  );
}

// A camera frame's place, size and setup — the shot's own, or its cutin's.
function Frame({
  location,
  framing,
  setup,
}: {
  location: string | null;
  framing: DirectionShotInfo["framing"];
  setup: string | null;
}): React.ReactElement {
  return (
    <>
      {location && <span className="dir-location">{location}</span>}
      {(framing || setup) && (
        <span className="dir-setup-line">
          {framing && <span className={`dir-framing dir-framing--${framing}`}>{framing}</span>}
          {setup && <span className="dir-setup">{setup}</span>}
        </span>
      )}
    </>
  );
}

// One frame's order, name by name. Each name carries its own separator so a list too long for its
// line breaks AFTER a slash rather than starting a line with one.
function Lineup({ names, exit }: { names: string[]; exit?: boolean }): React.ReactElement {
  return (
    <span className={`dir-lineup${exit ? " dir-lineup--to" : ""}`}>
      {names.map((name, i) => (
        <span key={i} className="dir-lineup-name">
          {name}
        </span>
      ))}
    </span>
  );
}

// Every leaf shot under a node, in order — a leaf act yields its shots, a branch act flattens its
// children — so an act row can sum the time it owns however deep it nests.
function collectShots(node: DirectionSequenceInfo): DirectionShotInfo[] {
  return node.shots ?? (node.sequences ?? []).flatMap(collectShots);
}

function SequenceSummary({
  sequence,
  parentPleasure,
}: {
  sequence: DirectionSequenceInfo;
  parentPleasure: string;
}): React.ReactElement {
  // Every act names the feeling it aims for, so most repeat the one above them and one — the act
  // that turns the piece — does not. Both are stated (an act whose feeling the reader has to derive
  // from the tree is one they cannot argue with), but the turn says so in words and carries the
  // gloss, so the eye lands on it without the page relying on colour to make the point.
  const shifts = sequence.pleasure.name !== parentPleasure;
  return (
    <span className="dir-seq-cell">
      {sequence.roleFunctionLabel && (
        <span className={`dir-role dir-role--seq direction-fn--${sequence.beatFunction}`}>
          {sequence.roleFunctionLabel}
        </span>
      )}
      <span className="dir-col-syn">{sequence.synopsis}</span>
      {/* Trails the synopsis: what the act *is* reads before what it is chasing. */}
      <span className={`dir-seq-pleasure${shifts ? " dir-seq-pleasure--shift" : ""}`}>
        <span className="dir-inline-label">{shifts ? "Shifts to" : "Aiming for"}</span>
        {sequence.pleasure.name}
        {shifts && <span className="dir-seq-pleasure-gloss">{sequence.pleasure.gloss}</span>}
      </span>
    </span>
  );
}

function SequenceSpan({ sequence }: { sequence: DirectionSequenceInfo }): React.ReactElement {
  const shots = collectShots(sequence);
  return (
    <Span
      seconds={shots.reduce<number | null>(
        (acc, s) => (acc === null || s.duration === null ? null : acc + s.duration),
        0,
      )}
      beats={shots.reduce<number | null>(
        (acc, s) => (acc === null || s.beats === null ? null : acc + s.beats),
        0,
      )}
    />
  );
}
