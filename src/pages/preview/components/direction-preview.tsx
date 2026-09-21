import type React from "react";
import { Fragment, useCallback, useMemo, useState } from "react";
import { submitDirectionReview } from "../api.js";
import { bulkAcceptState } from "../review/bulk-accept.js";
import { ReviewShell, type ShortcutRows } from "../review/review-shell.js";
import { commentedAddresses } from "../review/undecided.js";
import { type SubmitInput, useReviewSession } from "../review/use-review-session.js";
import { useReviewShortcuts } from "../review/use-review-shortcuts.js";
import { DIRECTION_SECTIONS } from "../types.js";
import type {
  DirectionBriefField,
  DirectionBriefFieldInfo,
  DirectionBriefListField,
  DirectionCharacterInfo,
  DirectionLandmarkInfo,
  DirectionLocationInfo,
  DirectionSetupInfo,
  DirectionPartInfo,
  DirectionPolicyFieldInfo,
  DirectionPreviewState,
  DirectionPropInfo,
  DirectionSection,
  DirectionSectionStatus,
  DirectionSequenceInfo,
  DirectionVoiceInfo,
  DirectionShotInfo,
  DirectionWaiverInfo,
} from "../types.js";
import { CommentThread } from "./comment-thread.js";
import { DirectionMap } from "./direction-map.js";
import { CheckIcon } from "./icons.js";
import { ReviewHeaderActions } from "./review-header-actions.js";
import { StatusBadge } from "./status-badge.js";

// The same keys the other review pages use, over this page's accept unit — the section. A reviewer
// who learned J/K/A/N on the animatic should not have to learn them again here.
const SHORTCUTS: ShortcutRows = [
  [["J", "K"], "Previous / next section"],
  [["A"], "Accept / un-accept the focused section"],
  [["N"], "Jump to next undecided section"],
  [["S"], "Toggle hide-stale notes"],
  [["?"], "Toggle this shortcuts panel"],
  [["⌘/Ctrl", "⏎"], "Submit review"],
];

// A reviewer's staged verdicts, one per box they settled this session. A box they left alone is
// absent, not false — leaving the characters box untouched must not revoke last week's sign-off on it.
type StagedDecisions = Partial<Record<DirectionSection, boolean>>;

// Each box's heading, and how the submit confirmation names it. One table so the two always agree —
// a dialog naming a box the reviewer cannot find on the page is worse than no dialog.
const SECTION_LABELS: Record<DirectionSection, string> = {
  brief: "Brief",
  policy: "Policy",
  characters: "Characters",
  props: "Props",
  locations: "Locations & Setups",
  shots: "Flow & Shots",
  waivers: "Rules the author chose to break",
};

// The page-wide badge, read off the boxes: signed off wholesale, or not. A stale box is called out
// on the box itself (a "Changed" tag), so the header names only the one whole-page state a reviewer
// cannot infer part by part — everything accepted. Reviewing *is* the un-accepted state, so a
// direction still being read gets no badge.
function acceptanceBadge(
  sections: DirectionPreviewState["sections"],
): { status: string; label: string } | null {
  const statuses = Object.values(sections);
  if (statuses.every((s) => s === "accepted")) return { status: "accepted", label: "Accepted" };
  return null;
}

