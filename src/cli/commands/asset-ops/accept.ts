import * as fs from "node:fs/promises";
import type { Command } from "commander";
import {
  cascadeAcceptConsumedDeps,
  cascadeDirectionReferenceAccepts,
  cascadeDirectionShotAccepts,
  holdsHumanVerdict,
  keepAcceptedInputs,
} from "../../../core/accept-cascade.js";
import {
  CLI_UNACCEPTABLE_SECTION,
  applyDirectionPartDecisions,
  directionAcceptanceView,
  directionCascadeReferenceIds,
  directionCascadeShotIds,
  summarizeDirectionAcceptance,
} from "../../../core/direction-acceptance.js";
import {
  type DefinitionLike,
  directionSectionOf,
  getAssetStage,
  isMaterializedLeafAddress,
  parseAddress,
  parseDirectionScope,
} from "../../../core/address.js";
import {
  commitLeafForAddress,
  definitionHashForAddress,
  discardPreparedLeaf,
  prepareLeafForAddress,
} from "../../../core/composition-resource.js";
import { KonteError } from "../../../core/errors.js";
import { buildDependencyGraph } from "../../../core/graph.js";
import { loadPatchCatalog, patchHashesOf } from "../../../core/patch.js";
import { JobManager } from "../../../core/job-manager.js";
import {
  assertPrerequisitesMet,
  findAllUnmetPrerequisites,
} from "../../../core/review-prerequisites.js";
import { readyUndecidedTakes } from "../../../core/staleness.js";
import { StateManager } from "../../../core/state/index.js";
import { variantDir } from "../../../core/variant-dir.js";
import { confirmAction, printAborted } from "../../confirm.js";
import { loadDirectionIfPresent, loadStageDefinitions } from "../../load-definition.js";
import { resolveVariantArg } from "./resolve-variant-arg.js";
import {
  assertConsentedStale,
  consentToStale,
  printAddresses,
  staleFrom,
} from "./stale-consent.js";
import { requireVideoRoot } from "../../context.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

interface AcceptOptions {
  off?: boolean;
  yes?: boolean;
  no?: boolean;
  verbose?: boolean;
}

export function registerAcceptCommand(program: Command): void {
  program
    .command("accept <targets...>")
    .description("Accept variants, or a part of the direction (--off to clear)")
    .option("--off", "Clear acceptance instead of accepting")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--no", "Abort without prompting (treat confirmation as 'no')")
    .option("-v, --verbose", "List cascaded/stale assets instead of just counting them")
    .addHelpText(
      "after",
      `
Record a human sign-off, or clear one with --off. Each target is a take; the
direction is a target on its own.

A take: a variant id, or an address — which lands on the take that address
resolves to now (accepted, else the newest ready one), so name the id to sign off
an older take. Accepting settles the address: every other take of it still awaiting a
verdict is recorded as dismissed, so nothing asks about them again, and an address left
holding only dismissed takes is generated afresh. Accepting also propagates: dependencies
the variant consumed are
accepted, downstream consumers that relied on the previous output become stale, and the
direction parts the asset speaks for are signed off — for a shot asset, the direction shot and
the acts bracketing it; for a reference asset, the character/prop/location roster
entry it anchors. Before the direction has been accepted end to end that only
renews a part accepted earlier and since changed; after, it settles never-read
parts too, so a shot added mid-production is signed off by the take that plays it.
Clearing acceptance likewise restales downstream consumers. Stale propagation
requires confirmation (-y to proceed, --no to abort).

Several takes are decided together: all resolved before anything is written,
accepted dependencies first, under one confirmation. Two takes of one address
refuse, as does a composition or stem beside another target.

A take whose upstream changed since it was made is kept against the newer upstream:
it stops reading stale, and nothing regenerates it. To replace it instead, run
\`konte reroll <address>\`. An accept that moves what other accepted takes were made
from names them; they stay accepted until cleared with --off.

A deterministic asset (a \`file\`, a trim, a mix, a \`jsxImage\`) accepts here like any
other; only \`dismiss\` refuses it, having no second take to decide for. A composition or stem is accepted by its address,
which materializes it — the board's stem as the mix the motion is driven by.

The direction: "direction" signs off every reviewable part at once (dropping the
sign-off of any part since deleted), "direction:<part>" signs off that one part —
the addresses "konte inspect direction" lists. Waivers are the exception: a waiver
silences a machine finding, so it is accepted only in "konte preview direction",
where the reviewer sees what it silences. Nothing here is gated on the direction
check — the machine's verdict and the human's are separate, and "konte generate"
enforces both.

Examples:
  konte accept v-abc123                    Accept the variant
  konte accept v-abc123 v-def456 -y        Accept several takes at once
  konte accept reference:bgm               Accept whatever that address resolves to
  konte accept v-abc123 --off              Clear the variant's acceptance
  konte accept direction                   Sign off the whole direction
  konte accept direction:brief.logline     Sign off one direction part
  konte accept direction:props.mug --off   Clear that part's sign-off`,
    )
    .action(async (targets: string[], opts: AcceptOptions) => {
      const direction = targets.find((t) => t === "direction" || t.startsWith("direction:"));
      if (direction) {
        if (targets.length > 1) {
          throw new KonteError(
            "TARGETS_CONFLICT",
            `"${direction}" is accepted on its own — run \`konte accept ${direction}\` separately`,
          );
        }
        await runDirectionAcceptance(direction, opts);
        return;
      }
      if (opts.off) {
        await runUnaccept(targets, opts);
        return;
      }
      await runAccept(targets, opts);
    });
}

