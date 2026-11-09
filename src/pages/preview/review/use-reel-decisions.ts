import type React from "react";
import { useCallback, useMemo } from "react";
import { formatShotAddress } from "../../../core/address.js";
import { shotAcceptable } from "../../../core/shot-acceptable.js";
import type { ShotInfo, VideoPreviewState } from "../types.js";
import { bulkAcceptState } from "./bulk-accept.js";
import {
  EMPTY_KEEP_GRAPH,
  keepContext,
  keepPromptFor,
  regenerateMarks,
  withoutUnits,
  type KeepChoice,
  type KeepContext,
  type KeepOrigin,
  type RegenerateMark,
} from "./keep-or-regenerate.js";
import { reelAcceptUnits, type ReelUnit } from "./shot-acceptable.js";
import { thumbnailShownAccepted } from "./thumbnail-view.js";
import type { useKeepChoices } from "./use-keep-choices.js";

type Mark = "accepted" | "none";

// Every accept mark this session holds. `undefined` is "no mark" — the unit reads at its baseline.
export type ReelMarks = {
  shots: Record<string, Mark>;
  stem: Mark | undefined;
  overlay: Mark | undefined;
  thumbnail: Mark | undefined;
};

export const NO_REEL_MARKS: ReelMarks = {
  shots: {},
  stem: undefined,
  overlay: undefined,
  thumbnail: undefined,
};

export function hasReelMarks(marks: ReelMarks): boolean {
  return (
    Object.keys(marks.shots).length > 0 ||
    marks.stem !== undefined ||
    marks.overlay !== undefined ||
    marks.thumbnail !== undefined
  );
}

/**
 * The reel's accept marks read against their baseline, and the gestures that move them. The marks
 * and the Keep-or-regenerate answers are the caller's state, since the review session counts them.
 */
