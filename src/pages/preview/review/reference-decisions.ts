import type { ReferenceAssetInfo, VariantStatus } from "../types.js";
import { bulkAcceptState } from "./bulk-accept.js";

// The reference review's decision model, kept out of the component so the rule below is testable.
// The rule is easy to get subtly wrong in one direction: sending only what changed keeps the review
// record honest, but "changed" has to mean changed *for the reviewer*, not just a different variant
// id — a decision dropped here is a sign-off that silently never happens.

// The variant currently accepted on the server for this asset, or null when none is.
export function acceptedVariantId(asset: ReferenceAssetInfo): string | null {
  return asset.variantStatus === "accepted" ? asset.variantId : null;
}

// Whether re-confirming the SAME already-accepted variant still says something new. Two things make
// it meaningful: a fresh take waiting beside the accepted one (accepting dismisses it and advances
// `acceptedAt`), and a stale direction part (the media is unchanged, but its prose was reworded —
// re-confirming the picture is how that rewording gets signed off, and the submit's roster cascade
// keys on exactly this decision). ANY of the parts a sample is cast for is enough: one accept
// restamps all of them.
export function reacceptIsMeaningful(asset: ReferenceAssetInfo): boolean {
  return (
    asset.variants.some((v) => v.isNew) ||
    (asset.directionRoster?.some((part) => part.needsReview) ?? false)
  );
}

// Where the asset stands for the variant currently shown: an override wins, but only on the very
// variant it was set on — switching the gallery to another take drops back to the persisted accept,
// so the badge and the accept button always describe what is on screen.
export function referenceEffectiveStatus(
  asset: ReferenceAssetInfo,
  selected: string | null,
  override: { variantId: string; status: VariantStatus } | undefined,
): VariantStatus {
  if (override && override.variantId === selected) return override.status;
  // Anything a re-accept would still settle — an undecided fresh reroll, or a roster entry whose
  // prose went stale under an unchanged image — reads "none" so the row prompts "Accept". Same
  // predicate `referenceDecisionFor` uses, so the button and the decision cannot drift apart:
  // a row that offers no Accept must not be one whose Accept would have sent something.
  if (reacceptIsMeaningful(asset)) return "none";
  return selected != null && selected === acceptedVariantId(asset) ? "accepted" : "none";
}

// The assets Accept all still has something to do to — the page's one review set, behind the
// unreviewed count, the N jump, the button's label and the "Needs review" filter alike. An
// accepted take that has only gone stale is settled: Accept all cannot move it, and re-accepting
// does not un-stale it — `konte reroll` is its refresh.
export function referenceBulkAccept(
  assets: ReferenceAssetInfo[],
  shownVariantByAddress: Record<string, string>,
  overrides: Record<string, { variantId: string; status: VariantStatus }>,
): {
  unaccepted: Set<string>;
  done: boolean;
  acceptAll: (
    marks: Record<string, { variantId: string; status: VariantStatus }>,
  ) => Record<string, { variantId: string; status: VariantStatus }>;
} {
  const { pending, done, apply } = bulkAcceptState(
    referenceAcceptUnits(assets),
    overrides,
    (asset, marks) => ({
      ...marks,
      [asset.address]: {
        variantId: shownVariantByAddress[asset.address] ?? asset.variantId,
        status: "accepted" as VariantStatus,
      },
    }),
    (asset, marks) =>
      referenceEffectiveStatus(
        asset,
        shownVariantByAddress[asset.address] ?? asset.variantId,
        marks[asset.address],
      ) === "accepted",
  );
  return { unaccepted: new Set(pending.map((a) => a.address)), done, acceptAll: apply };
}

// The assets Accept all covers. One with no readable variant has nothing on screen to decide about.
export function referenceAcceptUnits(
  assets: ReferenceAssetInfo[],
): Array<ReferenceAssetInfo & { variantId: string }> {
  return assets.filter(
    (a): a is ReferenceAssetInfo & { variantId: string } => a.variantId !== null,
  );
}

// The assets a submit would record unaccepted with no reason — named once at the submit
// confirmation (see undecided.ts), by asset name.
export function referenceUndecidedAssets(
  assets: ReferenceAssetInfo[],
  shownVariantByAddress: Record<string, string>,
  overrides: Record<string, { variantId: string; status: VariantStatus }>,
  commented: Set<string>,
): string[] {
  const { unaccepted } = referenceBulkAccept(assets, shownVariantByAddress, overrides);
  return assets
    .filter((a) => unaccepted.has(a.address) && !commented.has(a.address))
    .map((a) => a.assetName);
}

// The decision to send for one asset the reviewer touched, or null when the override says nothing
// the server does not already hold.
export function referenceDecisionFor(
  asset: ReferenceAssetInfo,
  override: { variantId: string; status: VariantStatus },
): {
  address: string;
  variantId: string;
  status: VariantStatus;
  candidateVariantIds?: string[];
} | null {
  const acceptedId = acceptedVariantId(asset);
  if (override.status === "accepted") {
    if (override.variantId !== acceptedId || reacceptIsMeaningful(asset)) {
      return {
        address: asset.address,
        variantId: override.variantId,
        status: "accepted",
        // The takes this row's gallery offered — an accept dismisses the ones it passed over.
        candidateVariantIds: (asset.variants ?? []).map((v) => v.variantId),
      };
    }
    return null;
  }
  if (override.status === "none" && override.variantId === acceptedId) {
    return { address: asset.address, variantId: override.variantId, status: "none" };
  }
  return null;
}