// `konte accept direction[:<part>]` — the direction's human verdict, recorded from the CLI instead
// of the review page. The direction stage owns no variant, so none of the take machinery below
// applies: there is nothing to materialize, no downstream consumer to restale, and no cascade to
// run. What it writes is the same per-part record `konte preview direction` writes.
//
// It is gated on nothing. The machine's verdict on the direction (`assertDirectionGate`) and the
// human's (`assertDirectionAccepted`) are two independent gates that `konte generate` enforces in
// order, so folding the check in here would duplicate a judgement that this command's result cannot
// keep true anyway — the next edit to direction.ts moves the findings without moving the sign-off.
async function runDirectionAcceptance(target: string, opts: AcceptOptions): Promise<void> {
  const videoRoot = requireVideoRoot();
  const { address } = parseDirectionScope(target);
  const direction = await loadDirectionIfPresent(videoRoot);
  if (!direction) {
    throw new KonteError("ADDRESS_NOT_FOUND", "No direction.ts found in the video root");
  }

  const previewManager = await StateManager.load(videoRoot);
  const acceptance = previewManager.getDirectionAcceptance();
  const view = directionAcceptanceView(direction, acceptance);
  const recorded = Object.keys(acceptance?.parts ?? {});

  // The exact set of parts this run decides, fixed here from the read above — so it is also what the
  // confirmation below describes and what the locked write applies. A record that appears
  // concurrently is simply not in the set, which is the conservative half of that race: this run
  // never decides a part the caller was not shown.
  const decisions = new Map<string, boolean>();

  if (address === null) {
    if (opts.off) {
      if (recorded.length === 0) {
        throw new KonteError(
          "DIRECTION_PART_NOT_ACCEPTED",
          "The direction carries no sign-off to clear",
        );
      }
      for (const part of recorded) decisions.set(part, false);
    } else {
      for (const part of view.parts.keys()) {
        if (directionSectionOf(part) === CLI_UNACCEPTABLE_SECTION) continue;
        decisions.set(part, true);
      }
      // A part accepted and since deleted holds the gate shut while being invisible in the live set,
      // so signing off the whole direction drops it — the same sweep the review page's boxes do.
      for (const part of recorded) {
        if (view.parts.has(part)) continue;
        if (directionSectionOf(part) === CLI_UNACCEPTABLE_SECTION) continue;
        decisions.set(part, false);
      }
    }
  } else if (opts.off) {
    if (!acceptance?.parts[address]) {
      throw new KonteError(
        "DIRECTION_PART_NOT_ACCEPTED",
        `"${address}" carries no sign-off to clear`,
      );
    }
    decisions.set(address, false);
  } else {
    if (directionSectionOf(address) === CLI_UNACCEPTABLE_SECTION) {
      throw new KonteError(
        "INVALID_ADDRESS",
        `Cannot accept "${address}" here: a waiver silences a machine finding, so it is signed off ` +
          "in `konte preview direction`, where the finding it silences is shown next to it",
      );
    }
    if (!view.parts.has(address)) {
      throw new KonteError(
        "ADDRESS_NOT_FOUND",
        acceptance?.parts[address]
          ? `"${address}" is no longer a part of the direction — its sign-off cannot be renewed, only cleared with --off`
          : `No such direction part: "${address}" (run "konte inspect direction" to list them)`,
      );
    }
    decisions.set(address, true);
  }

  // Clearing the whole direction discards every sign-off a human made, and each one costs a read to
  // make again. A single part is one re-read, so it goes through unprompted like the variant path.
  if (address === null && opts.off) {
    console.log(`This will clear ${decisions.size} direction part sign-off(s).`);
    if (!(await confirmAction("Continue?", { yes: opts.yes, no: opts.no }))) {
      printAborted();
      return;
    }
  }

  const result = await StateManager.withLock(videoRoot, async (manager) => {
    const applied = applyDirectionPartDecisions(
      direction,
      manager.getDirectionAcceptance(),
      decisions,
    );
    manager.setDirectionAcceptance(applied.acceptance);
    return applied;
  });

  const summary = summarizeDirectionAcceptance(direction, result.acceptance);
  // Only the whole-direction accept leaves anything behind, and it always leaves the waivers: named
  // rather than counted into the tail line, so "42 of 44" does not read as a bug in what just ran.
  const postView = directionAcceptanceView(direction, result.acceptance);
  const heldWaivers =
    address === null && !opts.off
      ? [...postView.parts]
          .filter(([, status]) => status !== "accepted")
          .map(([part]) => part)
          .filter((part) => directionSectionOf(part) === CLI_UNACCEPTABLE_SECTION)
      : [];

  if (result.accepted.length === 0 && result.revoked.length === 0) {
    console.log(`Unchanged: ${address ?? "direction"} (already recorded as such)`);
  } else if (address !== null) {
    console.log(`${opts.off ? "Cleared" : "Accepted"}: ${address}`);
  } else if (opts.off) {
    console.log(`Cleared: direction — ${result.revoked.length} part(s)`);
  } else {
    const dropped =
      result.revoked.length > 0 ? `  (${result.revoked.length} deleted part(s) dropped)` : "";
    console.log(`Accepted: direction — ${result.accepted.length} part(s)${dropped}`);
  }
  if (heldWaivers.length > 0) {
    console.log(
      `Held: ${heldWaivers.length} waiver part(s) — accept in \`konte preview direction\``,
    );
  }
  console.log(
    summary.status === "accepted"
      ? `Acceptance: accepted (${summary.total} parts)`
      : summary.gateBlocking > 0
        ? `Acceptance: ${summary.gateBlocking} of ${summary.total} part(s) need review`
        : `Acceptance: nothing blocking (${summary.blocking} of ${summary.total} parts changed since accepted)`,
  );
  if (opts.verbose) {
    if (result.accepted.length > 0) printAddresses("Accepted parts", result.accepted, true);
    if (result.revoked.length > 0) printAddresses("Cleared parts", result.revoked, true);
    if (heldWaivers.length > 0) printAddresses("Held waiver parts", heldWaivers, true);
  }
}

