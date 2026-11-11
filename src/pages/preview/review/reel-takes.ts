import type { VideoPreviewState } from "../types.js";

export type ReelTakesState = Pick<
  VideoPreviewState,
  "shots" | "audioAssets" | "thumbnail" | "compositionRefVariants"
>;

// What the page was served: the take each gallery-backed address resolves to, and what the
// compositions were drawn from (a board panel, a reference sheet, an overlay's own takes).
export type ServedTakes = {
  galleried: ReadonlyMap<string, string | null>;
  drawn: Readonly<Record<string, string>>;
};

export type ReelTakes = {
  // Whether the page offers takes to switch between at the address.
  galleried: (address: string) => boolean;
  resolved: (address: string) => string | null;
  // The take on screen: a gallery pick wins over what the address resolves to.
  shown: (address: string) => string | null;
  // Every address on screen with its take — what the composition is pinned to and the submit records.
  displayed: Readonly<Record<string, string>>;
};

export function servedTakes(state: ReelTakesState): ServedTakes {
  const galleried = new Map<string, string | null>();
  for (const a of [
    ...state.shots.flatMap((s) => s.assets),
    ...state.audioAssets,
    ...(state.thumbnail ? [state.thumbnail.cover, ...state.thumbnail.assets] : []),
  ]) {
    galleried.set(a.address, a.variantId);
  }
  return { galleried, drawn: state.compositionRefVariants };
}

export function reelTakes(
  served: ServedTakes,
  effectiveVariants: Record<string, string>,
): ReelTakes {
  const resolved = (address: string) =>
    served.galleried.get(address) ?? served.drawn[address] ?? null;
  const displayed: Record<string, string> = { ...served.drawn };
  for (const [address, variantId] of served.galleried) {
    const shown = effectiveVariants[address] ?? variantId;
    if (shown) displayed[address] = shown;
  }
  return {
    galleried: (address) => served.galleried.has(address),
    resolved,
    shown: (address) => effectiveVariants[address] ?? resolved(address),
    displayed,
  };
}

/** Whether any of a unit's verdict addresses plays a take other than the one it resolves to. */
export function auditioning(verdictAddresses: readonly string[], takes: ReelTakes): boolean {
  return verdictAddresses.some((a) => takes.shown(a) !== takes.resolved(a));
}

/** Whether a materialized leaf (the beds' stem, the overlay) stands accepted as the page shows it. */
export function leafShownAccepted(
  leaf: { variantId: string | null; needsReview: boolean; verdictAddresses: string[] } | undefined,
  takes: ReelTakes,
): boolean {
  return (
    !!leaf &&
    leaf.variantId !== null &&
    !leaf.needsReview &&
    !auditioning(leaf.verdictAddresses, takes)
  );
}
