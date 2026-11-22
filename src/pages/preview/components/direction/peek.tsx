import type React from "react";

import { formatTimecode } from "../../format-time.js";
import type {
  DirectionCharacterInfo,
  DirectionLocationInfo,
  DirectionPartInfo,
  DirectionPreviewState,
  DirectionSequenceInfo,
  DirectionSetupInfo,
  DirectionShotInfo,
} from "../../../../core/types/review-state.js";
import { DirectionMap } from "../direction-map.js";
import { ChevronsRightIcon } from "../icons.js";
import type { NotesRenderer } from "./dir-table.js";
import { PartMarkTag } from "./marks.js";

type Peeked =
  | { kind: "flow"; part: DirectionPartInfo }
  | { kind: "character"; part: DirectionCharacterInfo }
  | { kind: "narrator"; part: DirectionPartInfo & { description: string } }
  | { kind: "prop"; part: DirectionPartInfo & { name: string; description: string } }
  | { kind: "location"; part: DirectionLocationInfo }
  | { kind: "setup"; part: DirectionSetupInfo };

const KIND_LABEL: Record<Peeked["kind"], string> = {
  flow: "Flow",
  character: "Character",
  narrator: "Voice",
  prop: "Prop",
  location: "Place",
  setup: "Setup",
};

function peekedOf(state: DirectionPreviewState, address: string): Peeked | null {
  if (state.sequence.address === address) return { kind: "flow", part: state.sequence };
  if (state.narrator?.address === address) return { kind: "narrator", part: state.narrator };
  const character = state.characters.find((c) => c.address === address);
  if (character) return { kind: "character", part: character };
  const prop = state.props.find((p) => p.address === address);
  if (prop) return { kind: "prop", part: prop };
  const location = state.locations.find((l) => l.address === address);
  if (location) return { kind: "location", part: location };
  const setup = state.setups.find((s) => s.address === address);
  return setup ? { kind: "setup", part: setup } : null;
}

interface PeekContext {
  state: DirectionPreviewState;
  shots: readonly DirectionShotInfo[];
  // The shots showing each roster part, by part address.
  appearances: ReadonlyMap<string, readonly string[]>;
  renderNotes: NotesRenderer;
  focusedShotId: string | null;
  onPeek: (address: string) => void;
  onJumpPart: (address: string) => void;
  onJumpShot: (shotId: string) => void;
}

// One part read at full width over the script: a roster entry, or the piece as a whole. It stays
// mounted while shut, holding the part it last showed, so it slides both ways.
export function DirectionPeek({
  address,
  open,
  onClose,
  ...ctx
}: {
  address: string | null;
  open: boolean;
  onClose: () => void;
} & PeekContext): React.ReactElement {
  const peeked = address === null ? null : peekedOf(ctx.state, address);
  if (!peeked) return <aside className="dir-peek" aria-hidden="true" />;
  const title =
    peeked.kind === "flow"
      ? "Whole piece"
      : peeked.kind === "narrator"
        ? "Narrator"
        : peeked.part.name;
  return (
    <aside
      className={`dir-peek${peeked.kind === "flow" ? " dir-peek--wide" : ""}${
        open ? " dir-peek--open" : ""
      }`}
      aria-label={title}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="dir-peek-bar">
        <button
          type="button"
          className="dir-icon-btn"
          onClick={onClose}
          aria-label="Close the panel"
          title="Close (Esc)"
        >
          <ChevronsRightIcon size={16} />
        </button>
        <span className="dir-peek-kind">{KIND_LABEL[peeked.kind]}</span>
      </div>
      <div key={peeked.part.address} className="dir-peek-scroll dir-scroll">
        <h2 className="dir-peek-title">
          {title} <PartMarkTag address={peeked.part.address} />
        </h2>
        <PeekBody peeked={peeked} ctx={ctx} />
        <Section title="Notes">{ctx.renderNotes(peeked.part)}</Section>
      </div>
    </aside>
  );
}