type TakeTarget = { address: string; variantId: string };

// Two names for one take (an id and the address showing it) are one target; two takes of one address
// are a contradiction. Ordered dependencies first: a cascade never overwrites an accept, so a named
// take lands before a downstream target's cascade could sign off the one that target consumed.
function resolveAcceptTargets(
  manager: StateManager,
  targets: readonly string[],
  topologicalOrder: readonly string[],
): TakeTarget[] {
  const byAddress = new Map<string, TakeTarget>();
  for (const target of targets) {
    const hit = resolveVariantArg(manager, target);
    const seen = byAddress.get(hit.address);
    if (seen && seen.variantId !== hit.variantId) {
      throw new KonteError(
        "TARGETS_CONFLICT",
        `${hit.address} is named twice (${seen.variantId}, ${hit.variantId}) — an address holds one accept`,
      );
    }
    byAddress.set(hit.address, hit);
  }
  // A leaf named by its variant id escapes the raw-argument check in runAccept.
  const leaf = [...byAddress.keys()].find((address) => isMaterializedLeafAddress(address));
  if (leaf && byAddress.size > 1) {
    throw new KonteError(
      "TARGETS_CONFLICT",
      `A composition or stem is accepted on its own — run \`konte accept ${leaf}\` separately`,
    );
  }
  const rank = new Map(topologicalOrder.map((address, i) => [address, i]));
  const rankOf = (address: string) => rank.get(address) ?? Number.MAX_SAFE_INTEGER;
  return [...byAddress.values()].sort((a, b) => rankOf(a.address) - rankOf(b.address));
}

