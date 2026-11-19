import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { submitDirectionReview } from "../api.js";
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
  DirectionSequenceInfo,
  DirectionShotInfo,
  DirectionShotRoster,
} from "../types.js";
import { CommentThread } from "./comment-thread.js";
import { DirectionBrief } from "./direction/brief.js";
import { DirectionLyrics } from "./direction/lyrics.js";
import { PartMarksContext, partMarks } from "./direction/marks.js";
import { DirectionPeek } from "./direction/peek.js";
import { DirectionPolicy } from "./direction/policy.js";
import { DirectionRail, type RailLink } from "./direction/rail.js";
import { isNarrow } from "../review/narrow.js";
import { ShotScript } from "./direction/script.js";
import { DirectionWaivers } from "./direction/waivers.js";
import { MenuIcon } from "./icons.js";
import { type ResetAction, ResetButton, ReviewHeaderActions } from "./review-header-actions.js";

const SHORTCUTS: ShortcutRows = [
  [["J", "K"], "Next / previous shot"],
  [["N", "P"], "Next / previous part to review"],
  [["A"], "Accept / un-accept the direction"],
  [["Esc"], "Close the side panel"],
  [["S"], "Toggle hide-stale notes"],
  [["?"], "Toggle this shortcuts panel"],
  [["⌘/Ctrl", "⏎"], "Submit review"],
];

// A group of parts on the page: a section the Accept signs, or the brief, which takes notes only.
type PageSection = DirectionSection | "brief";

const SECTION_LABELS: Record<PageSection, string> = {
  brief: "Brief",
  policy: "Policy",
  lyrics: "Lyrics",
  characters: "Characters",
  props: "Props",
  locations: "Locations & Setups",
  shots: "Flow & Shots",
  waivers: "Rules the author chose to break",
};

// The sections under the script, in page order. The roster's three live in the index.
const BELOW_SECTIONS = ["lyrics", "brief", "policy", "waivers"] as const;
type BelowSection = (typeof BELOW_SECTIONS)[number];
const ROSTER_SECTIONS = ["characters", "props", "locations"] as const;

const SECTION_TARGET = "section:";

function shotsOf(state: DirectionPreviewState): DirectionShotInfo[] {
  const walk = (seq: DirectionSequenceInfo): DirectionShotInfo[] =>
    seq.shots ?? (seq.sequences ?? []).flatMap(walk);
  return state.kind === "sequenced" ? (state.sequences ?? []).flatMap(walk) : (state.shots ?? []);
}