function PeekBody({ peeked, ctx }: { peeked: Peeked; ctx: PeekContext }): React.ReactElement {
  const { state } = ctx;
  switch (peeked.kind) {
    case "flow": {
      const total = ctx.shots.reduce<number | null>(
        (acc, s) => (acc === null || s.duration === null ? null : acc + s.duration),
        0,
      );
      return (
        <>
          <dl className="dir-peek-props">
            <Property label="Aiming for">
              {state.pleasure.name}: {state.pleasure.gloss}
            </Property>
            <Property label="Shots">{ctx.shots.length}</Property>
            {total !== null && <Property label="Runs">{formatTimecode(total)}</Property>}
          </dl>
          <DirectionMap
            kind={state.kind}
            shots={state.shots}
            sequences={state.sequences}
            focusedShotId={ctx.focusedShotId}
            onSelectShot={ctx.onJumpShot}
          />
          {(state.sequences ?? []).length > 0 && (
            <Section title="Acts">
              {(state.sequences ?? []).map((seq) => (
                <ActLink key={seq.id} sequence={seq} depth={0} ctx={ctx} />
              ))}
            </Section>
          )}
        </>
      );
    }
    case "narrator":
      return <p className="dir-peek-text">{peeked.part.description}</p>;
    case "character": {
      const { voice } = peeked.part;
      return (
        <>
          <p className="dir-peek-text">{peeked.part.description}</p>
          {voice && (
            <Section
              title={
                <>
                  Voice <PartMarkTag address={voice.address} />
                </>
              }
            >
              <p className="dir-peek-text">{voice.description}</p>
              {ctx.renderNotes(voice)}
            </Section>
          )}
          <Appearances part={peeked.part} ctx={ctx} />
        </>
      );
    }
    case "prop":
      return (
        <>
          <p className="dir-peek-text">{peeked.part.description}</p>
          <Appearances part={peeked.part} ctx={ctx} />
        </>
      );
    case "location": {
      const location = peeked.part;
      const setups = state.setups.filter((s) => s.locationId === location.id);
      return (
        <>
          <p className="dir-peek-text">{location.description}</p>
          {location.landmarks.length > 0 && (
            <Section title="Landmarks">
              <dl className="dir-peek-list">
                {location.landmarks.map((m) => (
                  <div key={m.id}>
                    <dt>{m.name}</dt>
                    <dd>{m.description}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}
          {location.views.length > 1 && (
            <Section title="Views">
              <dl className="dir-peek-list">
                {location.views.map((v) => (
                  <div key={v.view}>
                    <dt>{v.view}</dt>
                    <dd>{v.holds.join(" · ") || "nothing declared"}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}
          {setups.length > 0 && (
            <Section title="Setups">
              {setups.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="dir-peek-link"
                  onClick={() => ctx.onPeek(s.address)}
                >
                  <span className={`dir-framing dir-framing--${s.framing}`}>{s.framing}</span>
                  <span className="dir-peek-link-name">{s.name}</span>
                  <PartMarkTag address={s.address} />
                  <span className="dir-peek-link-meta">
                    {ctx.appearances.get(s.address)?.length ?? 0}
                  </span>
                </button>
              ))}
            </Section>
          )}
          <Appearances part={location} ctx={ctx} />
        </>
      );
    }
    case "setup": {
      const setup = peeked.part;
      const location = state.locations.find((l) => l.id === setup.locationId);
      const parent = state.setups.find(
        (s) => s.locationId === setup.locationId && s.name === setup.within,
      );
      return (
        <>
          <dl className="dir-peek-props">
            <Property label="Size">
              <span className={`dir-framing dir-framing--${setup.framing}`}>{setup.framing}</span>
            </Property>
            <Property label="Place">
              {location ? (
                <button
                  type="button"
                  className="dir-peek-ref"
                  onClick={() => ctx.onPeek(location.address)}
                >
                  {location.name}
                </button>
              ) : (
                setup.location
              )}
            </Property>
            {setup.holds.length > 0 && <Property label="Holds">{setup.holds.join(" | ")}</Property>}
            {setup.within !== undefined && (
              <Property label="Within">
                {setup.within === null ? (
                  "root"
                ) : parent ? (
                  <button
                    type="button"
                    className="dir-peek-ref"
                    onClick={() => ctx.onPeek(parent.address)}
                  >
                    {parent.name}
                  </button>
                ) : (
                  setup.within
                )}
              </Property>
            )}
            {setup.view && <Property label="View">{setup.view}</Property>}
          </dl>
          <p className="dir-peek-text">{setup.description}</p>
          <Appearances part={setup} ctx={ctx} />
        </>
      );
    }
  }
}

function Section({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="dir-peek-section">
      <h3 className="dir-peek-heading">{title}</h3>
      {children}
    </section>
  );
}

function Property({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Appearances({
  part,
  ctx,
}: {
  part: DirectionPartInfo;
  ctx: PeekContext;
}): React.ReactElement | null {
  const shotIds = ctx.appearances.get(part.address) ?? [];
  if (shotIds.length === 0) return null;
  return (
    <Section title={`In ${shotIds.length} ${shotIds.length === 1 ? "shot" : "shots"}`}>
      <div className="dir-peek-shots">
        {shotIds.map((id) => (
          <button
            key={id}
            type="button"
            className="dir-peek-shot"
            onClick={() => ctx.onJumpShot(id)}
          >
            {id}
          </button>
        ))}
      </div>
    </Section>
  );
}

// An act of the flow, jumping to where it opens in the script.
function ActLink({
  sequence,
  depth,
  ctx,
}: {
  sequence: DirectionSequenceInfo;
  depth: number;
  ctx: PeekContext;
}): React.ReactElement {
  return (
    <>
      <button
        type="button"
        className="dir-peek-link dir-peek-act"
        style={{ paddingLeft: `${0.6 + depth * 1.2}rem` }}
        onClick={() => ctx.onJumpPart(sequence.address)}
      >
        <span className="dir-peek-act-head">
          <span className="dir-peek-link-name">{sequence.id}</span>
          <PartMarkTag address={sequence.address} />
          {sequence.roleFunctionLabel && (
            <span className={`dir-peek-link-meta direction-fn--${sequence.beatFunction}`}>
              {sequence.roleFunctionLabel}
            </span>
          )}
        </span>
        <span className="dir-peek-act-text">{sequence.synopsis}</span>
      </button>
      {(sequence.sequences ?? []).map((child) => (
        <ActLink key={child.id} sequence={child} depth={depth + 1} ctx={ctx} />
      ))}
    </>
  );
}