async function runAccept(targets: string[], opts: AcceptOptions): Promise<void> {
  const videoRoot = requireVideoRoot();
  const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
  // Only for the direction cascade below, so a broken direction.ts must not take the accept down
  // with it — this is not a spend command, and the gate that does demand a loadable direction runs
  // elsewhere. Without one there is simply nothing to cascade into.
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  const graph = buildDependencyGraph(video, animatic, reference);
  // An address argument lands on the take the address resolves to — "accept what was on screen".
  await applyResolutionDefinitions({ videoRoot, definitions: { video, animatic, reference } });

  // A leaf is materialized below from what its upstream resolves to before the lock, so a batch that
  // also moves that upstream would hand it a take nobody signed off.
  const leafTarget = targets.find((t) => t.includes(":") && isMaterializedLeafAddress(t)) ?? null;
  if (leafTarget && targets.length > 1) {
    throw new KonteError(
      "TARGETS_CONFLICT",
      `A composition or stem is accepted on its own — run \`konte accept ${leafTarget}\` separately`,
    );
  }

  // A composition/stem leaf is not pre-materialized — it is a graph leaf rendered from the live
  // definition and materialized only when accepted. So materialize it here first (idempotent),
  // then accept the exact variant it produced — the one this run rendered, which is not what the
  // address would resolve to while an older accepted variant still sits beside it.
  let forcedVariantId: string | null = null;
  // A freshly-rendered leaf variant (not an idempotent reuse) must be undone if the user then
  // declines the accept, so a rejected accept leaves no artifact behind (see the abort branch).
  let materializedFresh = false;
  if (leafTarget) {
    // Rendered from the stage the address names: handing the video definition a board address
    // writes to the wrong stage's shot, or finds nothing there.
    const leafStage = parseAddress(leafTarget).stage === "animatic" ? animatic : video;
    if (!leafStage) {
      throw new KonteError(
        "ADDRESS_NOT_FOUND",
        `Cannot accept "${leafTarget}" — its stage has no definition loaded`,
      );
    }
    // The board's stem is mixed here, outside the lock; the commit under it re-checks its inputs.
    const prepared = await prepareLeafForAddress(
      await StateManager.load(videoRoot),
      leafStage,
      leafTarget,
    );
    const result = await StateManager.withLock(videoRoot, async (m) => {
      const before = new Set(Object.keys(m.tryGetAssetState(leafTarget)?.variants ?? {}));
      const id = prepared ? await commitLeafForAddress(m, leafStage, leafTarget, prepared) : null;
      return { id, fresh: id !== null && !before.has(id) };
    }).finally(() => discardPreparedLeaf(prepared));
    forcedVariantId = result.id;
    materializedFresh = result.fresh;
    if (!forcedVariantId) {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `Nothing to accept for "${leafTarget}" — its upstream refs are not ready, or it has no audio`,
      );
    }
  }

  // Compute (without persisting) which downstream assets this accept would
  // make input-stale, by applying it to an in-memory copy of the state.
  const previewManager = await StateManager.load(videoRoot);
  const items: TakeTarget[] =
    leafTarget && forcedVariantId
      ? [{ address: leafTarget, variantId: forcedVariantId }]
      : resolveAcceptTargets(previewManager, targets, graph.topologicalOrder);
  const addresses = items.map((item) => item.address);
  // An accept signs off everything the review page shows for that target, so it cannot land while
  // the target's review prerequisites are unwritten. Asked across every stage, not just the one
  // owning the address — see findAllUnmetPrerequisites.
  assertPrerequisitesMet(
    findAllUnmetPrerequisites({ animatic }, previewManager.getState(), new Set(addresses)),
    `Cannot accept ${addresses.join(", ")}`,
  );

  // A patch script is the second definition source a take can go stale against, so the candidate
  // set below needs it as it needs the definition hash. A catalog that will not load is swallowed:
  // accept spends nothing.
  const patchHashes = await loadPatchCatalog(videoRoot, previewManager.getState())
    .then(patchHashesOf)
    .catch(() => undefined);
  // The address's live definition, so a take the next `generate` will replace is not counted among
  // the candidates this accept decides against.
  const definitionHashOf = (address: string): string | null => {
    const stageDef: DefinitionLike | null = {
      video,
      animatic,
      reference,
    }[getAssetStage(address)] as DefinitionLike | null;
    return stageDef ? definitionHashForAddress(stageDef, address) : null;
  };
  const cascadeOpts = { video, animatic };
  const jobManager = new JobManager(videoRoot);

  // Preview (no persist) which downstream assets this accept would restale, to drive the prompt.
  // The reported figures are re-derived inside the lock below, so this is only a heads-up estimate.
  const previewRoots: string[] = [];
  for (const { address, variantId } of items) {
    const previous = previewManager.getAcceptedVariant(address);
    previewManager.setAccepted(address, variantId);
    // A leaf's cascade signs off what the leaf DISPLAYS, resolved now — so re-accepting the same
    // variant is not a no-op there: it is how a take swapped under an already-accepted leaf (a panel
    // rerolled under an accepted animatic) gets signed off. A generation variant's cascade replays
    // what its job consumed, so for one there is nothing new to sign and the shortcut stands.
    const cascaded =
      previous !== variantId || isMaterializedLeafAddress(address)
        ? await cascadeAcceptConsumedDeps(
            previewManager,
            jobManager,
            address,
            variantId,
            cascadeOpts,
          )
        : [];
    keepAcceptedInputs(previewManager, address, variantId);
    // Stale dependents of the accepted asset AND of every dependency we accept — a sibling consumer
    // that used a different variant of an accepted dep becomes stale. An accept that changed nothing
    // is no root of its own: its dependents' staleness predates this run.
    previewRoots.push(...(previous === variantId ? cascaded : [address, ...cascaded]));
  }
  const previewStaleMarked = staleFrom(
    previewManager,
    previewRoots.map((address) => ({ address })),
    graph.dependents,
  );

  // Asked off the computed set alone — a re-accept that moved nothing computes an empty one, while a
  // leaf's re-accept can still cascade, and a cascade that propagates stale needs consent whether or
  // not the accept it rode in on changed.
  if (!(await consentToStale(previewStaleMarked, opts))) {
    // Undo the leaf variant we rendered only to preview this accept — declining must not mutate.
    if (leafTarget && materializedFresh && forcedVariantId) {
      await StateManager.withLock(videoRoot, async (m) => {
        m.removeVariant(leafTarget, forcedVariantId!);
      });
      await fs.rm(variantDir(videoRoot, leafTarget, forcedVariantId), {
        recursive: true,
        force: true,
      });
    }
    printAborted();
    return;
  }

  // Exactly which assets the user consented to restale: the set the prompt above showed them.
  // `--yes` is blanket consent, so it needs no set.
  const consentedStale = opts.yes ? null : new Set(previewStaleMarked);

  // Re-derive previous-accepted, cascade, and stale set from inside the lock (like clean does), so
  // the committed figures — and the reported previousAccepted — reflect the real locked state, not
  // the pre-lock preview snapshot a concurrent accept could have invalidated.
  const { results, staleMarked, directionParts, staleAccepted } = await StateManager.withLock(
    videoRoot,
    async (manager) => {
      // A leaf was materialized in an earlier lock and the prompt above may have waited on a human:
      // an input re-picked meanwhile makes it a take nobody signed off, so it is refused here rather
      // than accepted stale.
      if (leafTarget && forcedVariantId) {
        const staleness = manager.variantStaleness(leafTarget, forcedVariantId);
        if (staleness?.inputStale || staleness?.definitionStale) {
          throw new KonteError(
            "DEPENDENCY_NOT_RESOLVED",
            `Cannot accept ${leafTarget}: what it was materialized from changed meanwhile — run the accept again`,
          );
        }
      }
      const results = [];
      const roots: string[] = [];
      for (const { address, variantId } of items) {
        const previousAccepted = manager.getAcceptedVariant(address);
        // The takes this accept decides against: every other take at the address still awaiting a
        // verdict, plus the accept this one moves off — naming another id IS the decision against it.
        // Read inside the lock, so what is dismissed is what stands right now.
        const dismissed = [
          ...readyUndecidedTakes(
            manager.getState(),
            address,
            definitionHashOf(address),
            undefined,
            patchHashes,
            // The rivals settled are the ones the reviewer was shown — read by their resolution.
            manager.stalenessCache(),
          ),
          ...(previousAccepted ? [previousAccepted] : []),
        ].filter((id) => id !== variantId);
        manager.setAccepted(address, variantId, { dismiss: dismissed });
        const cascadeAccepted =
          previousAccepted !== variantId || isMaterializedLeafAddress(address)
            ? await cascadeAcceptConsumedDeps(manager, jobManager, address, variantId, cascadeOpts)
            : [];
        const keptAgainst = keepAcceptedInputs(manager, address, variantId);
        roots.push(
          ...(previousAccepted === variantId ? cascadeAccepted : [address, ...cascadeAccepted]),
        );
        results.push({
          address,
          variantId,
          previousAccepted,
          cascadeAccepted,
          dismissed,
          keptAgainst,
        });
      }
      const staleMarked = staleFrom(
        manager,
        roots.map((address) => ({ address })),
        graph.dependents,
      );
      assertConsentedStale(staleMarked, consentedStale);
      // A human's accept stands against the upstream this one moved.
      const staleAccepted = staleMarked.filter((a) => {
        const id = manager.getAcceptedVariant(a);
        return (
          id !== null &&
          holdsHumanVerdict(manager, a) &&
          manager.variantStaleness(a, id)?.inputStale === true
        );
      });
      // Sideways into the direction, after the graph cascade: the shots this accept settled carry it
      // back to the direction parts that describe them, and an accepted reference image likewise
      // carries the roster entry it anchors.
      const accepted = [...new Set(results.flatMap((r) => [r.address, ...r.cascadeAccepted]))];
      const directionParts = [
        ...cascadeDirectionShotAccepts(manager, direction, directionCascadeShotIds(accepted)),
        ...cascadeDirectionReferenceAccepts(
          manager,
          direction,
          directionCascadeReferenceIds(accepted),
        ),
      ];
      return { results, staleMarked, directionParts, staleAccepted };
    },
  );

  for (const r of results) {
    const extras: string[] = [];
    if (r.cascadeAccepted.length > 0) extras.push(`+${r.cascadeAccepted.length} consumed dep(s)`);
    if (r.dismissed.length > 0) extras.push(`${r.dismissed.length} take(s) dismissed`);
    const suffix = extras.length > 0 ? `  (${extras.join(", ")})` : "";
    console.log(`Accepted: ${r.address} → ${r.variantId}${suffix}`);
    if (r.keptAgainst.length > 0) console.log(`kept against newer: ${r.keptAgainst.join(", ")}`);
  }
  if (directionParts.length > 0) {
    console.log(`Signed off: +${directionParts.length} direction part(s)`);
  }
  if (staleMarked.length > 0 && !opts.verbose) {
    console.log(`${staleMarked.length} asset(s) now stale`);
  }
  if (staleAccepted.length > 0) {
    console.log(
      `${staleAccepted.length} accepted take(s) still on the older upstream (--verbose to list) — ask the human whether to keep them; to regenerate one, run \`konte accept <address> --off\` then \`konte generate <stage>\``,
    );
  }
  if (opts.verbose) {
    const cascaded = [...new Set(results.flatMap((r) => r.cascadeAccepted))];
    const dismissed = results.flatMap((r) => r.dismissed);
    if (cascaded.length > 0)
      printAddresses("Also accepted (consumed dependencies)", cascaded, true);
    if (directionParts.length > 0)
      printAddresses("Also accepted (direction)", directionParts, true);
    if (dismissed.length > 0) printAddresses("Dismissed takes", dismissed, true);
    if (staleMarked.length > 0) printAddresses("Stale assets", staleMarked, true);
    if (staleAccepted.length > 0) {
      printAddresses("Still accepted on the older upstream", staleAccepted, true);
    }
  }
}