export function DirectionPreview({ state }: { state: DirectionPreviewState }): React.ReactElement {
  const [focusedShotId, setFocusedShotId] = useState<string | null>(null);
  // The verdict staged on the page's one Accept, absent while the reviewer has not touched it. It
  // rides with the notes to a single submit.
  const [accept, setAccept] = useState<boolean | undefined>(undefined);
  // A verdict staged on the direction a reload replaced was on what the reviewer read, not on what
  // `reviewedHash` would now name.
  const [decidedHash, setDecidedHash] = useState(state.directionHash);
  if (decidedHash !== state.directionHash) {
    setDecidedHash(state.directionHash);
    setAccept(undefined);
  }
  const [stagingOpen, setStagingOpen] = useState<Record<string, boolean>>({});

  const session = useReviewSession({ hasExtraChanges: accept !== undefined });

  const shots = useMemo(() => shotsOf(state), [state]);

  // Every part on the page, by its group, in reading order.
  const partsBySection = useMemo(() => {
    const out = new Map<PageSection, DirectionPartInfo[]>();
    const add = (section: PageSection, ...parts: DirectionPartInfo[]) => {
      out.set(section, [...(out.get(section) ?? []), ...parts]);
    };
    const walk = (seq: DirectionSequenceInfo): void => {
      add("shots", seq, ...(seq.shots ?? []));
      for (const child of seq.sequences ?? []) walk(child);
    };
    add("shots", state.sequence);
    if (state.kind === "sequenced") for (const seq of state.sequences ?? []) walk(seq);
    else add("shots", ...(state.shots ?? []));
    if (state.lyrics) add("lyrics", state.lyrics);
    add("waivers", ...state.waivers);
    add("brief", ...state.brief);
    add("policy", ...state.policy);
    add(
      "characters",
      ...state.characters.flatMap((c) => (c.voice ? [c, c.voice] : [c])),
      ...(state.narrator ? [state.narrator] : []),
    );
    add("props", ...state.props);
    const declared = new Set(state.locations.map((l) => l.id));
    add(
      "locations",
      ...state.locations.flatMap((l) => [l, ...state.setups.filter((s) => s.locationId === l.id)]),
      ...state.setups.filter((s) => !declared.has(s.locationId)),
    );
    return out;
  }, [state]);
  const allParts = useMemo(() => [...partsBySection.values()].flat(), [partsBySection]);
  const marks = useMemo(() => partMarks(allParts), [allParts]);

  // The part the side panel opens for a part read in it — a voice is read inside its character.
  const entryOf = useMemo(() => {
    const out = new Map<string, string>([[state.sequence.address, state.sequence.address]]);
    for (const section of ROSTER_SECTIONS) {
      for (const part of partsBySection.get(section) ?? []) out.set(part.address, part.address);
    }
    for (const c of state.characters) if (c.voice) out.set(c.voice.address, c.address);
    return out;
  }, [partsBySection, state.characters, state.sequence.address]);
  const commented = useMemo(
    () =>
      commentedAddresses(
        allParts.flatMap((p) => p.feedback),
        session,
      ),
    [allParts, session],
  );
  const hasNotes = useCallback(
    (part: DirectionPartInfo) => commented.has(part.address) || part.handoffNote !== undefined,
    [commented],
  );

  // The shots showing each roster part, by part address.
  const appearances = useMemo(() => {
    const addressOf = {
      characters: new Map(state.characters.map((e) => [e.id, e.address])),
      props: new Map(state.props.map((e) => [e.id, e.address])),
      locations: new Map(state.locations.map((e) => [e.id, e.address])),
      setups: new Map(state.setups.map((e) => [e.id, e.address])),
    };
    const out = new Map<string, string[]>();
    for (const shot of shots) {
      for (const kind of ["characters", "props", "locations", "setups"] as const) {
        for (const id of shot.shows[kind]) {
          const address = addressOf[kind].get(id);
          if (address) out.set(address, [...(out.get(address) ?? []), shot.id]);
        }
      }
    }
    return out;
  }, [state, shots]);

  // The part the side panel is on, kept while it slides shut.
  const [peek, setPeek] = useState<string | null>(null);
  const [peekOpen, setPeekOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(() => !isNarrow());

  // Opening or closing the index re-wraps the script; the shot being read stays where it was on
  // screen.
  const held = useRef<{ el: Element; top: number } | null>(null);
  const holdPlace = useCallback(() => {
    for (const el of document.querySelectorAll(".dir-sc-shot")) {
      const { top } = el.getBoundingClientRect();
      if (top >= 0) {
        held.current = { el, top };
        return;
      }
    }
  }, []);
  useLayoutEffect(() => {
    const place = held.current;
    held.current = null;
    if (!place) return;
    const moved = place.el.getBoundingClientRect().top - place.top;
    if (moved !== 0) window.scrollBy(0, moved);
  }, [railOpen]);

  const openPeek = useCallback((address: string) => {
    setPeek(address);
    setPeekOpen(true);
    if (isNarrow()) setRailOpen(false);
  }, []);
  const closePeek = useCallback(() => setPeekOpen(false), []);

  // A click outside the panel shuts it — bar one on what opens it: the index, or a name in the script.
  useEffect(() => {
    if (!peekOpen) return;
    // The path, not target.closest: React has re-rendered by now, and a click that swapped its
    // own button out (Add note, Edit, Cancel) leaves a target detached from the panel.
    const onClick = (e: MouseEvent) => {
      const inside = e
        .composedPath()
        .some(
          (n) =>
            n instanceof Element &&
            n.matches(".dir-peek, .dir-rail, .dir-rail-toggle, .dir-roster-name"),
        );
      if (!inside) setPeekOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [peekOpen]);

  const toggleRail = useCallback(() => {
    holdPlace();
    setRailOpen((open) => !open);
  }, [holdPlace]);

  // A jump lands after the render that opens the panel on its target.
  const [revealing, setRevealing] = useState<string | null>(null);
  useEffect(() => {
    if (revealing === null) return;
    setRevealing(null);
    const section = revealing.startsWith(SECTION_TARGET);
    const el = document.querySelector<HTMLElement>(
      section
        ? `[data-section="${revealing.slice(SECTION_TARGET.length)}"]`
        : `[data-part="${CSS.escape(revealing)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({
      block: section ? "start" : el.closest(".dir-rail") ? "nearest" : "center",
    });
    el.dataset.spot = "";
    const timer = setTimeout(() => delete el.dataset.spot, 1600);
    return () => clearTimeout(timer);
  }, [revealing]);

  // Brings a part, or a whole section, into view — opening the side panel on a part read there.
  const reveal = useCallback(
    (target: string) => {
      const entry = entryOf.get(target);
      // The roster's sections are the index's own groups.
      const inRail = ROSTER_SECTIONS.some((s) => target === `${SECTION_TARGET}${s}`);
      if (entry) openPeek(entry);
      else if (inRail) {
        setRailOpen(true);
        if (isNarrow()) setPeekOpen(false);
      } else if (isNarrow()) {
        setRailOpen(false);
        setPeekOpen(false);
      }
      setRevealing(entry ?? target);
    },
    [entryOf, openPeek],
  );

  const handleSelectShot = useCallback((id: string) => {
    setFocusedShotId(id);
    if (isNarrow()) {
      setRailOpen(false);
      setPeekOpen(false);
    }
    document
      .querySelector(`[data-shot-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, []);

  const stepShot = useCallback(
    (delta: number) => {
      const at = shots.findIndex((s) => s.id === focusedShotId);
      const next = shots[at < 0 ? 0 : Math.min(Math.max(at + delta, 0), shots.length - 1)];
      if (next) handleSelectShot(next.id);
    },
    [shots, focusedShotId, handleSelectShot],
  );

  // A section whose sign-off no longer stands with no part left to show for it: one was removed.
  const trimmed = useMemo(
    () =>
      new Set(
        DIRECTION_SECTIONS.filter(
          (s) =>
            state.sections[s] === "stale" &&
            !(partsBySection.get(s) ?? []).some((p) => marks.has(p.address)),
        ),
      ),
    [state.sections, partsBySection, marks],
  );

  // What a returning reviewer came to read: the parts that moved since their accept, the author's
  // handoff notes, and the sections a part was removed from.
  const stops = useMemo(
    () => [
      ...allParts
        .filter((p) => marks.has(p.address) || p.handoffNote !== undefined)
        .map((p) => p.address),
      ...[...trimmed].map((s) => `${SECTION_TARGET}${s}`),
    ],
    [allParts, marks, trimmed],
  );
  const [stopIdx, setStopIdx] = useState(-1);
  const stepStop = useCallback(
    (delta: number) => {
      if (stops.length === 0) return;
      const next = (Math.max(stopIdx, delta > 0 ? -1 : 0) + delta + stops.length) % stops.length;
      setStopIdx(next);
      const stop = stops[next];
      if (!stop) return;
      const shot = shots.find((s) => s.address === stop);
      if (shot) setFocusedShotId(shot.id);
      reveal(stop);
    },
    [stops, stopIdx, shots, reveal],
  );

  // A name the script prints resolves among the entries that shot shows, so two entries sharing a
  // name never cross.
  const roster = useMemo(
    () => ({
      characters: new Map(state.characters.map((e) => [e.id, e])),
      props: new Map(state.props.map((e) => [e.id, e])),
      locations: new Map(state.locations.map((e) => [e.id, e])),
      setups: new Map(state.setups.map((e) => [e.id, e])),
    }),
    [state],
  );
  const openerOf = useCallback(
    (kind: keyof DirectionShotRoster, name: string, shot: DirectionShotInfo) => {
      const entry = shot.shows[kind]
        .map((id) => roster[kind].get(id))
        .find((e) => e?.name === name);
      return entry ? () => reveal(entry.address) : null;
    },
    [roster, reveal],
  );

  const { available, standing } = state.accept;
  const accepted = accept ?? standing;
  const toggleAccept = useCallback(() => {
    if (!available) return;
    setAccept((prev) => {
      const next = !(prev ?? standing);
      return next === standing ? undefined : next;
    });
  }, [available, standing]);

  // `reviewedHash` is the direction the reviewer actually read — the server refuses an Accept
  // against a version edited out from under the page.
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
        ...(accept === undefined ? {} : { accept }),
        reviewedHash: state.directionHash,
        ...(overallComment ? { overallComment } : {}),
      });
    },
    [state.directionHash, accept],
  );

  const renderNotes = useCallback(
    (part: DirectionPartInfo) => (
      <CommentThread
        address={part.address}
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

  useReviewShortcuts({
    blocked: session.submitOpen,
    onSubmit: session.openSubmit,
    handlers: {
      j: () => stepShot(1),
      k: () => stepShot(-1),
      n: () => stepStop(1),
      p: () => stepStop(-1),
      a: toggleAccept,
      Escape: closePeek,
      s: () => session.setHideStale(!session.hideStale),
    },
  });

  // A section the author emptied since it was accepted still shows.
  const isShown = (section: PageSection) =>
    (partsBySection.get(section)?.length ?? 0) > 0 ||
    (section !== "brief" && state.sections[section] !== "accepted");
  const below = BELOW_SECTIONS.filter(isShown);
  const source = state.brief.find((f) => f.field === "source");
  const links: RailLink[] = below.flatMap((section) => [
    {
      target: `${SECTION_TARGET}${section}`,
      label: SECTION_LABELS[section],
      parts: partsBySection.get(section) ?? [],
      trimmed: section !== "brief" && trimmed.has(section),
    },
    ...(section === "brief" && source
      ? [{ target: source.address, label: "Source", parts: [source], trimmed: false }]
      : []),
  ]);

  const belowBody: Record<BelowSection, React.ReactNode> = {
    lyrics: state.lyrics ? (
      <DirectionLyrics lyrics={state.lyrics} renderNotes={renderNotes} />
    ) : (
      <CutSectionNote what="lyrics" />
    ),
    waivers:
      state.waivers.length > 0 ? (
        <>
          <p className="direction-section-lede">
            The checker raised each of these and the author overruled it. Generation is not blocked
            by them. If you disagree with an argument below, say so.
          </p>
          <DirectionWaivers waivers={state.waivers} renderNotes={renderNotes} />
        </>
      ) : (
        <CutSectionNote what="waivers" />
      ),
    brief: <DirectionBrief fields={state.brief} renderNotes={renderNotes} />,
    policy: <DirectionPolicy fields={state.policy} renderNotes={renderNotes} />,
  };

  const resetAction: ResetAction = {
    disabled: !session.hasPendingChanges,
    discards: "the accept mark and every draft note",
    onClick: () => {
      setAccept(undefined);
      session.reset();
    },
  };

  return (
    <ReviewShell
      error={session.error}
      onDismissError={() => session.setError(null)}
      handoffSummary={state.handoffSummary}
      hideStale={session.hideStale}
      onToggleHideStale={() => session.setHideStale(!session.hideStale)}
      shortcuts={SHORTCUTS}
      headerExtra={
        <ReviewHeaderActions
          next={{
            count: stops.length,
            title: "Jump to the next part changed since your accept or carrying a handoff note (N)",
            onClick: () => stepStop(1),
          }}
          acceptCurrent={{
            accepted,
            what: "The direction",
            disabled: !available,
            onClick: toggleAccept,
          }}
          reset={resetAction}
        />
      }
      submitting={session.submitting}
      submitted={session.submitted}
      submittedTitle="Direction Review Submitted"
      canSubmit={session.hasPendingChanges}
      submitHint="Nothing to submit yet. Accept the direction, leave a note, or write an overall comment above."
      onSubmit={session.openSubmit}
      undecided={accepted || commented.size > 0 ? [] : ["The direction"]}
      submitOpen={session.submitOpen}
      overallComment={session.overallComment}
      onOverallCommentChange={session.setOverallComment}
      onConfirmSubmit={() => void session.confirmSubmit(submitReview)}
      onCancelSubmit={session.cancelSubmit}
    >
      <PartMarksContext.Provider value={marks}>
        <div className={`direction-preview${railOpen ? " direction-preview--rail" : ""}`}>
          <button
            type="button"
            className="dir-icon-btn dir-rail-toggle"
            onClick={toggleRail}
            aria-expanded={railOpen}
            aria-label={railOpen ? "Close the index" : "Open the index"}
            title={railOpen ? "Close the index" : "Open the index"}
          >
            <MenuIcon size={16} />
          </button>
          <button
            type="button"
            className="dir-scrim"
            aria-label="Close the index"
            tabIndex={-1}
            onClick={toggleRail}
          />
          <DirectionRail
            state={state}
            shots={shots}
            links={links}
            cut={
              new Set(ROSTER_SECTIONS.filter((s) => isShown(s) && !partsBySection.get(s)?.length))
            }
            trimmed={trimmed}
            open={railOpen}
            tools={
              <>
                <label className="review-toggle">
                  <input
                    type="checkbox"
                    checked={session.hideStale}
                    onChange={() => session.setHideStale(!session.hideStale)}
                  />
                  Hide stale notes
                </label>
                <ResetButton reset={resetAction} />
              </>
            }
            peeked={peekOpen ? peek : null}
            appearances={appearances}
            hasNotes={hasNotes}
            focusedShotId={focusedShotId}
            onPeek={openPeek}
            onJumpPart={reveal}
            onJumpShot={handleSelectShot}
          />

          <div className="dir-page">
            <section data-section="shots">
              {trimmed.has("shots") && <TrimmedNote />}
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
                openerOf={openerOf}
              />
            </section>

            {below.map((section) => (
              <section key={section} className="dir-block" data-section={section}>
                <h2 className="direction-section-title">{SECTION_LABELS[section]}</h2>
                {section !== "brief" &&
                  trimmed.has(section) &&
                  (partsBySection.get(section)?.length ?? 0) > 0 && <TrimmedNote />}
                {belowBody[section]}
              </section>
            ))}
          </div>

          <DirectionPeek
            address={peek}
            open={peekOpen}
            state={state}
            shots={shots}
            appearances={appearances}
            renderNotes={renderNotes}
            focusedShotId={focusedShotId}
            onPeek={openPeek}
            onJumpPart={reveal}
            onJumpShot={handleSelectShot}
            onClose={closePeek}
          />
        </div>
      </PartMarksContext.Provider>
    </ReviewShell>
  );
}

const CUT_SECTION_TEXT: Record<"lyrics" | "waivers", string> = {
  lyrics: "The lyrics you accepted have been removed. This piece declares no song words.",
  waivers:
    "The waivers you accepted have been withdrawn. The author no longer overrules the checker.",
};

// A section a part was removed from since it was accepted.
function TrimmedNote(): React.ReactElement {
  return (
    <p className="direction-section-cut">Something you accepted here has been removed since.</p>
  );
}

function CutSectionNote({ what }: { what: "lyrics" | "waivers" }): React.ReactElement {
  return <p className="direction-section-cut">{CUT_SECTION_TEXT[what]}</p>;
}
