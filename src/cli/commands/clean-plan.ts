import { patchSourceVariantIdOf } from "../../core/address.js";
import { patchChainTargets } from "../../core/patch.js";
import type { KonteState } from "../../core/types/index.js";
import { variantsHostedBy } from "../../core/variant-dir.js";
import { variantLifecycle } from "../../core/variant-lifecycle.js";
import {
  acceptedConsumers,
  collectDescendants,
  isProtectedVariant,
} from "../../core/variant-lineage.js";

// Why a variant is deletable. The last four hold generated media; only `undecided` is added by
// --delete-undecided.
export const CLEAN_CATEGORIES = [
  "failed",
  "cancelled",
  "incomplete",
  "dead leftover",
  "dismissed",
  "stale",
  "unused patch step",
  "undecided",
] as const;
export type CleanCategory = (typeof CLEAN_CATEGORIES)[number];

// Why a variant in scope is kept.
export const KEEP_REASONS = [
  "made-from",
  "accepted-patch-source",
  "generating",
  "patch-applying",
  "undecided",
  "file-host",
  "kept-patch-source",
  "reusable-patch-step",
  "patch-step-input",
  "reclassified",
] as const;
export type KeepReason = (typeof KEEP_REASONS)[number];

export type PatchStepPolicy = {
  reusable: ReadonlySet<string>;
  unloadedSources: ReadonlySet<string> | "all";
};

type CleanCandidate = { address: string; variantId: string; category: CleanCategory };

interface CleanPlanInput {
  state: KonteState;
  addresses: readonly string[];
  /** Variant ids whose media is not in this checkout; never candidates. */
  absent: ReadonlySet<string>;
  /** `<address> <variantId>` keys another pass removes: neither judged here nor survivors. */
  leaving: ReadonlySet<string>;
  /** When set, only these keys are judged, each removable only under its category here. */
  only?: ReadonlyMap<string, CleanCategory>;
  deadLeaves: ReadonlySet<string>;
  isStaleLeftover: (address: string, variantId: string) => boolean;
  stepPolicy: PatchStepPolicy;
  activeJobVariantIds: ReadonlySet<string>;
  deleteUndecided: boolean;
}

interface CleanPlan {
  remove: CleanCandidate[];
  kept: KeepReason[];
}

const keyOf = (address: string, variantId: string) => `${address} ${variantId}`;

// A pending step's job pins its upstream takes before it records them as inputs.
function chainBusy(
  state: KonteState,
  sourceVariantId: string,
  active: ReadonlySet<string>,
): boolean {
  return patchChainTargets(state, sourceVariantId).some((t) => active.has(t.variantId));
}

function usedBySurvivor(
  state: KonteState,
  address: string,
  variantId: string,
  survives: (key: string) => boolean,
): boolean {
  const outputHash = state.assets[address]?.variants?.[variantId]?.outputHash;
  if (outputHash == null) return false;
  for (const [otherAddress, target] of Object.entries(state.assets)) {
    for (const [otherId, variant] of Object.entries(target.variants ?? {})) {
      if (variant.inputFingerprints?.[address] !== outputHash) continue;
      if (survives(keyOf(otherAddress, otherId))) return true;
    }
  }
  return false;
}

export function planClean(input: CleanPlanInput): CleanPlan {
  const { state, activeJobVariantIds: active } = input;
  const candidates: CleanCandidate[] = [];
  const kept: KeepReason[] = [];
  const consumers = acceptedConsumers(state);

  for (const address of input.addresses) {
    const target = state.assets[address];
    if (!target) continue;

    for (const [variantId, variant] of Object.entries(target.variants ?? {})) {
      const key = keyOf(address, variantId);
      if (input.absent.has(variantId) || input.leaving.has(key)) continue;
      if (input.only && !input.only.has(key)) continue;
      // An accepted take's patch source or input is not itself accepted, yet dropping it would
      // leave the accepted take with nothing to re-derive it from.
      if (isProtectedVariant(state, address, variantId, consumers)) {
        if (variant.status === "accepted") continue;
        kept.push(consumers.has(key) ? "made-from" : "accepted-patch-source");
        continue;
      }
      if (active.has(variantId)) {
        kept.push("generating");
        continue;
      }
      // A take whose patch is mid-apply, or a step of that chain: the steps are pinned to the
      // source take, later steps and the finalize read earlier ones, so cutting either now would
      // leave the job unable to settle.
      const stepSource = patchSourceVariantIdOf(address);
      if (
        chainBusy(state, variantId, active) ||
        (stepSource && chainBusy(state, stepSource, active))
      ) {
        kept.push("patch-applying");
        continue;
      }

      const isDeadLeaf = input.deadLeaves.has(key);
      const isDismissed = variant.status === "dismissed";
      let isUnusedStep = false;
      if (stepSource && variant.file && !isDismissed && !input.deleteUndecided) {
        const { unloadedSources, reusable } = input.stepPolicy;
        if (unloadedSources !== "all" && !unloadedSources.has(stepSource)) {
          if (reusable.has(key)) {
            kept.push("reusable-patch-step");
            continue;
          }
          isUnusedStep = true;
        }
      }
      const isStaleLeftover =
        !isDeadLeaf &&
        variant.status === "none" &&
        !!variant.file &&
        input.isStaleLeftover(address, variantId);
      if (
        !input.deleteUndecided &&
        variant.file &&
        !isDeadLeaf &&
        !isDismissed &&
        !isStaleLeftover &&
        !isUnusedStep
      ) {
        kept.push("undecided");
        continue;
      }

      const lifecycle = variantLifecycle(variant);
      const category: CleanCategory =
        lifecycle === "failed"
          ? "failed"
          : lifecycle === "cancelled"
            ? "cancelled"
            : isDeadLeaf
              ? "dead leftover"
              : isDismissed
                ? "dismissed"
                : isStaleLeftover
                  ? "stale"
                  : isUnusedStep
                    ? "unused patch step"
                    : variant.file
                      ? "undecided"
                      : "incomplete";
      if (input.only && input.only.get(key) !== category) {
        kept.push("reclassified");
        continue;
      }
      candidates.push({ address, variantId, category });
    }
  }

  // What is kept keeps what it rests on: the step hosting its file, the step it read, the take
  // its lineage derives from. Keeping one can in turn keep another.
  const removing = new Set(candidates.map((c) => keyOf(c.address, c.variantId)));
  const survives = (key: string) => !removing.has(key) && !input.leaving.has(key);
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of candidates) {
      const key = keyOf(c.address, c.variantId);
      if (!removing.has(key)) continue;
      let reason: KeepReason | null = null;
      if (
        variantsHostedBy(state, c.address, c.variantId).some((r) =>
          survives(keyOf(r.address, r.variantId)),
        )
      ) {
        reason = "file-host";
      } else if (
        c.category === "unused patch step" &&
        usedBySurvivor(state, c.address, c.variantId, survives)
      ) {
        reason = "patch-step-input";
      } else if (
        collectDescendants(state, c.address, c.variantId).some((id) =>
          survives(keyOf(c.address, id)),
        )
      ) {
        reason = "kept-patch-source";
      }
      if (!reason) continue;
      removing.delete(key);
      kept.push(reason);
      changed = true;
    }
  }

  return { remove: candidates.filter((c) => removing.has(keyOf(c.address, c.variantId))), kept };
}
