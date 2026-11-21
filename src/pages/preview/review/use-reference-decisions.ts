import type React from "react";
import { useCallback, useMemo } from "react";
import type {
  ReferenceAssetInfo,
  ReferencePreviewState,
  SongLineEdit,
  VariantStatus,
} from "../../../core/types/review-state.js";
import { unplacedLineCount } from "../components/song-track.js";
import {
  EMPTY_KEEP_GRAPH,
  keepContext,
  keepPromptFor,
  regenerateMarks,
  withoutUnits,
  type KeepChoice,
  type KeepContext,
} from "./keep-or-regenerate.js";
import { referenceBulkAccept, referenceEffectiveStatus } from "./reference-decisions.js";
import type { useKeepChoices } from "./use-keep-choices.js";
import type { useReviewSession } from "./use-review-session.js";

// Every accept mark this session holds, by address, on the variant it was set on.
export type ReferenceMarks = Record<string, { variantId: string; status: VariantStatus }>;

/**
 * The reference review's accept marks read against what is shown, and the gestures that move them.
 * The marks, the placed lyric lines and the Keep-or-regenerate answers are the caller's state, since
 * the review session counts them.
 */
export function useReferenceDecisions({
  state,
  assetByAddress,
  marks,
  setMarks,
  songLines,
  keep,
  effectiveVariants,
  session,
}: {
  state: ReferencePreviewState;
  assetByAddress: ReadonlyMap<string, ReferenceAssetInfo>;
  marks: ReferenceMarks;
  setMarks: React.Dispatch<React.SetStateAction<ReferenceMarks>>;
  songLines: readonly SongLineEdit[];
  keep: ReturnType<typeof useKeepChoices>;
  effectiveVariants: Record<string, string>;
  session: ReturnType<typeof useReviewSession>;
}) {
  const { choices: keepChoices, request: requestKeep, dropUnits: dropKeepUnits } = keep;
  const keepGraph = state.keep ?? EMPTY_KEEP_GRAPH;

  // Accept is per-variant: a row is "accepted" only when the variant currently shown is the
  // accepted one. Switching to another variant in the gallery flips the row back to "none"
  // until that variant is explicitly accepted — so the badge and the accept button always
  // reflect what submit would actually persist.
  const getEffectiveStatus = useCallback(
    (asset: ReferenceAssetInfo, selected: string | null): VariantStatus =>
      referenceEffectiveStatus(asset, selected, marks[asset.address]),
    [marks],
  );

  // Why the take shown at an asset cannot be accepted: a take of the song with a lyric line nobody
  // placed on it, as this review would leave it.
  const acceptBlockedOf = useCallback(
    (asset: ReferenceAssetInfo, variantId: string | null): string | null => {
      const song = asset.variants.find((v) => v.variantId === variantId)?.song;
      const unplaced = song ? unplacedLineCount(song, songLines) : 0;
      return unplaced > 0
        ? `${unplaced} lyric line(s) are not placed — open the song and drag them onto the track`
        : null;
    },
    [songLines],
  );

  // What a Keep-or-regenerate prompt reads, under the accept marks the accept being asked about leaves.
  const keepContextFor = useCallback(
    (overrides: ReferenceMarks, choices: readonly KeepChoice[]): KeepContext =>
      keepContext(keepGraph, choices, {
        accepted: (address) => {
          const mark = overrides[address];
          return mark ? mark.status === "accepted" : undefined;
        },
        shown: (address) => {
          const asset = assetByAddress.get(address);
          return asset ? (effectiveVariants[address] ?? asset.variantId) : undefined;
        },
      }),
    [keepGraph, assetByAddress, effectiveVariants],
  );

  // Accept is a toggle on the shown variant: accept it, or clear an already-accepted one.
  const toggleAccept = useCallback(
    (asset: ReferenceAssetInfo, selected: string) => {
      const next: VariantStatus =
        getEffectiveStatus(asset, selected) === "accepted" ? "none" : "accepted";
      if (next === "accepted" && acceptBlockedOf(asset, selected)) return;
      const mark = { variantId: selected, status: next };
      const apply = () => setMarks((prev) => ({ ...prev, [asset.address]: mark }));
      if (next === "none") {
        dropKeepUnits([asset.address]);
        apply();
        return;
      }
      const entries = keepPromptFor(
        keepContextFor(
          { ...marks, [asset.address]: mark },
          withoutUnits(keepChoices, [asset.address]),
        ),
        [{ unit: asset.address, chosen: { [asset.address]: selected } }],
      );
      requestKeep(entries, apply, [asset.address]);
    },
    [
      getEffectiveStatus,
      acceptBlockedOf,
      setMarks,
      dropKeepUnits,
      keepContextFor,
      marks,
      keepChoices,
      requestKeep,
    ],
  );

  const regenerateByAddress = useMemo(
    () => regenerateMarks(keepGraph, keepChoices, "reference"),
    [keepChoices, keepGraph],
  );

  // The one answer behind every review affordance here — the unreviewed count, the N jump and
  // Accept all's label. See bulk-accept.ts.
  const { unaccepted, done: everythingAccepted } = useMemo(
    () => referenceBulkAccept(state.assets, effectiveVariants, marks),
    [state.assets, effectiveVariants, marks],
  );

  // The "Needs review" filter reads the server's accepts alone: a mark is recorded only on Submit,
  // so a row marked here stays in view until then.
  const persistedUnaccepted = useMemo(
    () => referenceBulkAccept(state.assets, {}, {}).unaccepted,
    [state.assets],
  );

  // Nothing persists until Submit, so no confirm dialog — each mark stays individually reversible.
  // Every asset it accepts asks through one prompt.
  const acceptMany = useCallback(
    (assets: ReferenceAssetInfo[]) => {
      const next = {
        ...referenceBulkAccept(assets, effectiveVariants, marks).acceptAll(marks),
      };
      for (const a of assets) {
        const mark = next[a.address];
        if (mark?.status !== "accepted" || !acceptBlockedOf(a, mark.variantId)) continue;
        if (marks[a.address]) next[a.address] = marks[a.address]!;
        else delete next[a.address];
      }
      const origins = assets
        .filter((a) => {
          const shown = effectiveVariants[a.address] ?? a.variantId;
          return (
            shown !== null &&
            next[a.address]?.status === "accepted" &&
            getEffectiveStatus(a, shown) !== "accepted"
          );
        })
        .map((a) => ({ unit: a.address, chosen: { [a.address]: next[a.address]!.variantId } }));
      const units = origins.map((o) => o.unit);
      const entries = keepPromptFor(
        keepContextFor(next, withoutUnits(keepChoices, units)),
        origins,
      );
      requestKeep(entries, () => setMarks(next), units);
    },
    [
      acceptBlockedOf,
      marks,
      setMarks,
      effectiveVariants,
      getEffectiveStatus,
      keepContextFor,
      keepChoices,
      requestKeep,
    ],
  );

  // Switching the shown variant resets any pending accept/un-accept intent for that asset, so
  // the badge (and what submit persists) can never disagree with what is on screen.
  const showVariant = useCallback(
    (address: string, variantId: string) => {
      session.useVariant(address, variantId);
      dropKeepUnits([address]);
      setMarks((prev) => {
        if (!(address in prev)) return prev;
        const next = { ...prev };
        delete next[address];
        return next;
      });
    },
    [session, dropKeepUnits, setMarks],
  );

  return {
    getEffectiveStatus,
    acceptBlockedOf,
    toggleAccept,
    acceptMany,
    showVariant,
    regenerateByAddress,
    unaccepted,
    everythingAccepted,
    persistedUnaccepted,
  };
}