export function useReelDecisions({
  state,
  reelStage,
  marks,
  setMarks,
  keep,
  effectiveVariants,
}: {
  state: VideoPreviewState;
  reelStage: "animatic" | "video";
  marks: ReelMarks;
  setMarks: React.Dispatch<React.SetStateAction<ReelMarks>>;
  keep: ReturnType<typeof useKeepChoices>;
  effectiveVariants: Record<string, string>;
}) {
  const {
    choices: keepChoices,
    request: requestKeep,
    dropUnits: dropKeepUnits,
    keepUnit: keepUnitAfterAll,
    reset: resetKeep,
  } = keep;

  // The take each address resolves to, for telling an audition from what stands.
  const resolvedByAddress = useMemo(
    () =>
      new Map(
        [...state.shots.flatMap((s) => s.assets), ...state.audioAssets].map((a) => [
          a.address,
          a.variantId,
        ]),
      ),
    [state.shots, state.audioAssets],
  );

  // Where each shot stands before this session touched it. Whether anything it signs off is still
  // undecided is the SERVER's answer (`needsVerdict`) — one rule for what settles a shot, shared
  // with the accept it drives. Only the preview override is the page's own: auditioning a
  // non-accepted take is a state of this session.
  const baseShotAccepted = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const s of state.shots) {
      // Standing in with the board: there is no accept to reflect.
      if (s.showingStandIn) {
        map[s.shotId] = false;
        continue;
      }
      // Only the addresses this shot's verdict actually lands on (`verdictAddresses`), so
      // auditioning a take the accept never touches does not read as an unsaved change.
      const viewingNonAccepted = s.verdictAddresses.some((address) => {
        const resolved = resolvedByAddress.get(address);
        if (resolved === undefined) return false;
        return (effectiveVariants[address] ?? resolved) !== resolved;
      });
      map[s.shotId] = !s.needsVerdict && !viewingNonAccepted;
    }
    return map;
  }, [state.shots, effectiveVariants, resolvedByAddress]);

  // The timeline audio stem (soundtrack beds): the persisted accept unless it is stale/unaccepted.
  const baseTimelineStemAccepted = useMemo(() => {
    const ts = state.timelineStem;
    return !!ts && ts.variantId !== null && !ts.needsReview;
  }, [state.timelineStem]);

  // The overlay: the persisted accept unless it is stale/unaccepted.
  const baseOverlayAccepted = useMemo(() => {
    const o = state.overlay;
    return !!o && o.variantId !== null && !o.needsReview;
  }, [state.overlay]);

  const baseThumbnailAccepted = useMemo(
    () => thumbnailShownAccepted(state.thumbnail, effectiveVariants),
    [state.thumbnail, effectiveVariants],
  );

  // Where one unit stands under a given set of marks: an explicit mark this session wins over the
  // baseline. The page's ONE reader — every view below is this function.
  const unitAccepted = useCallback(
    (unit: ReelUnit, m: ReelMarks): boolean =>
      unit.kind === "stem"
        ? (m.stem ?? (baseTimelineStemAccepted ? "accepted" : "none")) === "accepted"
        : unit.kind === "overlay"
          ? (m.overlay ?? (baseOverlayAccepted ? "accepted" : "none")) === "accepted"
          : unit.kind === "thumbnail"
            ? (m.thumbnail ?? (baseThumbnailAccepted ? "accepted" : "none")) === "accepted"
            : (m.shots[unit.shotId] ?? (baseShotAccepted[unit.shotId] ? "accepted" : "none")) ===
              "accepted",
    [baseShotAccepted, baseTimelineStemAccepted, baseOverlayAccepted, baseThumbnailAccepted],
  );

  const shotAccepted = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const s of state.shots)
      map[s.shotId] = unitAccepted({ kind: "shot", shotId: s.shotId }, marks);
    return map;
  }, [state.shots, unitAccepted, marks]);

  const timelineStemAccepted = unitAccepted({ kind: "stem" }, marks);
  const overlayAccepted = unitAccepted({ kind: "overlay" }, marks);
  const thumbnailAccepted = unitAccepted({ kind: "thumbnail" }, marks);

  // Every shot a review can sign off (see shotAcceptable) — the rest have their accept affordances
  // disabled and are excluded from Accept all, the unreviewed count, and the review filters.
  const acceptableShots = useMemo(() => state.shots.filter(shotAcceptable), [state.shots]);

  const unacceptableShotIds = useMemo(
    () => new Set(state.shots.filter((s) => !shotAcceptable(s)).map((s) => s.shotId)),
    [state.shots],
  );

  // Accept is a toggle (un-accept on second click). A shot accept signs off both its picture
  // (composition) and its audio (the shot's stem) server-side — no separate per-audio decision.
  // Toggling back to the baseline drops the mark rather than recording a no-op decision, so
  // Submit can tell "nothing to save" from "saved a change that happens to match".
  const keepGraph = state.keep ?? EMPTY_KEEP_GRAPH;

  // The shot whose verdict lands on each address this page accepts.
  const shotOfAddress = useMemo(
    () =>
      new Map(state.shots.flatMap((s) => s.verdictAddresses.map((a) => [a, s.shotId] as const))),
    [state.shots],
  );
  const shotOfUnit = useMemo(
    () =>
      new Map(state.shots.map((s) => [formatShotAddress(reelStage, s.shotId), s.shotId] as const)),
    [state.shots, reelStage],
  );

  // What a Keep-or-regenerate prompt reads, under the shot marks the accept being asked about leaves.
  const keepContextFor = useCallback(
    (markOf: (shotId: string) => Mark | undefined, choices: readonly KeepChoice[]): KeepContext =>
      keepContext(keepGraph, choices, {
        accepted: (address) => {
          const shotId = shotOfAddress.get(address);
          const mark = shotId === undefined ? undefined : markOf(shotId);
          return mark === undefined ? undefined : mark === "accepted";
        },
        shown: (address) =>
          resolvedByAddress.has(address)
            ? (effectiveVariants[address] ?? resolvedByAddress.get(address) ?? null)
            : undefined,
      }),
    [keepGraph, shotOfAddress, resolvedByAddress, effectiveVariants],
  );

  const keepOriginOf = useCallback(
    (shot: ShotInfo): KeepOrigin => ({
      unit: formatShotAddress(reelStage, shot.shotId),
      chosen: Object.fromEntries(
        shot.verdictAddresses.flatMap((address) => {
          const variantId = effectiveVariants[address] ?? resolvedByAddress.get(address);
          return variantId ? [[address, variantId]] : [];
        }),
      ),
    }),
    [reelStage, effectiveVariants, resolvedByAddress],
  );

  const applyShotMark = useCallback(
    (shotId: string, accepted: boolean) => {
      setMarks((prev) => {
        const shots = { ...prev.shots };
        if (accepted === baseShotAccepted[shotId]) delete shots[shotId];
        else shots[shotId] = accepted ? "accepted" : "none";
        return { ...prev, shots };
      });
    },
    [setMarks, baseShotAccepted],
  );

  const markShot = useCallback(
    (shotId: string, accepted: boolean) => {
      // Guards the A shortcut too, which reaches no disabled button.
      if (unacceptableShotIds.has(shotId)) return;
      const unit = formatShotAddress(reelStage, shotId);
      const shot = state.shots.find((s) => s.shotId === shotId);
      if (!accepted || !shot) {
        dropKeepUnits([unit]);
        applyShotMark(shotId, accepted);
        return;
      }
      const entries = keepPromptFor(
        keepContextFor(
          (id) => (id === shotId ? "accepted" : marks.shots[id]),
          withoutUnits(keepChoices, [unit]),
        ),
        [keepOriginOf(shot)],
      );
      requestKeep(entries, () => applyShotMark(shotId, true), [unit]);
    },
    [
      unacceptableShotIds,
      reelStage,
      state.shots,
      dropKeepUnits,
      applyShotMark,
      keepContextFor,
      marks.shots,
      keepChoices,
      keepOriginOf,
      requestKeep,
    ],
  );

  const toggleShotDecision = useCallback(
    (shotId: string) => markShot(shotId, !shotAccepted[shotId]),
    [markShot, shotAccepted],
  );

  // The beds' form of the shot's "Changed": the accept flipped back on its own, so say why.
  const timelineStemChanged =
    !!state.timelineStem && state.timelineStem.variantId !== null && state.timelineStem.needsReview;

  const toggleTimelineStem = useCallback(() => {
    const accepted = !timelineStemAccepted;
    setMarks((prev) => ({
      ...prev,
      stem: accepted === baseTimelineStemAccepted ? undefined : accepted ? "accepted" : "none",
    }));
  }, [setMarks, timelineStemAccepted, baseTimelineStemAccepted]);

  const toggleOverlay = useCallback(() => {
    const accepted = !overlayAccepted;
    setMarks((prev) => ({
      ...prev,
      overlay: accepted === baseOverlayAccepted ? undefined : accepted ? "accepted" : "none",
    }));
  }, [setMarks, overlayAccepted, baseOverlayAccepted]);

  const toggleThumbnail = useCallback(() => {
    if (!state.thumbnail) return;
    const accepted = !thumbnailAccepted;
    setMarks((prev) => ({
      ...prev,
      thumbnail: accepted === baseThumbnailAccepted ? undefined : accepted ? "accepted" : "none",
    }));
  }, [state.thumbnail, setMarks, thumbnailAccepted, baseThumbnailAccepted]);

  // Whether an audio asset still needs attention, for the "Needs review" filter. Each of its cues
  // is signed off by the shot that placed it (a shot accept covers that shot's stem); a bed is
  // signed off by the timeline stem. Like the rest of the filter it reads the baseline, not this
  // session's marks: an accept is recorded only on Submit, so a row marked here stays in view.
  const audioAccepted = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const a of state.audioAssets) {
      map[a.address] =
        a.kind === "soundtrack"
          ? baseTimelineStemAccepted
          : a.cues.every((c) => (c.shotId ? baseShotAccepted[c.shotId] : baseTimelineStemAccepted));
    }
    return map;
  }, [state.audioAssets, baseShotAccepted, baseTimelineStemAccepted]);

  const offered = !!state.overlay?.offered;
  const thumbnailReady = !!state.thumbnail;
  const acceptUnits = useMemo(
    () => reelAcceptUnits(state.shots, !!state.timelineStem, offered, thumbnailReady),
    [state.shots, state.timelineStem, offered, thumbnailReady],
  );

  // Accept one unit. Toggling back to the baseline drops the mark rather than recording a no-op
  // decision, so Submit can tell "nothing to save" from "saved a change that happens to match".
  const acceptUnit = useCallback(
    (unit: ReelUnit, m: ReelMarks): ReelMarks => {
      if (unit.kind === "stem")
        return { ...m, stem: baseTimelineStemAccepted ? undefined : "accepted" };
      if (unit.kind === "overlay")
        return { ...m, overlay: baseOverlayAccepted ? undefined : "accepted" };
      if (unit.kind === "thumbnail")
        return { ...m, thumbnail: baseThumbnailAccepted ? undefined : "accepted" };
      const shots = { ...m.shots };
      if (baseShotAccepted[unit.shotId]) delete shots[unit.shotId];
      else shots[unit.shotId] = "accepted";
      return { ...m, shots };
    },
    [baseShotAccepted, baseTimelineStemAccepted, baseOverlayAccepted, baseThumbnailAccepted],
  );

  // What the whole review still has to sign off, and whether "Accept all" would move anything.
  // See bulk-accept.ts.
  const {
    pending: pendingUnits,
    done: everythingAccepted,
    apply: acceptAllMarks,
  } = useMemo(
    () => bulkAcceptState(acceptUnits, marks, acceptUnit, unitAccepted),
    [acceptUnits, marks, acceptUnit, unitAccepted],
  );

  // Nothing persists until Submit, so bulk-marking needs no confirm dialog — every mark stays
  // individually reversible before the review is saved.
  // Every shot it accepts asks through one prompt.
  const acceptAll = useCallback(() => {
    const next = acceptAllMarks(marks);
    const origins = state.shots
      .filter(
        (s) => unitAccepted({ kind: "shot", shotId: s.shotId }, next) && !shotAccepted[s.shotId],
      )
      .map(keepOriginOf);
    const units = origins.map((o) => o.unit);
    const entries = keepPromptFor(
      keepContextFor((id) => next.shots[id], withoutUnits(keepChoices, units)),
      origins,
    );
    requestKeep(entries, () => setMarks(next), units);
  }, [
    acceptAllMarks,
    marks,
    unitAccepted,
    state.shots,
    shotAccepted,
    keepOriginOf,
    keepContextFor,
    keepChoices,
    requestKeep,
    setMarks,
  ]);

  const regenerateUnits = useMemo(
    () => regenerateMarks(keepGraph, keepChoices, reelStage, (unit) => shotOfUnit.get(unit)),
    [keepGraph, keepChoices, reelStage, shotOfUnit],
  );
  const regenerateByShot = useMemo<Record<string, RegenerateMark>>(
    () =>
      Object.fromEntries(
        state.shots.flatMap((s) => {
          const mark = regenerateUnits.get(formatShotAddress(reelStage, s.shotId));
          return mark ? [[s.shotId, mark]] : [];
        }),
      ),
    [state.shots, regenerateUnits, reelStage],
  );
  const keepShotAfterAll = useCallback(
    (shotId: string) => keepUnitAfterAll(formatShotAddress(reelStage, shotId)),
    [keepUnitAfterAll, reelStage],
  );

  // Shots still needing acceptance — every shot not currently accepted, whether that's an
  // undecided one, a fresh reroll, or one the reviewer just un-accepted this session.
  //
  // Narrowed to shots because the "Next" button it drives is the shot list's own header control
  // (`noun="shot"`): the beds sit in another panel and are reached by picking the Soundtrack card,
  // so counting them here would send the reviewer looking for a shot that is not there. The beds
  // are still a unit of `pendingUnits` above, which is what "Accept all" and its label read.
  const unreviewedShotIds = useMemo(
    () => pendingUnits.flatMap((u) => (u.kind === "shot" ? [u.shotId] : [])),
    [pendingUnits],
  );

  const reset = useCallback(() => {
    setMarks(NO_REEL_MARKS);
    resetKeep();
  }, [setMarks, resetKeep]);

  return {
    keepGraph,
    baseShotAccepted,
    baseTimelineStemAccepted,
    baseOverlayAccepted,
    baseThumbnailAccepted,
    shotAccepted,
    timelineStemAccepted,
    overlayAccepted,
    thumbnailAccepted,
    timelineStemChanged,
    acceptableShots,
    audioAccepted,
    everythingAccepted,
    unreviewedShotIds,
    regenerateUnits,
    regenerateByShot,
    toggleShotDecision,
    toggleTimelineStem,
    toggleOverlay,
    toggleThumbnail,
    acceptAll,
    keepShotAfterAll,
    reset,
  };
}
