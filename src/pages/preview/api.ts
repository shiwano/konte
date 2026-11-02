import type {
  AddressReviewSubmitBody,
  AddressReviewSubmitResponse,
  DirectionSubmitBody,
  DirectionSubmitResponse,
  ReelSubmitBody,
  ReelSubmitResponse,
  SkippedDecision,
} from "../../core/types/review-submit.js";
import { jsonBody, request, requestJson } from "../shared/http.js";
import type { PreviewState } from "./types.js";

export function fetchState(signal?: AbortSignal): Promise<PreviewState> {
  return requestJson<PreviewState>("/api/state", { signal });
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
  return (await request(qs ? `${path}?${qs}` : path, { signal })).text();
}

export function submitReview(
  stage: "animatic" | "video",
  body: ReelSubmitBody,
): Promise<ReelSubmitResponse> {
  return requestJson<ReelSubmitResponse>(`/api/${stage}/submit`, jsonBody("POST", body)).then(
    rejectSkippedDecisions,
  );
}

// A 200 whose accepts did not all land. `saved` says whether the record — and every note and accept
// the submit carried — is on disk: when it is, the drafts must not be sent again (a retry would
// write each comment a second time), so the session ends as a clean one does — the record and the
// CLI's exit line carry the skips; when it is not, the page stays open to retry.
export class ReviewSkippedError extends Error {
  constructor(
    readonly saved: boolean,
    readonly skipped: readonly SkippedDecision[],
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
  T extends { saved: boolean; skippedDecisions?: SkippedDecision[] },
>(res: T): T {
  if (res.skippedDecisions?.length) throw new ReviewSkippedError(res.saved, res.skippedDecisions);
  return res;
}

export function submitDirectionReview(
  payload: DirectionSubmitBody,
): Promise<DirectionSubmitResponse> {
  return requestJson<DirectionSubmitResponse>(
    "/api/direction/submit",
    jsonBody("POST", payload),
  ).then(rejectSkippedDecisions);
}

export function submitReferenceReview(
  payload: AddressReviewSubmitBody,
): Promise<AddressReviewSubmitResponse> {
  return requestJson<AddressReviewSubmitResponse>(
    "/api/reference/submit",
    jsonBody("POST", payload),
  ).then(rejectSkippedDecisions);
}
