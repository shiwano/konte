import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReviewSkippedError } from "../api.js";

let pendingIdCounter = 0;
function generatePendingId(): string {
  return `pending-${++pendingIdCounter}-${Date.now()}`;
}

export interface PendingFeedback {
  id: string;
  address: string;
  text: string;
  annotation: { kind: "pin"; x: number; y: number } | null;
  time?: number;
  shotId?: string;
}

export interface FeedbackPatch {
  op: "edit" | "delete";
  id: string;
  address: string;
  text?: string;
}

// What a view's submit receives: the session's drafts, to send with its own decisions.
export interface SubmitInput {
  addedFeedback: PendingFeedback[];
  feedbackPatches: FeedbackPatch[];
  // The reviewer's word on the pass as a whole, written in the submit dialog. Empty when they wrote
  // none — views send it only when it carries text.
  overallComment: string;
}

type SubmitRun = (input: SubmitInput) => Promise<unknown>;

/**
 * The review-session state every preview shares: draft comments and patches to saved
 * ones, variant preview overrides, lock toggles, the variant-gallery modal, view
 * filters, and the submit lifecycle (including the leave-guard while unsaved intent
 * exists). Views layer their own decision model (per-shot or per-address accepts) on
 * top via `hasExtraChanges`.
 *
 * Submit is one dialog, never a direct write: `openSubmit` raises it and `confirmSubmit` is the
 * only way through. The dialog is where the overall comment is written, where a review carrying
 * nothing is told so, and where the undecided targets are named — so the button itself is always
 * live, and every entry point (the button, ⌘⏎) lands on the same page of the same decision.
 */
