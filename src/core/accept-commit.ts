import { cascadeAcceptConsumedDeps } from "./accept-cascade.js";
import { isMaterializedLeafAddress } from "./address.js";
import type { JobManager } from "./job-manager.js";
import type { ReviewRecord } from "./review-record.js";
import type { StateManager } from "./state/index.js";

export type AcceptCascadeOpts = Parameters<typeof cascadeAcceptConsumedDeps>[4];

// What a run of accepts landed, for the record a review writes.
export interface AcceptLedger {
  acceptedAssets: string[];
  // Addresses accepted as a side effect of another accept, tagged with the address they rode in on.
  cascadeAccepted: Array<{ address: string; via: string }>;
  overturned?: NonNullable<ReviewRecord["overturned"]>;
}

// Read before the accept lands: `setAccepted` overwrites the dismissal it records.
function noteOverturned(
  mgr: StateManager,
  address: string,
  variantId: string,
  overturned: NonNullable<ReviewRecord["overturned"]>,
): void {
  if (mgr.tryGetAssetState(address)?.variants?.[variantId]?.status !== "dismissed") return;
  const displaced = mgr.getAcceptedVariant(address);
  overturned.push({ address, variantId, ...(displaced ? { displaced } : {}) });
}

/**
 * Accepts one take and cascades onto what it consumed. Re-accepting the accepted take still settles
 * `dismiss`. A generation take cascades and is recorded only when the accept moved — its cascade
 * replays what its job consumed — while a materialized leaf always is, signing off what it displays
 * now.
 *
 * `via` is the accept this one rides on; `cascadeVia` (default: `address`) is what its cascade is
 * recorded through.
 */
export async function commitAccept(
  manager: StateManager,
  jobManager: JobManager,
  target: {
    address: string;
    variantId: string;
    dismiss?: readonly string[];
    cascade: AcceptCascadeOpts | null;
    via?: string;
    cascadeVia?: string;
  },
  ledger?: AcceptLedger,
): Promise<{ previous: string | null; cascaded: string[] }> {
  const { address, variantId } = target;
  const previous = manager.getAcceptedVariant(address);
  if (ledger?.overturned) noteOverturned(manager, address, variantId, ledger.overturned);
  manager.setAccepted(address, variantId, { dismiss: target.dismiss ?? [] });
  if (previous === variantId && !isMaterializedLeafAddress(address)) {
    return { previous, cascaded: [] };
  }
  // Recorded before the cascade: a cascade that throws leaves this accept standing.
  ledger?.acceptedAssets.push(address);
  if (ledger && target.via) ledger.cascadeAccepted.push({ address, via: target.via });
  const cascaded = target.cascade
    ? await cascadeAcceptConsumedDeps(manager, jobManager, address, variantId, target.cascade)
    : [];
  if (ledger) {
    const via = target.cascadeVia ?? address;
    ledger.acceptedAssets.push(...cascaded);
    ledger.cascadeAccepted.push(...cascaded.map((dep) => ({ address: dep, via })));
  }
  return { previous, cascaded };
}