export function DirectionPreview({ state }: { state: DirectionPreviewState }): React.ReactElement {
  // The shot last picked on the direction map — its row below is highlighted and scrolled to.
  const [focusedShotId, setFocusedShotId] = useState<string | null>(null);
  // The verdicts staged so far. They ride with the notes to a single submit rather than saving on
  // click: a reviewer's Accept on the characters and their note on shot 3 are one act of review, and
  // splitting them would let the sign-off land while the note it was conditioned on is still typed.
  const [decisions, setDecisions] = useState<StagedDecisions>({});
  const decisionCount = Object.keys(decisions).length;
  // The box the keyboard acts on. An index into the sections the page actually renders, so J/K walk
  // the boxes the reviewer can see rather than the ones the vocabulary happens to name.
  const [focusIdx, setFocusIdx] = useState(0);

  const session = useReviewSession({ hasExtraChanges: decisionCount > 0 });

  const decide = useCallback((section: DirectionSection, accept: boolean) => {
    setDecisions((prev) => ({ ...prev, [section]: accept }));
  }, []);

  const handleSelectShot = useCallback((id: string) => {
    setFocusedShotId(id);
    document
      .querySelector(`[data-shot-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // One submit for the whole review: the notes written, and the verdict on each box that was
  // settled. `reviewedHash` is the direction the reviewer actually read — the server refuses an
  // Accept against a version edited out from under the page.
  const submitReview = useCallback(
    async ({ addedFeedback, feedbackPatches, overallComment }: SubmitInput) => {
      await submitDirectionReview({
        addedFeedback: addedFeedback.map(({ address, text, annotation }) => ({
          address,
          text,
          annotation,
          displayedVariants: {},
        })),
        feedbackPatches,
        sectionDecisions: decisions,
        reviewedHash: state.directionHash,
        ...(overallComment ? { overallComment } : {}),
      });
    },
    [state.directionHash, decisions],
  );
  const handleSubmit = session.openSubmit;

  // Every table's Notes column holds the part's live thread — nothing to unfold, so the whole
  // review (what was written where, and where nothing was) is legible in one pass.
  const renderNotes = useCallback(
    (part: DirectionPartInfo) => (
      <CommentThread
        feedback={part.feedback}
        pendingFeedback={session.pendingFeedback[part.address] ?? []}
        pendingPin={null}
        handoffNotes={
          part.handoffNote ? [{ assetName: part.address, text: part.handoffNote }] : undefined
        }
        hideStale={session.hideStale}
        deletedFeedbackIds={session.deletedFeedbackIds}
        editedTextById={session.editedTextById}
        onAddPending={(text) => session.addPending(part.address, text)}
        onRemovePending={(id) => session.removePending(part.address, id)}
        onEditPending={(id, text) => session.editPending(part.address, id, text)}
        onEditExisting={(id, text) => session.editExisting(id, part.address, text)}
        onDeleteExisting={(id) => session.deleteExisting(id, part.address)}
        onCancelPin={() => {}}
      />
    ),
    [session],
  );

  const badge = acceptanceBadge(state.sections);

  // Every part on the page, grouped under the box it is reviewed in — the section is what a verdict
  // is about, so it is also what "undecided" has to be measured over.
  const partsBySection = useMemo(() => {
    const out = new Map<DirectionSection, DirectionPartInfo[]>();
    const add = (section: DirectionSection, ...parts: DirectionPartInfo[]) => {
      out.set(section, [...(out.get(section) ?? []), ...parts]);
    };
    const walk = (seq: DirectionSequenceInfo): void => {
      add("shots", seq, ...(seq.shots ?? []));
      for (const child of seq.sequences ?? []) walk(child);
    };
    add("brief", ...state.brief);
    add("policy", ...state.policy);
    // The cast is one box: each character, the voice cast for them, and the narrator — every one a
    // part of its own, all decided by the Characters box's single Accept.
    add(
      "characters",
      ...state.characters.flatMap((c) => (c.voice ? [c, c.voice] : [c])),
      ...(state.narrator ? [state.narrator] : []),
    );
    add("props", ...state.props);
    // The places and the frames taken in them are one box (see `directionSectionOf`): a setup is a
    // camera position IN a location, so its verdict is part of the verdict on that set.
    add("locations", ...state.locations, ...state.setups);
    add("shots", state.sequence);
    add("waivers", ...state.waivers);
    if (state.kind === "sequenced") for (const seq of state.sequences ?? []) walk(seq);
    else add("shots", ...(state.shots ?? []));
    return out;
  }, [state]);

  // The boxes the page renders — the ones a reviewer can form a verdict on. A section with no rows
  // is normally not one (an empty roster, a direction with no waivers): there is nothing in it to sign
  // off, and a decision on it would land in the review record as a verdict about a box nobody saw.
  //
  // Unless it is not accepted — which, with no rows, means the section held something the human
  // signed off and the author has since cut. That still needs their verdict, and this box is the
  // only thing that can record it: skip it and the spend gate stays shut with nothing on the page
  // to open it.
  const shownSections = useMemo(
    () =>
      DIRECTION_SECTIONS.filter(
        (s) => (partsBySection.get(s)?.length ?? 0) > 0 || state.sections[s] !== "accepted",
      ),
    [partsBySection, state.sections],
  );

  // What a box will read as once this review is submitted — the staged verdict, else where it
  // stands now. The Accept toggle, "Accept all" and the undecided list must all agree on this, or
  // the page would offer to accept what it is already showing as accepted.
  const isAcceptedWith = useCallback(
    (section: DirectionSection, marks: Record<string, boolean>) =>
      marks[section] ?? state.sections[section] === "accepted",
    [state.sections],
  );
  const isAccepted = useCallback(
    (section: DirectionSection) => isAcceptedWith(section, decisions),
    [isAcceptedWith, decisions],
  );

  // The boxes "Accept all" would still move, and whether it would move anything — the header's
  // "Next" count and the button's own label. See bulk-accept.ts.
  const {
    pending: unacceptedSections,
    done: everythingAccepted,
    apply: acceptAllDecisions,
  } = useMemo(
    () =>
      bulkAcceptState(
        shownSections,
        decisions,
        (section, marks) => ({ ...marks, [section]: true }),
        isAcceptedWith,
      ),
    [shownSections, decisions, isAcceptedWith],
  );
  const unacceptedCount = unacceptedSections.length;

  // Stage every box to accept. Nothing persists until Submit, so no confirm dialog — each box stays
  // individually reversible, and Reset drops the lot.
  const handleAcceptAll = useCallback(() => {
    setDecisions(acceptAllDecisions);
  }, [acceptAllDecisions]);

  const scrollToSection = useCallback((section: DirectionSection) => {
    document
      .querySelector(`[data-section="${section}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const moveFocus = useCallback(
    (delta: number) => {
      const next = Math.min(Math.max(focusIdx + delta, 0), shownSections.length - 1);
      setFocusIdx(next);
      const section = shownSections[next];
      if (section) scrollToSection(section);
    },
    [focusIdx, shownSections, scrollToSection],
  );

  // "N" walks to the next box still needing a verdict, wrapping — the reviewer's loop is "what's
  // left", and an unaccepted box is exactly that whether or not they have written a note on it.
  const handleJumpToUndecided = useCallback(() => {
    for (let i = 1; i <= shownSections.length; i++) {
      const idx = (focusIdx + i) % shownSections.length;
      const section = shownSections[idx];
      if (section && !isAccepted(section)) {
        setFocusIdx(idx);
        scrollToSection(section);
        return;
      }
    }
  }, [shownSections, focusIdx, isAccepted, scrollToSection]);

  // The boxes left with neither an accept nor a live note — named once at Submit, since the record
  // would show them unaccepted with no reason, which is indistinguishable from never having been
  // read (see review/undecided.ts). A pause, never a block: the direction stays blocked either way,
  // and forcing a verdict here would only buy a rubber-stamp accept.
  const undecided = useMemo(() => {
    const commented = commentedAddresses(
      [...partsBySection.values()].flat().flatMap((p) => p.feedback),
      session,
    );
    return shownSections
      .filter(
        (section) =>
          !isAccepted(section) &&
          !(partsBySection.get(section) ?? []).some((p) => commented.has(p.address)),
      )
      .map((section) => SECTION_LABELS[section]);
  }, [partsBySection, shownSections, isAccepted, session]);

  useReviewShortcuts({
    blocked: session.submitOpen,
    onSubmit: handleSubmit,
    handlers: {
      j: () => moveFocus(1),
      k: () => moveFocus(-1),
      a: () => {
        const section = shownSections[focusIdx];
        if (section) decide(section, !isAccepted(section));
      },
      n: handleJumpToUndecided,
      s: () => session.setHideStale(!session.hideStale),
    },
  });

  const sectionBox = (
    title: string,
    section: DirectionSection,
    children: React.ReactNode,
    lede?: React.ReactNode,
  ) => (
    <SectionBox
      title={title}
      section={section}
      status={state.sections[section]}
      staged={decisions[section]}
      accepted={isAccepted(section)}
      gating={state.gatingSections.includes(section)}
      focused={shownSections[focusIdx] === section}
      onDecide={decide}
      onFocus={() => setFocusIdx(shownSections.indexOf(section))}
      lede={lede}
    >
      {children}
    </SectionBox>
  );

  return (
    <ReviewShell
      error={session.error}
      onDismissError={() => session.setError(null)}
      handoffSummary={state.handoffSummary}
      hideStale={session.hideStale}
      onToggleHideStale={() => session.setHideStale(!session.hideStale)}
      shortcuts={SHORTCUTS}
      headerExtra={
        <>
          {badge && <StatusBadge status={badge.status} label={badge.label} />}
          <ReviewHeaderActions
            next={{ count: unacceptedCount, noun: "section", onClick: handleJumpToUndecided }}
            acceptAll={{
              done: everythingAccepted,
              what: "every section",
              onClick: handleAcceptAll,
            }}
            reset={{
              disabled: !session.hasPendingChanges,
              discards: "every accept mark and draft note",
              onClick: () => {
                setDecisions({});
                session.reset();
              },
            }}
          />
        </>
      }
      submitting={session.submitting}
      submitted={session.submitted}
      submittedTitle="Direction Review Submitted"
      canSubmit={session.hasPendingChanges}
      submitHint="Nothing to submit yet. Accept a section, leave a note, or write an overall comment above."
      onSubmit={handleSubmit}
      undecided={undecided}
      submitOpen={session.submitOpen}
      overallComment={session.overallComment}
      onOverallCommentChange={session.setOverallComment}
      onConfirmSubmit={() => void session.confirmSubmit(submitReview)}
      onCancelSubmit={session.cancelSubmit}
    >
      <div className="direction-preview">
        {shownSections.includes("brief") &&
          sectionBox(
            "Brief",
            "brief",
            <DirectionBrief fields={state.brief} renderNotes={renderNotes} />,
          )}

        {shownSections.includes("policy") &&
          sectionBox(
            "Policy",
            "policy",
            <DirectionPolicy fields={state.policy} renderNotes={renderNotes} />,
          )}

        {shownSections.includes("characters") &&
          sectionBox(
            "Characters",
            "characters",
            state.characters.length > 0 || state.narrator ? (
              <DirectionCharacters
                characters={state.characters}
                narrator={state.narrator}
                renderNotes={renderNotes}
              />
            ) : (
              <CutSectionNote what="characters" />
            ),
          )}

        {shownSections.includes("props") &&
          sectionBox(
            "Props",
            "props",
            state.props.length > 0 ? (
              <DirectionProps props={state.props} renderNotes={renderNotes} />
            ) : (
              <CutSectionNote what="props" />
            ),
          )}

        {shownSections.includes("locations") &&
          sectionBox(
            "Locations & Setups",
            "locations",
            state.locations.length > 0 || state.setups.length > 0 ? (
              <DirectionLocations
                locations={state.locations}
                setups={state.setups}
                renderNotes={renderNotes}
              />
            ) : (
              <CutSectionNote what="locations" />
            ),
          )}

        {/* Flow and Shots are one box: the flow is the shape a person without craft vocabulary can
            review (where the piece rises, where it lands, how long each shot holds, the feeling it
            chases), and the table is those same shots in detail. Splitting a shot re-shapes the flow,
            so they are inseparable — one arc note lives on the direction map, one Accept covers both. */}
        {sectionBox(
          "Flow & Shots",
          "shots",
          <>
            <p className="direction-pleasure">
              <span className="dir-inline-label">Aiming for</span>
              <span className="direction-pleasure-name">{state.pleasure.name}</span>
              <span className="direction-pleasure-gloss">{state.pleasure.gloss}</span>
            </p>
            <DirectionMap
              kind={state.kind}
              shots={state.shots}
              sequences={state.sequences}
              focusedShotId={focusedShotId}
              onSelectShot={handleSelectShot}
            />
            {renderNotes(state.sequence)}
            <table className="dir-table">
              <thead>
                <tr>
                  <th className="dir-col-id">#</th>
                  <th className="dir-col-role">Does</th>
                  <th className="dir-col-syn">Action</th>
                  <th className="dir-col-where">Where</th>
                  <th className="dir-col-lineup">Lineup (L→R)</th>
                  <th className="dir-col-dur">Dur</th>
                  <th className="dir-col-notes">Notes</th>
                </tr>
              </thead>
              <tbody>
                {state.kind === "sequenced"
                  ? (state.sequences ?? []).map((seq) => (
                      <SequenceGroup
                        key={seq.id}
                        sequence={seq}
                        depth={0}
                        parentPleasure={state.pleasure.name}
                        focusedShotId={focusedShotId}
                        renderNotes={renderNotes}
                      />
                    ))
                  : (state.shots ?? []).map((shot) => (
                      <ShotRow
                        key={shot.id}
                        shot={shot}
                        depth={0}
                        focused={focusedShotId === shot.id}
                        renderNotes={renderNotes}
                      />
                    ))}
              </tbody>
            </table>
          </>,
        )}

        {shownSections.includes("waivers") &&
          sectionBox(
            "Rules the author chose to break",
            "waivers",
            state.waivers.length > 0 ? (
              <DirectionWaivers waivers={state.waivers} renderNotes={renderNotes} />
            ) : (
              <CutSectionNote what="waivers" />
            ),
            <p className="direction-section-lede">
              The checker raised each of these and the author overruled it. Generation is not
              blocked by them. If you disagree with an argument below, say so. That is what this
              section is for.
            </p>,
          )}
      </div>
    </ReviewShell>
  );
}

type NotesRenderer = (part: DirectionPartInfo) => React.ReactElement;

// The brief is not here: like the policy, it always has rows — its two list fields are parts even
// when empty — so it can never be the box a cut emptied.
const CUT_SECTION_TEXT: Record<"characters" | "props" | "locations" | "waivers", string> = {
  characters: "The characters you accepted have been removed. This piece declares none.",
  props: "The props you accepted have been removed. This piece declares no props.",
  locations:
    "The locations and setups you accepted have been removed. This piece declares no places to shoot in.",
  waivers:
    "The waivers you accepted have been withdrawn. The author no longer overrules the checker.",
};

// A box with nothing left in it. It is on the page precisely BECAUSE it is empty: the reviewer
// signed off on what used to be here and the author has since cut it, which is a change they have
// to see and settle. Accepting is how they say "yes, that is gone" — and until they do, the spend
// gate stays shut on this section, so the box has to exist for them to say it in.
function CutSectionNote({
  what,
}: {
  what: "characters" | "props" | "locations" | "waivers";
}): React.ReactElement {
  return <p className="direction-section-cut">{CUT_SECTION_TEXT[what]}</p>;
}

// One reviewable box: its heading, the Accept that settles it, and the rows it is a verdict about —
// drawn as a single bordered card so the two are visibly one thing. The verdict sits on the box
// rather than at the foot of the page because that is the unit a person actually forms one about:
// they read the roster, decide about it, and move on. What it writes underneath is finer (one
// entry per part), so fixing one shot later re-blocks that shot alone and leaves this box's sign-off
// standing.
//
// Accepting is a toggle, not a pair of buttons: un-toggling an accepted box IS the rejection, and
// it revokes the sign-off. There is nothing a separate Reject would add — a box that is not accepted
// carries no sign-off already, and the note that says why goes in its Notes column.
function SectionBox({
  title,
  section,
  status,
  staged,
  accepted,
  gating,
  focused,
  onDecide,
  onFocus,
  lede,
  children,
}: {
  title: string;
  section: DirectionSection;
  status: DirectionSectionStatus;
  staged: boolean | undefined;
  // Whether a generation is actually waiting on this box (see `gatingSections`). Only the button's
  // wording turns on it.
  gating: boolean;
  // What the box will read as once this review is submitted (see the page's `isAccepted`) — passed
  // in rather than re-derived, so the box and the header's "Accept all" cannot disagree.
  accepted: boolean;
  focused: boolean;
  onDecide: (section: DirectionSection, accept: boolean) => void;
  // Any click inside the card moves the keyboard focus onto it (the Accept's own click bubbles
  // here too), so "A" acts on the box the reviewer is looking at rather than one they left behind
  // somewhere up the page.
  onFocus: () => void;
  lede?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    // Clicking anywhere in the card focuses it — reading a box and reaching for "A" is one motion,
    // and the reviewer should not have to hit the Accept button to say which box they mean. Focus is
    // all it does (no preventDefault, no capture), so a click on a note, a button or a text field
    // inside still behaves exactly as it would otherwise.
    //
    // `role="presentation"`: the click is a pointer shortcut for something the keyboard already
    // reaches (J/K move this focus, A acts on it), so the card must not announce itself as a control
    // — everything inside it is separately reachable, and the <h2> still carries the structure.
    <section
      role="presentation"
      className={`direction-section${focused ? " direction-section--focused" : ""}`}
      data-section={section}
      onClick={onFocus}
    >
      <div className="direction-section-headline">
        <h2 className="direction-section-title">{title}</h2>
        {/* An untouched stale box is the one state worth naming here: it was signed off, and what
            was signed off is not what the page now shows. Same "Changed" tag the other review
            pages put on a moved-since-accepted item. */}
        {staged === undefined && status === "stale" && (
          <StatusBadge status="changed" label="Changed" />
        )}
        <button
          type="button"
          className={`direction-section-accept${accepted ? " direction-section-accept--on" : ""}`}
          aria-pressed={accepted}
          onClick={() => onDecide(section, !accepted)}
          title={
            accepted
              ? gating
                ? `Un-accept ${title}: generation blocks on it until it is accepted again`
                : `Un-accept ${title}: it reads as unreviewed again (generation does not wait on it)`
              : `Accept ${title}`
          }
        >
          <CheckIcon size={13} /> {accepted ? "Accepted" : "Accept"}
        </button>
      </div>
      {lede}
      <div className="direction-section-body">{children}</div>
    </section>
  );
}

const JOIN_LABEL: Record<NonNullable<DirectionShotInfo["join"]>, string> = {
  continuous: "continuous",
  "jump-back": "time jumps back",
  "jump-forward": "time jumps forward",
};

function ShotRow({
  shot,
  depth,
  focused,
  renderNotes,
}: {
  shot: DirectionShotInfo;
  depth: number;
  focused: boolean;
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <Fragment>
      {/* The boundary is about what happens BETWEEN this shot and the one before it, not about the
          shot, so it is drawn between the rows rather than inside one. An ordinary cut draws
          nothing — it is what a boundary is unless the shot says otherwise — and a continuous one
          only fades the row rule above. */}
      {shot.join && shot.join !== "continuous" && (
        <tr className="dir-row-jump">
          <td colSpan={7}>
            <span className={`dir-jump dir-jump--${shot.join}`}>{JOIN_LABEL[shot.join]}</span>
          </td>
        </tr>
      )}
      <tr
        data-shot-id={shot.id}
        className={`dir-row${focused ? " dir-row--focused" : ""}${
          shot.join === "continuous" ? " dir-row--continues" : ""
        }`}
        style={{ "--dir-depth": depth } as React.CSSProperties}
      >
        <td className="dir-col-id">{shot.id}</td>
        <td className="dir-col-role">
          {/* An aside performs no dramatic function, so the column that would name one says what the
            row is instead — otherwise it reads as a shot whose role went missing. */}
          {shot.aside ? (
            <span className="dir-role dir-role--aside">aside</span>
          ) : (
            shot.beatFunctionLabel && (
              <span className={`dir-role direction-fn--${shot.beatFunction ?? "ground"}`}>
                {shot.beatFunctionLabel}
              </span>
            )
          )}
        </td>
        <td className="dir-col-syn">
          {shot.action}
          {shot.script.length > 0 && (
            <ul className="dir-script">
              {/* Keyed by position: a shot can repeat the same line, so the content is not unique
                — but the order is fixed by the direction. */}
              {shot.script.map((line, i) => (
                <li
                  key={i}
                  className={`dir-script-line${line.speaker === null ? " dir-script-line--narration" : ""}`}
                >
                  {line.speaker !== null && (
                    <span className="dir-script-speaker">{line.speaker}</span>
                  )}
                  <span className="dir-script-text">{line.text}</span>
                  {/* How the line is said, under the words it is said with — one line, read once by
                    the reviewer instead of reinvented by whoever writes the next take. */}
                  {line.acting && <span className="dir-script-acting">{line.acting}</span>}
                </li>
              ))}
            </ul>
          )}
          {/* Telop reads as a separate block from the script: nobody says it, so it carries no
            speaker column and is set apart rather than mixed into the lines above. */}
          {shot.telop.length > 0 && (
            <ul className="dir-script dir-telop">
              {shot.telop.map((text, i) => (
                <li key={i} className="dir-script-line dir-telop-line">
                  <span className="dir-script-text">{text}</span>
                </li>
              ))}
            </ul>
          )}
        </td>
        {/* The frame this shot is taken from, all of it in one cell: the place on top, the size and
          the setup it resolves through underneath. Both cadences are read down the column — adjacent
          rows sharing a location are one continuous set and a cut in location is a scene change;
          adjacent rows sharing a size are flat coverage — so both chips sit at
          the cell's own left edge, on lines of their own, and neither is shifted by the length of
          the other. The setup rides under the place because the coverage question ("which shots
          share a frame") is asked inside a set, not across sets. */}
        <td className="dir-col-where">
          {/* A graphic shot is taken from no camera, so the cell says what it is instead of reading
            as a shot whose frame went missing. */}
          {shot.graphic && <span className="dir-framing dir-framing--graphic">graphic</span>}
          <Frame location={shot.location} framing={shot.framing} setup={shot.setup} />
          {/* The wipe over the shot is a frame of its own, set apart under the shot's. */}
          {shot.cutin && (
            <span className="dir-cutin">
              <span className="dir-cutin-label">
                cutin{shot.cutin.join ? ` · ${JOIN_LABEL[shot.cutin.join]}` : ""}
              </span>
              <Frame
                location={shot.cutin.location}
                framing={shot.cutin.framing}
                setup={shot.cutin.setup}
              />
            </span>
          )}
        </td>
        {/* Who the frame holds, left to right — the one row on this page every prompt taken from the
          shot is held to. `lineupTo` is drawn after an arrow, so a shot the frame changes inside
          reads as a move rather than as two unrelated lists. */}
        <td className="dir-col-lineup">
          {shot.lineup.length > 0 && <Lineup names={shot.lineup} />}
          {shot.lineupTo.length > 0 && <Lineup names={shot.lineupTo} exit />}
          {shot.cutin && (shot.cutin.lineup.length > 0 || shot.cutin.lineupTo.length > 0) && (
            <span className="dir-cutin">
              <span className="dir-cutin-label">cutin</span>
              {shot.cutin.lineup.length > 0 && <Lineup names={shot.cutin.lineup} />}
              {shot.cutin.lineupTo.length > 0 && <Lineup names={shot.cutin.lineupTo} exit />}
            </span>
          )}
        </td>
        <td className="dir-col-dur">{shot.duration}s</td>
        <td className="dir-col-notes">{renderNotes(shot)}</td>
      </tr>
    </Fragment>
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

// One frame's order, name by name. Each name carries its own separator so a list too long for the
// column breaks AFTER a slash rather than starting a line with one.
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

// A sequence and everything under it: the act's own row, then its shots (a leaf act) or its child
// acts rendered recursively (a branch act), so the table mirrors the arc tree however deep it nests.
// `depth` is what makes that tree legible — every row is indented by its own level, so an act reads
// as sitting inside the act above it rather than beside it.
function SequenceGroup({
  sequence,
  depth,
  parentPleasure,
  focusedShotId,
  renderNotes,
}: {
  sequence: DirectionSequenceInfo;
  depth: number;
  parentPleasure: string;
  focusedShotId: string | null;
  renderNotes: NotesRenderer;
}): React.ReactElement {
  return (
    <Fragment>
      <SequenceRow
        sequence={sequence}
        depth={depth}
        parentPleasure={parentPleasure}
        renderNotes={renderNotes}
      />
      {sequence.shots
        ? sequence.shots.map((shot) => (
            <ShotRow
              key={shot.id}
              shot={shot}
              depth={depth + 1}
              focused={focusedShotId === shot.id}
              renderNotes={renderNotes}
            />
          ))
        : (sequence.sequences ?? []).map((child) => (
            <SequenceGroup
              key={child.id}
              sequence={child}
              depth={depth + 1}
              parentPleasure={sequence.pleasure.name}
              focusedShotId={focusedShotId}
              renderNotes={renderNotes}
            />
          ))}
    </Fragment>
  );
}

function SequenceRow({
  sequence,
  depth,
  parentPleasure,
  renderNotes,
}: {
  sequence: DirectionSequenceInfo;
  depth: number;
  parentPleasure: string;
  renderNotes: NotesRenderer;
}): React.ReactElement {
  // Every act names the feeling it aims for, so most repeat the one above them and one — the act
  // that turns the piece — does not. Both are stated (an act whose feeling the reader has to derive
  // from the tree is one they cannot argue with), but the turn says so in words and carries the
  // gloss, so the eye lands on it without the page relying on colour to make the point.
  const shifts = sequence.pleasure.name !== parentPleasure;
  return (
    <tr
      className={`dir-row-seq${depth > 0 ? " dir-row-seq--nested" : ""}`}
      style={{ "--dir-depth": depth } as React.CSSProperties}
    >
      <td className="dir-col-id">{sequence.id}</td>
      <td colSpan={4}>
        <span className="dir-seq-cell">
          {sequence.beatFunctionLabel && (
            <span className={`dir-role dir-role--seq direction-fn--${sequence.beatFunction}`}>
              {sequence.beatFunctionLabel}
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
      </td>
      <td className="dir-col-dur">
        {collectShots(sequence).reduce((acc, s) => acc + s.duration, 0)}s
      </td>
      <td className="dir-col-notes">{renderNotes(sequence)}</td>
    </tr>
  );
}

const BRIEF_FIELD_LABELS: Record<DirectionBriefField, string> = {
  logline: "Logline",
  hook: "Hook",
  audience: "Audience",
  tone: "Tone",
  look: "Look",
  outOfScope: "Out of scope",
  tolerances: "Tolerances",
};

// An empty list field still gets a row — "the piece bans nothing", "the piece tolerates nothing" is
// a position, and the reviewer's note on it is how an entry gets added.
const BRIEF_EMPTY_LIST_TEXT: Record<DirectionBriefListField, string> = {
  outOfScope: "Nothing excluded",
  tolerances: "Nothing tolerated",
};

// A name / value / notes table — the shape the brief, the policy and the props share, one part
// per row.
function DirTable({
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
          <tr key={r.key} className="dir-row">
            <td className="dir-col-name">{r.name}</td>
            <td className="dir-col-syn">{r.value}</td>
            <td className="dir-col-notes">{renderNotes(r.part)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function briefValue(f: DirectionBriefFieldInfo): React.ReactNode {
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
function DirectionBrief({
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

const SPEECH_LABELS: Record<"none" | "no-dialogue" | "free", { label: string; gloss: string }> = {
  none: { label: "None", gloss: "no spoken or narrated lines" },
  "no-dialogue": { label: "No dialogue", gloss: "narration allowed; no spoken dialogue" },
  free: { label: "Free", gloss: "any script allowed" },
};

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
    case "speech": {
      const { label, gloss } = SPEECH_LABELS[field.speech];
      return (
        <>
          {label}
          <span className="direction-policy-gloss">{gloss}</span>
        </>
      );
    }
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
  speech: "Speech",
};

// The machine-checked constraints the piece renders under — canvas, language, speech rule. Each is a
// deliberate choice in the acceptance hash (editing one re-blocks the direction), so each is reviewed
// on its own line: the reviewer can object to the speech rule without touching the canvas.
function DirectionPolicy({
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

// The characters read before the shots: a shot action names its characters, so the roster is what
// makes the shots legible rather than a footnote to them. A character's voice takes a row of its own
// because it takes its own note and its own sign-off; the stylesheet is what joins the pair back into
// one entry. The narrator closes the table as an entry of its own, with no look to describe.
function DirectionCharacters({
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
function DirectionProps({
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
function DirectionLocations({
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
          {/* What only this place has — what a setup's `holds` names and a plate's sentence must
              say. Reviewed with the place, so they carry no Accept of their own. */}
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
// — the column the shot table's size cadence is read against, with the wider frame this one is a
// window of beneath it — and `Holds` is what of the place this frame carries, left to right, which is
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

// The one place an agent overrules the checker on its own authority: each row is a rule the
// direction breaks, plus the author's argument for breaking it. Nothing here blocks generation — a
// waiver is what got the direction past the gate — so if the reviewer never reads this section, no
// one ever checked those arguments. Hence: the reasons lead, and the finding `code` (a machine
// contract, useless to a reader) is demoted to a footnote on the rule it names.
function DirectionWaivers({
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
