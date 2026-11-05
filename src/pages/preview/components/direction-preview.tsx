import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { submitDirectionReview } from "../api.js";
import { bulkAcceptState } from "../review/bulk-accept.js";
import { quotedFragments } from "../review/quote.js";
import { ReviewShell, type ShortcutRows } from "../review/review-shell.js";
import { liveFeedback } from "../review/live-feedback.js";
import { commentedAddresses } from "../review/undecided.js";
import { type SubmitInput, useReviewSession } from "../review/use-review-session.js";
import { useReviewShortcuts } from "../review/use-review-shortcuts.js";
import { DIRECTION_SECTIONS } from "../types.js";
import type {
  DirectionPartInfo,
  DirectionPreviewState,
  DirectionSection,
  DirectionSectionStatus,
  DirectionSequenceInfo,
} from "../types.js";
import { CommentThread } from "./comment-thread.js";
import { DirectionMap } from "./direction-map.js";
import { DirectionBrief } from "./direction/brief.js";
import { DirectionLyrics } from "./direction/lyrics.js";
import { DirectionPolicy } from "./direction/policy.js";
import { DirectionCharacters, DirectionLocations, DirectionProps } from "./direction/roster.js";
import { ShotScript } from "./direction/script.js";
import { DirectionWaivers } from "./direction/waivers.js";
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
  lyrics: "Lyrics",
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
  // The shot last picked on the direction map — it is highlighted below and scrolled to.
  const [focusedShotId, setFocusedShotId] = useState<string | null>(null);
  // The verdicts staged so far. They ride with the notes to a single submit rather than saving on
  // click: a reviewer's Accept on the characters and their note on shot 3 are one act of review, and
  // splitting them would let the sign-off land while the note it was conditioned on is still typed.
  const [decisions, setDecisions] = useState<StagedDecisions>({});
  const decisionCount = Object.keys(decisions).length;
  // The box the keyboard acts on. An index into the sections the page actually renders, so J/K walk
  // the boxes the reviewer can see rather than the ones the vocabulary happens to name.
  const [focusIdx, setFocusIdx] = useState(0);
  const [stagingOpen, setStagingOpen] = useState<Record<string, boolean>>({});

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

  // Every part's notes hold its live thread — nothing to unfold, so the whole
  // review (what was written where, and where nothing was) is legible in one pass.
  const renderNotes = useCallback(
    (part: DirectionPartInfo) => (
      <CommentThread
        feedback={part.feedback}
        thread={session.threadFor(part.address)}
        pendingPin={null}
        handoffNotes={part.handoffNote ? [part.handoffNote] : undefined}
        onCancelPin={() => {}}
      />
    ),
    [session],
  );

  // The words the part's live comments quote, for the script to mark where they still stand.
  const quotesFor = useCallback(
    (part: DirectionPartInfo) =>
      quotedFragments(
        [
          ...liveFeedback(part.feedback, session).map(
            (f) => session.editedTextById.get(f.id) ?? f.text,
          ),
          ...(session.pendingFeedback[part.address] ?? []).map((p) => p.text),
        ],
        false,
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
    if (state.lyrics) add("lyrics", state.lyrics);
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

  // The shown boxes an Accept can sign off; the rest are read-only until the author fills them.
  const acceptableSections = useMemo(
    () => shownSections.filter((s) => state.acceptableSections.includes(s)),
    [shownSections, state.acceptableSections],
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
        acceptableSections,
        decisions,
        (section, marks) => ({ ...marks, [section]: true }),
        isAcceptedWith,
      ),
    [acceptableSections, decisions, isAcceptedWith],
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
      if (section && acceptableSections.includes(section) && !isAccepted(section)) {
        setFocusIdx(idx);
        scrollToSection(section);
        return;
      }
    }
  }, [shownSections, acceptableSections, focusIdx, isAccepted, scrollToSection]);

  // The boxes left with neither an accept nor a live note — named once at Submit, since the record
  // would show them unaccepted with no reason, which is indistinguishable from never having been
  // read (see review/undecided.ts). A pause, never a block: the direction stays blocked either way,
  // and forcing a verdict here would only buy a rubber-stamp accept.
  const undecided = useMemo(() => {
    const commented = commentedAddresses(
      [...partsBySection.values()].flat().flatMap((p) => p.feedback),
      session,
    );
    return acceptableSections
      .filter(
        (section) =>
          !isAccepted(section) &&
          !(partsBySection.get(section) ?? []).some((p) => commented.has(p.address)),
      )
      .map((section) => SECTION_LABELS[section]);
  }, [partsBySection, acceptableSections, isAccepted, session]);

  useReviewShortcuts({
    blocked: session.submitOpen,
    onSubmit: handleSubmit,
    handlers: {
      j: () => moveFocus(1),
      k: () => moveFocus(-1),
      a: () => {
        const section = shownSections[focusIdx];
        if (section && acceptableSections.includes(section)) decide(section, !isAccepted(section));
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
      acceptable={acceptableSections.includes(section)}
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

        {shownSections.includes("lyrics") &&
          sectionBox(
            "Lyrics",
            "lyrics",
            state.lyrics ? (
              <DirectionLyrics lyrics={state.lyrics} renderNotes={renderNotes} />
            ) : (
              <CutSectionNote what="lyrics" />
            ),
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
            chases), and the script is those same shots in detail. Splitting a shot re-shapes the flow,
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
            <ShotScript
              kind={state.kind}
              shots={state.shots}
              sequences={state.sequences}
              song={state.song}
              rootPleasure={state.pleasure.name}
              focusedShotId={focusedShotId}
              renderNotes={renderNotes}
              quotesFor={quotesFor}
              isStagingOpen={(id) => stagingOpen[id] ?? false}
              onToggleStaging={(id) => setStagingOpen((prev) => ({ ...prev, [id]: !prev[id] }))}
              onAddComment={(address, text) => session.addPending(address, text)}
            />
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

// The brief is not here: like the policy, it always has rows — its two list fields are parts even
// when empty — so it can never be the box a cut emptied.
const CUT_SECTION_TEXT: Record<
  "lyrics" | "characters" | "props" | "locations" | "waivers",
  string
> = {
  lyrics: "The lyrics you accepted have been removed. This piece declares no song words.",
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
  what: "lyrics" | "characters" | "props" | "locations" | "waivers";
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
  acceptable,
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
  // False while the box has nothing to sign off yet (Flow & Shots before any shot is written).
  acceptable: boolean;
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
          disabled={!acceptable}
          onClick={() => onDecide(section, !accepted)}
          title={
            !acceptable
              ? `${title} has no shots yet: write them in direction.ts, then accept`
              : accepted
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
