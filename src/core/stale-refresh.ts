import { holdsHumanVerdict } from "./accept-cascade.js";
import { type Stage, getStage, isMaterializedLeafAddress, tryParseAddress } from "./address.js";
import { isUnexposedPlateAddress } from "./definition-addresses.js";
import type { AssetStageDefinition, AnimaticDefinition } from "./types/index.js";
import { findAllUnmetPrerequisites } from "./review-prerequisites.js";
import { STAGE_ENTRY_FILE } from "./roots.js";
import type { StateManager } from "./state/index.js";
import type { PatchHashes, StalenessView } from "./staleness.js";

/** A plate's setup and every shot standing on it. */
export type SetupFork = { setupId: string; shotIds: readonly string[] };

/**
 * The fork alternative for a plate address, read off the cascade rather than the `setups` roster: a
 * shot that names the setup but builds on nothing of it pays nothing for the edit (that is
 * `setup-unconsumed`'s business). Null for a non-plate, for a plate one shot alone stands on, and
 * for an intermediate the plates are built from, which is filed under no setup to fork.
 */
export function plateFork(
  address: string,
  cascade: ReadonlyArray<{ address: string }>,
  definition?: AssetStageDefinition,
): SetupFork | null {
  const parsed = tryParseAddress(address);
  if (parsed?.kind !== "plate") return null;
  if (isUnexposedPlateAddress(definition, address)) return null;
  const shotIds = [
    ...new Set(
      cascade.flatMap((c) => {
        const dep = tryParseAddress(c.address);
        return dep?.kind === "shot" ? [dep.shotId] : [];
      }),
    ),
  ];
  return shotIds.length >= 2 ? { setupId: parsed.assetName, shotIds } : null;
}

/**
 * How a take that no longer matches its definition or its inputs is brought back up to date.
 *
 * `patch-apply` / `clean`: a patch output is refreshed by re-applying its correction — a reroll
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
 * `stands`: a human-accepted take whose inputs alone moved (`upstream`), or whose definition moved
 * only under its adapter (`adapter`) — the accept stands; nothing replaces it unless it is cleared.
 *
 * `restore`: a human-accepted take whose own definition moved — the take is the human's pick, so the
 * definition is written back to what made it; a `reroll` would only draw a rival beside it.
 *
 * `reroll`: nothing there fits, so the refresh has to be paid for.
 *
 * `none`: the address's own accepted take is current, so the stale one asked about is an old
 * alternative beside it — or the asset is deterministic and a matching take already resolves in
 * place of its accept.
 */
export type StaleRefreshStep =
  | { kind: "none" }
  | { kind: "patch-apply"; sourceVariantId: string }
  | { kind: "clean" }
  | { kind: "accept"; variantId: string }
  | { kind: "prerequisite"; variantId: string; missing: readonly string[]; writeIn: string }
  | { kind: "generate"; stage: Stage }
  | { kind: "review"; stage: Stage }
  | { kind: "stands"; cause: "upstream" | "adapter" }
  | { kind: "restore"; variantId: string; file: string }
  | { kind: "reroll" };

/**
 * The step for one stale take, shared by `path`, `inspect` and `generate` so they never name
 * different ones about the same take.
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
  animatic: AnimaticDefinition | null | undefined;
  view?: StalenessView;
}): StaleRefreshStep {
  const { manager, address, variantId, patchHashes } = opts;

  // Before the `none` branch: an edited script leaves its output outstanding whatever else the
  // address holds, and `status` lists it under Pending patches.
  const derivedFrom = manager.tryGetAssetState(address)?.variants?.[variantId]?.derivedFrom;
  if (derivedFrom != null) {
    return patchHashes != null && !patchHashes.has(derivedFrom)
      ? { kind: "clean" }
      : { kind: "patch-apply", sourceVariantId: derivedFrom };
  }

  // Asked about a take the address has already moved past: its accepted take stands and is current.
  const accepted = manager.getAcceptedVariant(address);
  if (accepted !== null && accepted !== variantId) {
    const acceptedStaleness = manager.variantStaleness(address, accepted, opts.view);
    if (acceptedStaleness && !acceptedStaleness.inputStale && !acceptedStaleness.definitionStale) {
      return { kind: "none" };
    }
  }

  const matching = (opts.view ?? manager.stalenessView()).newestReadyUndecided(
    address,
    new Set([variantId]),
  );
  if (matching && !isMaterializedLeafAddress(address) && manager.registeredDeterministic(address)) {
    return { kind: "none" };
  }
  if (!matching || opts.animatic === undefined) {
    if (isMaterializedLeafAddress(address)) return { kind: "review", stage: getStage(address) };
    if (accepted === variantId && holdsHumanVerdict(manager, address)) {
      const staleness = manager.variantStaleness(address, variantId, opts.view);
      if (staleness?.definitionStale) {
        return manager.registeredAdapterDrift(address, variantId)
          ? { kind: "stands", cause: "adapter" }
          : { kind: "restore", variantId, file: STAGE_ENTRY_FILE[getStage(address)] };
      }
      if (staleness?.inputStale) return { kind: "stands", cause: "upstream" };
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
    // Every file they are owed in.
    writeIn: [...new Set(unmet.map((u) => u.writeIn))].join(", "),
  };
}

/**
 * A step in words. `command` is null when no command refreshes the take by itself; `alternative` is
 * a second door, offered by `inspect` alone.
 */
export type StaleRefreshAction = {
  command: string | null;
  note: string;
  alternative: string | null;
};

/** Null for `none`: nothing is owed. */
export function staleRefreshAction(
  step: StaleRefreshStep,
  address: string,
): StaleRefreshAction | null {
  const act = (command: string | null, note: string, alternative: string | null = null) => ({
    command,
    note,
    alternative,
  });
  switch (step.kind) {
    case "none":
      return null;
    case "patch-apply":
      return act(`konte patch apply ${step.sourceVariantId}`, "re-applies its correction");
    case "clean":
      return act("konte clean", "its patch script is gone");
    case "accept":
      return act(
        `konte accept ${step.variantId}`,
        "already generated, matches the current definition",
      );
    case "prerequisite":
      return act(
        null,
        `write ${step.missing.join("/")} in ${step.writeIn}, then \`konte accept ${step.variantId}\` (already generated, matches the current definition)`,
      );
    case "generate":
      return act(
        `konte generate ${step.stage}`,
        "re-bakes it; a deterministic take has no alternative to pick",
      );
    case "review":
      return act(
        `konte preview ${step.stage}`,
        "re-accept it there; it is materialized by its accept",
      );
    case "stands":
      return act(
        null,
        step.cause === "adapter"
          ? "its adapter changed since; the accept stands"
          : "accepted against an older upstream; the accept stands",
      );
    case "restore":
      return act(
        null,
        `accepted against a changed definition; the accept stands — restore it in ${step.file} to what made the take (\`konte inspect ${step.variantId}\`) to keep it current`,
        `\`konte reroll ${address}\` draws a new take of the edited definition beside it`,
      );
    case "reroll":
      return act(`konte reroll ${address}`, "rebuilds it");
  }
}

export function formatStaleRefreshAction(action: StaleRefreshAction): string {
  return action.command ? `\`${action.command}\` — ${action.note}` : action.note;
}