export function useReviewSession(opts: { hasExtraChanges?: boolean } = {}) {
  const [pendingFeedback, setPendingFeedback] = useState<Record<string, PendingFeedback[]>>({});
  const [feedbackPatches, setFeedbackPatches] = useState<FeedbackPatch[]>([]);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [gallery, setGallery] = useState<{ address: string } | null>(null);
  const [hideStale, setHideStale] = useState(true);
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overallComment, setOverallComment] = useState("");
  const isSubmittingRef = useRef(false);

  const deletedFeedbackIds = useMemo(
    () => new Set(feedbackPatches.filter((p) => p.op === "delete").map((p) => p.id)),
    [feedbackPatches],
  );

  // Text of saved comments edited this session, keyed by feedback id — so lists render
  // the patched text before submit.
  const editedTextById = useMemo(
    () =>
      new Map(
        feedbackPatches
          .filter((p) => p.op === "edit" && p.text !== undefined)
          .map((p) => [p.id, p.text!] as const),
      ),
    [feedbackPatches],
  );

  const addPending = useCallback(
    (
      address: string,
      text: string,
      extra?: {
        annotation?: { kind: "pin"; x: number; y: number } | null;
        time?: number;
        shotId?: string;
      },
    ) => {
      const entry: PendingFeedback = {
        id: generatePendingId(),
        address,
        text,
        annotation: extra?.annotation ?? null,
        ...(extra?.time !== undefined ? { time: extra.time } : {}),
        ...(extra?.shotId !== undefined ? { shotId: extra.shotId } : {}),
      };
      setPendingFeedback((prev) => ({ ...prev, [address]: [...(prev[address] ?? []), entry] }));
    },
    [],
  );

  const removePending = useCallback((address: string, id: string) => {
    setPendingFeedback((prev) => ({
      ...prev,
      [address]: (prev[address] ?? []).filter((p) => p.id !== id),
    }));
  }, []);

  const editPending = useCallback((address: string, id: string, text: string) => {
    setPendingFeedback((prev) => ({
      ...prev,
      [address]: (prev[address] ?? []).map((p) => (p.id === id ? { ...p, text } : p)),
    }));
  }, []);

  const editExisting = useCallback((id: string, address: string, text: string) => {
    setFeedbackPatches((prev) => [
      ...prev.filter((p) => !(p.id === id && p.op === "edit")),
      { op: "edit", id, address, text },
    ]);
  }, []);

  const deleteExisting = useCallback((id: string, address: string) => {
    setFeedbackPatches((prev) => [
      ...prev.filter((p) => p.id !== id),
      { op: "delete", id, address },
    ]);
  }, []);

  const useVariant = useCallback((address: string, variantId: string) => {
    setSelectedVariants((prev) => ({ ...prev, [address]: variantId }));
    setGallery(null);
  }, []);

  // Throw away everything drafted this session, back to how the review opened.
  const reset = useCallback(() => {
    setPendingFeedback({});
    setFeedbackPatches([]);
    setSelectedVariants({});
    setGallery(null);
    setOverallComment("");
  }, []);

  const allPendingFeedback = useMemo(
    () => Object.values(pendingFeedback).flat(),
    [pendingFeedback],
  );

  const pendingNoteCount = allPendingFeedback.length;
  const editCount = feedbackPatches.filter((p) => p.op === "edit").length;
  const deleteCount = deletedFeedbackIds.size;

  // What makes this a review worth submitting — the dialog's Submit reads it, and so does the
  // leave-guard. The overall comment counts on its own: it is the whole of some passes.
  const hasPendingChanges =
    pendingNoteCount > 0 ||
    feedbackPatches.length > 0 ||
    Object.keys(selectedVariants).length > 0 ||
    overallComment.trim().length > 0 ||
    !!opts.hasExtraChanges;

  // The dialog stores no submit call: the review is still live behind it (the undecided list
  // re-renders as decisions change), so a captured closure would save the state as it was when the
  // dialog opened, not what the reviewer is looking at. Confirming takes the view's submit again,
  // freshly built.
  const [submitOpen, setSubmitOpen] = useState(false);

  // Wraps a view's submit call with the shared lifecycle: submitting state, the
  // close-window handshake on success, error surfacing on failure.
  const runSubmit = useCallback(
    async (run: SubmitRun) => {
      setSubmitting(true);
      isSubmittingRef.current = true;
      // Our own submit rewrites the state file, which the App banner would
      // otherwise flash as "New variants available" during the close handshake.
      window.dispatchEvent(new CustomEvent("konte:submitting"));
      setError(null);
      try {
        await run({
          addedFeedback: allPendingFeedback,
          feedbackPatches,
          overallComment: overallComment.trim(),
        });
        fetch("/api/close", { method: "POST" }).catch(() => {});
        window.close();
        setSubmitted(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // The review is on disk, some accepts short of what was asked. The drafts went with it, so
        // they are done here — left in place, the next Submit would write every comment again — and
        // the session ends the way a clean one does: the record and the CLI's exit line carry what
        // did not land, and the next step is `generate`, not this page. The submitted screen shows
        // the skipped list only where the window could not be closed.
        // The ref stays raised through that close, as on a clean submit: the leave-guard reads it
        // before React commits `submitted`, and would otherwise prompt over the drafts just saved.
        if (err instanceof ReviewSkippedError && err.saved) {
          setPendingFeedback({});
          setFeedbackPatches([]);
          setSubmitted(true);
          fetch("/api/close", { method: "POST" }).catch(() => {});
          window.close();
        } else {
          isSubmittingRef.current = false;
        }
      } finally {
        setSubmitting(false);
      }
    },
    [allPendingFeedback, feedbackPatches, overallComment],
  );

  const openSubmit = useCallback(() => setSubmitOpen(true), []);

  // The one way a review reaches the server: whatever the dialog is showing goes through as it
  // stands.
  const confirmSubmit = useCallback(
    async (run: SubmitRun) => {
      setSubmitOpen(false);
      await runSubmit(run);
    },
    [runSubmit],
  );

  const cancelSubmit = useCallback(() => setSubmitOpen(false), []);

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (isSubmittingRef.current || submitted) return;
      if (hasPendingChanges) e.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasPendingChanges, submitted]);

  return {
    pendingFeedback,
    feedbackPatches,
    deletedFeedbackIds,
    editedTextById,
    addPending,
    removePending,
    editPending,
    editExisting,
    deleteExisting,
    selectedVariants,
    useVariant,
    gallery,
    setGallery,
    hideStale,
    setHideStale,
    showChangedOnly,
    setShowChangedOnly,
    submitting,
    submitted,
    error,
    setError,
    hasPendingChanges,
    pendingNoteCount,
    editCount,
    deleteCount,
    reset,
    overallComment,
    setOverallComment,
    openSubmit,
    submitOpen,
    confirmSubmit,
    cancelSubmit,
  };
}

export type ReviewSession = ReturnType<typeof useReviewSession>;
