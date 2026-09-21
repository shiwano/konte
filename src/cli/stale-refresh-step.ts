import { holdsHumanVerdict } from "../core/accept-cascade.js";
import { getStage, isMaterializedLeafAddress, type Stage } from "../core/address.js";
import { findAllUnmetPrerequisites } from "../core/review-prerequisites.js";
import type { StateManager } from "../core/state/index.js";
import type { PatchHashes, StalenessCache } from "../core/staleness.js";
import type { AnimaticDefinition } from "../core/types/index.js";

/**
 * How a take that no longer matches its definition or its inputs is brought back up to date.
 *
 * `patch-apply` / `prune`: a patch output is refreshed by re-applying its correction — a reroll
 * would spend on a fresh original and orphan the correction hung off it — and with the script gone
 * there is nothing left to re-apply.
 *
 * `accept`: a take already at the address matches the current definition and inputs — the way back
 * from a reverted edit, and it costs nothing.
 *
 * `prerequisite`: a matching take is there, but the accept is owed the panel's movement first.
 *
 * `generate`: nothing there fits and the asset is deterministic — one outcome, so `reroll` refuses
 * it and a stage generate re-bakes it over its accept.
 *
 * `review`: a materialized leaf — a composition, a stem — is rendered live and materialized by its
 * accept, so the refresh is the review of the shot it belongs to.
 *
 * `stands`: a human-accepted take whose inputs alone moved — the accept stands; nothing replaces it
 * unless it is cleared.
 *
 * `reroll`: nothing there fits, so the refresh has to be paid for.
 *
 * `none`: the address's own accepted take is current, so the stale one asked about is an old
 * alternative beside it.
 */
type StaleRefreshStep =
  | { kind: "none" }
  | { kind: "patch-apply"; sourceVariantId: string }
  | { kind: "prune" }
  | { kind: "accept"; variantId: string }
  | { kind: "prerequisite"; variantId: string; missing: readonly string[]; writeIn: string }
  | { kind: "generate"; stage: Stage }
  | { kind: "review"; stage: Stage }
  | { kind: "stands" }
  | { kind: "reroll" };

/**
 * The step for one stale take, shared by `ref` and `inspect` so the two never name different ones
 * about the same take.
 *
 * The `accept` branch asks the prerequisite check the accept itself would ask: a panel still owed
 * its `blocking`/`camera` cannot be accepted, so what is owed is named instead.
 *
 * `undefined` is a board that could not be read, over which no accept is offered.
 */
export function staleRefreshStep(opts: {
  manager: StateManager;
  address: string;
  variantId: string;
  patchHashes?: PatchHashes;
  animatic: AnimaticDefinition | undefined;
  cache?: StalenessCache;
}): StaleRefreshStep {
  const { manager, address, variantId, patchHashes } = opts;

  // Before the `none` branch: an edited script leaves its output outstanding whatever else the
  // address holds, and `status` lists it under Pending patches.
  const derivedFrom = manager.tryGetAssetState(address)?.variants?.[variantId]?.derivedFrom;
  if (derivedFrom != null) {
    return patchHashes != null && !patchHashes.has(derivedFrom)
      ? { kind: "prune" }
      : { kind: "patch-apply", sourceVariantId: derivedFrom };
  }

  // Asked about a take the address has already moved past: its accepted take stands and is current.
  const accepted = manager.getAcceptedVariant(address);
  if (accepted !== null && accepted !== variantId) {
    const acceptedStaleness = manager.variantStaleness(address, accepted, opts.cache);
    if (acceptedStaleness && !acceptedStaleness.inputStale && !acceptedStaleness.definitionStale) {
      return { kind: "none" };
    }
  }

  const matching = manager.matchingReadyTake(address, variantId, opts.cache);
  if (!matching || opts.animatic === undefined) {
    if (isMaterializedLeafAddress(address)) return { kind: "review", stage: getStage(address) };
    if (accepted === variantId && holdsHumanVerdict(manager, address)) {
      const staleness = manager.variantStaleness(address, variantId, opts.cache);
      if (staleness?.inputStale && !staleness.definitionStale) {
        return { kind: "stands" };
      }
    }
    return manager.registeredDeterministic(address)
      ? { kind: "generate", stage: getStage(address) }
      : { kind: "reroll" };
  }

  const unmet = findAllUnmetPrerequisites(
    { animatic: opts.animatic },
    manager.getState(),
    new Set([address]),
  );
  if (unmet.length === 0) return { kind: "accept", variantId: matching };
  return {
    kind: "prerequisite",
    variantId: matching,
    missing: [...new Set(unmet.flatMap((u) => u.missing))],
    // Every file they are owed in, as `assertPrerequisitesMet` names them.
    writeIn: [...new Set(unmet.map((u) => u.writeIn))].join(", "),
  };
}
