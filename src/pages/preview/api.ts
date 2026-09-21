import type { KeepEntry, KeepTake } from "./review/keep-or-regenerate.js";
import type { DirectionSection, PreviewState } from "./types.js";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body as T;
}

export function fetchState(signal?: AbortSignal): Promise<PreviewState> {
  return request<PreviewState>("/api/state", { signal });
}

export async function fetchCompositionHtml(
  shotId?: string,
  variantOverride?: string,
  overrides?: Record<string, string>,
  signal?: AbortSignal,
  // The shots this page was told are standing in with the board, so the reel renders what the shot
  // list and the accept toggle mean — see handleGetFullComposition.
  standInShotIds?: readonly string[],
): Promise<string> {
  const path = shotId
    ? `/api/compositions/${encodeURIComponent(shotId)}`
    : "/api/compositions/full";
  const search = new URLSearchParams();
  if (variantOverride) search.set("variant", variantOverride);
  if (overrides) {
    for (const [address, variantId] of Object.entries(overrides)) {
      search.append("override", `${address}:${variantId}`);
    }
  }
  // `pinned` marks that a page snapshot is behind this request, so an EMPTY list reads as "the page
  // says no shot is standing in" rather than as "no list was sent" — the two need different answers.
  if (standInShotIds) {
    search.set("pinned", "1");
    for (const id of standInShotIds) search.append("standIn", id);
  }
  const qs = search.toString();
  const res = await fetch(qs ? `${path}?${qs}` : path, { signal });
  if (!res.ok) throw new Error(`Failed to fetch composition: ${res.status}`);
  return res.text();
}

export function submitReview(
  decisions: unknown,
  notes:
    | Array<{
        time: number;
        shotId?: string;
        address?: string;
        text: string;
        x?: number;
        y?: number;
      }>
    | undefined,
  stage: "animatic" | "video",
  // Required, not optional: the endpoint rejects a submit that cannot say which shots stood in, so
  // a caller that omits the whole object would compile and then 400.
  extra: {
    timelineStemDecision?: "accepted" | "none";
    // Where each comment was written, and nothing about what it was written against: the endpoint
    // derives the subject from the definition and the whole-view snapshots below, so a page cannot
    // narrow it to the assets one of its own arrays happens to hold.
    addedFeedback?: Array<{
      address: string;
      text: string;
      annotation: { kind: "pin"; x: number; y: number } | null;
      time?: number;
    }>;
    feedbackPatches?: Array<{ op: "edit" | "delete"; id: string; address: string; text?: string }>;
    displayedVariants?: Record<string, string>;
    // The live definition hash the page was served per materialized leaf (each shot's composition
    // and stem, the timeline stem) — the axis no take carries.
    displayedDefinitionHashes?: Record<string, string>;
    // The takes the gallery offered per address. An accept dismisses the unchosen among them, so
    // the list must come from the page rather than be re-derived at submit time.
    displayedCandidates?: Record<string, string[]>;
    // Required by the reel submit endpoint: which shots displayed the board in place of an unmade
    // picture cannot be re-derived server-side, and their verdicts are dropped. Declared
    // non-optional so a caller cannot compile its way to a runtime 400.
    displayedStandInShotIds: string[];
    // The reviewer's word on the pass as a whole, from the submit dialog. Sent only when written.
    overallComment?: string;
    // The Keep-or-regenerate answers (see `KeepEntry`).
    keep?: KeepEntry[];
    regenerate?: KeepTake[];
  },
): Promise<{ saved: boolean; filePath: string | null }> {
  return request<{
    saved: boolean;
    filePath: string | null;
    skippedDecisions?: Array<{ shotId?: string; address: string; reason: string }>;
  }>(`/api/${stage}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisions, notes, stage, ...extra }),
  }).then(rejectSkippedDecisions);
}

// A 200 whose accepts did not all land. `saved` says whether the record — and every note and accept
// the submit carried — is on disk: when it is, the drafts must not be sent again (a retry would
// write each comment a second time), so the session ends as a clean one does — the record and the
// CLI's exit line carry the skips; when it is not, the page stays open to retry.
export class ReviewSkippedError extends Error {
  constructor(
    readonly saved: boolean,
    readonly skipped: ReadonlyArray<{ address: string; reason: string }>,
  ) {
    super(
      `${saved ? "Review saved" : "Review not saved"}. ${skipped.length} target(s) could not be settled:\n${skipped
        // A reason carries its own detail lines (which input held a leaf back, the command that
        // clears it); indented under the address, as the review record prints them.
        .map((s) =>
          s.reason
            .split("\n")
            .map((line, i) => (i === 0 ? `${s.address}: ${line}` : `  ${line}`))
            .join("\n"),
        )
        .join("\n")}`,
    );
    this.name = "ReviewSkippedError";
  }
}

// Thrown so the session never treats a success state does not back as a clean one — the failure
// mode that made a whole video review disappear silently.
export function rejectSkippedDecisions<
  T extends { saved: boolean; skippedDecisions?: Array<{ address: string; reason: string }> },
>(res: T): T {
  if (res.skippedDecisions?.length) throw new ReviewSkippedError(res.saved, res.skippedDecisions);
  return res;
}

export function submitDirectionReview(payload: {
  addedFeedback: Array<{
    address: string;
    text: string;
    annotation: { kind: "pin"; x: number; y: number } | null;
    displayedVariants?: Record<string, string>;
  }>;
  feedbackPatches: Array<{
    op: "edit" | "delete";
    id: string;
    address: string;
    text?: string;
  }>;
  // The reviewer's verdict per box: true accepts every part it holds, false revokes them. A box they
  // left alone is absent — a feedback-only submit must not revoke what was signed off earlier.
  sectionDecisions?: Partial<Record<DirectionSection, boolean>>;
  reviewedHash?: string;
  overallComment?: string;
  // `accepted` reports the WHOLE direction's standing after the submit (the spend gate's question),
  // not whether the sections in this payload were accepted.
}): Promise<{ saved: boolean; filePath: string | null; accepted: boolean }> {
  return request("/api/direction/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function submitReferenceReview(payload: {
  addedFeedback: Array<{
    address: string;
    text: string;
    annotation: { kind: "pin"; x: number; y: number } | null;
    displayedVariants?: Record<string, string>;
  }>;
  feedbackPatches: Array<{
    op: "edit" | "delete";
    id: string;
    address: string;
    text?: string;
  }>;
  decisions?: Array<{
    address: string;
    variantId: string;
    status: "accepted" | "none";
    // The takes this decision was made among — see submitReview's `displayedCandidates`.
    candidateVariantIds?: string[];
  }>;
  overallComment?: string;
  keep?: KeepEntry[];
  regenerate?: KeepTake[];
}): Promise<{ saved: boolean }> {
  return request<{
    saved: boolean;
    skippedDecisions?: Array<{ address: string; reason: string }>;
  }>("/api/reference/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(rejectSkippedDecisions);
}