// Clearing acts on what is accepted, which for a leaf is not always what the address resolves to —
// an edited leaf's accepted variant goes stale and a fresh one can outrank it. Target the accepted
// one directly; with none there is nothing to clear, said as such rather than reported as some
// resolved variant being "not accepted".
function acceptedTakeOf(manager: StateManager, target: string): TakeTarget {
  let address: string;
  let variantId: string;
  if (target.includes(":") && isMaterializedLeafAddress(target)) {
    const accepted = manager.getAcceptedVariant(target);
    if (!accepted) {
      throw new KonteError(
        "VARIANT_NOT_ACCEPTED",
        `"${target}" has no accepted composition/stem to clear`,
      );
    }
    address = target;
    variantId = accepted;
  } else {
    // A stale deterministic accept stops resolving. With no accept the fallback keeps the existing
    // failure paths.
    const accepted = target.includes(":") ? manager.getAcceptedVariant(target) : null;
    ({ address, variantId } = accepted
      ? { address: target, variantId: accepted }
      : resolveVariantArg(manager, target));
  }
  const isAccepted = manager.getAssetState(address).variants?.[variantId]?.status === "accepted";
  if (!isAccepted) {
    throw new KonteError(
      "VARIANT_NOT_ACCEPTED",
      `Variant "${variantId}" is not accepted for address "${address}"`,
    );
  }
  return { address, variantId };
}

async function runUnaccept(targets: string[], opts: AcceptOptions): Promise<void> {
  const videoRoot = requireVideoRoot();

  // Registered before the target is resolved — without them resolution is blind to the definition
  // axis.
  const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
  await applyResolutionDefinitions({ videoRoot, definitions: { video, animatic, reference } });
  const graph = buildDependencyGraph(video, animatic, reference);

  const previewManager = await StateManager.load(videoRoot);
  // Resolved before anything is applied, so an unknown or unaccepted target fails with nothing
  // half-cleared.
  const resolved = new Map<string, TakeTarget>();
  for (const target of targets) {
    const hit = acceptedTakeOf(previewManager, target);
    resolved.set(`${hit.address}|${hit.variantId}`, hit);
  }
  const items = [...resolved.values()];

  // Clearing acceptance changes the resolved output, so downstream consumers that
  // accepted it become input-stale. Compute (without persisting) which ones, and
  // require consent before propagating.
  for (const { address, variantId } of items) previewManager.setUnaccepted(address, variantId);
  // The memo is taken AFTER the unaccept — this reports what changed because of it.
  const previewStale = staleFrom(previewManager, items, graph.dependents);

  if (!(await consentToStale(previewStale, opts))) {
    printAborted();
    return;
  }

  const consentedStale = opts.yes ? null : new Set(previewStale);

  const staleMarked = await StateManager.withLock(videoRoot, async (manager) => {
    for (const { address, variantId } of items) manager.setUnaccepted(address, variantId);
    // Re-derived from inside the lock, so what is reported is what the committed state says.
    const staleMarked = staleFrom(manager, items, graph.dependents);
    assertConsentedStale(staleMarked, consentedStale);
    return staleMarked;
  });

  for (const { address, variantId } of items) {
    console.log(`Unaccepted: ${address} → ${variantId}`);
  }
  if (staleMarked.length > 0) {
    if (opts.verbose) printAddresses("Stale assets", staleMarked, true);
    else console.log(`${staleMarked.length} asset(s) now stale`);
  }
}
