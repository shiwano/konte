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
  applyDirectionPartDecisions,
  directionSectionAcceptable,
  directionAcceptanceView,
  directionCascadeReferenceIds,
  directionCascadeShotIds,
  summarizeDirectionAcceptance,
} from "../../../core/direction-acceptance.js";
import {
  type DefinitionLike,
  directionSectionOf,
  formatTimelineStemAddress,
  getAssetStage,
  listCompositionAddresses,
  listStemAddresses,
  isMaterializedLeafAddress,
  isStageScope,
  listExposedReferenceAssetPaths,
  listOverlayAddresses,
  matchesAddressScope,
  parseAddress,
  parseDirectionScope,
  parseShotScope,
} from "../../../core/address.js";
import {
  commitLeafForAddress,
  definitionHashForAddress,
  discardPreparedLeaf,
  findMatchingCompositionVariant,
  leafReadyForReview,
  listRemovedShotStemAddresses,
  overlayAwaitsAccept,
  prepareLeafForAddress,
  removedShotStemAddresses,
  shotAcceptsStand,
  unresolvedLeafRefs,
} from "../../../core/composition-resource.js";
import { type Finding, formatFindingLine } from "../../../core/finding.js";
import { shotAcceptTargets } from "../../../core/shot-accept-targets.js";
import { shotById } from "../../../core/shot-index.js";
import { shotAcceptable } from "../../../core/shot-acceptable.js";
import {
  buildReelReviewPlan,
  displayedReferenceVariant,
  reelShotAcceptability,
} from "../../../core/review-acceptability.js";
import { KonteError } from "../../../core/errors.js";
import type { LoadedDefinitions } from "../../../core/select-definition.js";
import { loadPatchCatalog, patchHashesOf } from "../../../core/patch.js";
import { JobManager } from "../../../core/job-manager.js";
import {
  loadCheckContext,
  reviewGate,
  reviewHeldError,
  reviewHeldFindings,
} from "../../finding-gates.js";
import { collectFindings } from "../../../core/checks.js";
import { readyUndecidedVariants } from "../../../core/staleness.js";
import { StateManager } from "../../../core/state/index.js";
import { variantDir } from "../../../core/variant-dir.js";
import { confirmAction, printAborted } from "../../confirm.js";
import { loadDirectionIfPresent } from "../../load-definition.js";
import { openVideoSession } from "../../../core/video-session.js";
import { formatDirectionRemainder } from "../../print-status.js";
import { assertSongLinesPlaced } from "../../../core/direction.js";
import { closeSignedOffFeedback } from "./close-feedback.js";
import { resolveVariantArg } from "./resolve-variant-arg.js";
import {
  assertConsentedStale,
  consentToStale,
  printAddresses,
  staleFrom,
} from "./stale-consent.js";
import { requireVideoRoot } from "../../context.js";
import type { StageDefinitions } from "../../../core/definition-hashes.js";
import {
  isPendingShot,
  type StageDefinition,
  type VariantState,
} from "../../../core/types/index.js";

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
Record a human sign-off, or clear one with --off. Each target is a take or a
direction part; the two are accepted in separate runs.

A take: a variant id, or an address — which lands on the take that address
resolves to now (accepted, else the newest ready one), so name the id to sign off
an older take. An accept made under an older definition resolves instead to the one
ready take beside it; with several, name its id. Accepting settles the address: every
other take of it still awaiting a verdict is recorded as dismissed, so nothing asks about them again, and an address left
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

A standing comment the accept signs off over is closed, and named.

Several takes are decided together: all resolved before anything is written,
accepted dependencies first, under one confirmation; a composition or stem is
rendered from the takes the run accepts upstream of it. Two takes of one address
refuse, as does one named by its id that the run's upstream accepts move.

A shot ("animatic:shot.01") stands for its composition and every stem, and
releases a stem still accepted after the shot stopped mixing into it. A stage
("reference", "animatic", "video") stands for what its review's Accept all signs
off — each reference card's take; each shot, the timeline stem, and the overlay
once every shot accept stands — leaving out, and naming, each one not ready,
held by a finding, or showing an accept a take beside it still awaits a verdict
against. With --off, both stand for those of them accepted.

A take whose upstream changed since it was made is kept against the newer upstream:
it stops reading stale, and nothing regenerates it. To replace it instead, run
\`konte reroll <address>\`. An accept that moves what other accepted takes were made
from names them; they stay accepted until cleared with --off.

A deterministic asset (a \`file\`, a trim, a mix, a \`jsxImage\`) accepts here like any
other; only \`dismiss\` refuses it, having no second take to decide for. A composition or stem is accepted by its address,
which materializes it — the board's stem as the mix the motion is driven by.

The direction: "direction" signs off every reviewable part at once, and
"direction:<part>" every part under that scope — one part ("direction:brief.look")
or a group ("direction:brief"), as "konte inspect direction" lists them; several
scopes are decided together. A scope's accept drops the sign-off of any part under
it since deleted. Nothing here is gated on the direction
check — the machine's verdict and the human's are separate, and "konte generate"
enforces both.

Examples:
  konte accept v-abc123                    Accept the variant
  konte accept v-abc123 v-def456 -y        Accept several takes at once
  konte accept reference:bgm               Accept whatever that address resolves to
  konte accept animatic:shot.01 animatic:shot.02 -y
                                           Accept two shots' compositions and stems
  konte accept video -y                    Accept every ready shot of the video
  konte accept v-abc123 --off              Clear the variant's acceptance
  konte accept direction                   Sign off the whole direction
  konte accept direction:brief.logline     Sign off one direction part
  konte accept direction:brief             Sign off every brief part
  konte accept direction:brief.look direction:props -y
                                           Sign off several direction scopes
  konte accept direction:props.mug --off   Clear that part's sign-off`,
    )
    .action(async (targets: string[], opts: AcceptOptions) => {
      const isDirection = (t: string) => t === "direction" || t.startsWith("direction:");
      const direction = targets.find(isDirection);
      if (direction) {
        const variant = targets.find((t) => !isDirection(t));
        if (variant) {
          throw new KonteError(
            "TARGETS_CONFLICT",
            `"${direction}" is a direction part and "${variant}" a take — accept them in separate runs`,
          );
        }
        await runDirectionAcceptance(targets, opts);
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
// A part a finding to fix sits on is held (REVIEW_HELD); a waivable finding holds nothing here.
async function runDirectionAcceptance(
  scopes: readonly string[],
  opts: AcceptOptions,
): Promise<void> {
  const videoRoot = requireVideoRoot();
  const scopeAddresses = scopes.map((scope) => parseDirectionScope(scope).address);
  const whole = scopeAddresses.includes(null);
  const partScopes = scopeAddresses.filter((a): a is string => a !== null);
  const direction = await loadDirectionIfPresent(videoRoot);
  if (!direction) {
    throw new KonteError("ADDRESS_NOT_FOUND", "No direction.ts found in the video root");
  }

  const previewManager = await StateManager.load(videoRoot);
  const acceptance = previewManager.getDirectionAcceptance();
  const view = directionAcceptanceView(direction, acceptance);
  const recorded = Object.keys(acceptance?.parts ?? {});
  const inScope = (part: string) =>
    whole || partScopes.some((scope) => matchesAddressScope(part, scope));
  const acceptable = (part: string) =>
    directionSectionAcceptable(direction, directionSectionOf(part));

  // The exact set of parts this run decides, fixed here from the read above — so it is also what the
  // confirmation below describes and what the locked write applies. A record that appears
  // concurrently is simply not in the set, which is the conservative half of that race: this run
  // never decides a part the caller was not shown.
  const decisions = new Map<string, boolean>();

  if (opts.off) {
    if (whole && recorded.length === 0) {
      throw new KonteError(
        "DIRECTION_PART_NOT_ACCEPTED",
        "The direction carries no sign-off to clear",
      );
    }
    for (const scope of partScopes) {
      if (!recorded.some((part) => matchesAddressScope(part, scope))) {
        throw new KonteError(
          "DIRECTION_PART_NOT_ACCEPTED",
          `"${scope}" carries no sign-off to clear`,
        );
      }
    }
    for (const part of recorded) {
      if (inScope(part)) decisions.set(part, false);
    }
  } else {
    for (const scope of partScopes) {
      const live = [...view.parts.keys()].filter((part) => matchesAddressScope(part, scope));
      if (live.length > 0 && !live.some(acceptable)) {
        throw new KonteError(
          "DIRECTION_SHOTS_UNWRITTEN",
          `Cannot accept "${scope}": the direction has no shots yet — write them in direction.ts first`,
        );
      }
      if (live.length === 0) {
        throw new KonteError(
          "ADDRESS_NOT_FOUND",
          recorded.some((part) => matchesAddressScope(part, scope))
            ? `"${scope}" is no longer a part of the direction — its sign-off cannot be renewed, only cleared with --off`
            : `No such direction part: "${scope}" (run "konte inspect direction" to list them)`,
        );
      }
    }
    for (const part of view.parts.keys()) {
      if (inScope(part) && acceptable(part)) decisions.set(part, true);
    }
    // A part accepted and since deleted holds the gate shut while being invisible in the live set,
    // so signing off a scope drops the ones under it — the same sweep the review page's boxes do.
    for (const part of recorded) {
      if (view.parts.has(part) || !inScope(part) || !acceptable(part)) continue;
      decisions.set(part, false);
    }
  }

  if (!opts.off) {
    await reviewGate(
      await loadCheckContext({ videoRoot, direction, manager: previewManager }),
      [...decisions].filter(([, accept]) => accept).map(([address]) => ({ op: "accept", address })),
      "Cannot accept the direction",
    );
  }

  // Clearing several sign-offs discards reads a human made, and each one costs a read to make
  // again. A single part is one re-read, so it goes through unprompted like the variant path.
  if (opts.off && decisions.size > 1) {
    const consequence = `This will clear ${decisions.size} direction part sign-off(s).`;
    if (opts.yes || opts.no) console.log(consequence);
    if (!(await confirmAction(consequence, { yes: opts.yes, no: opts.no }))) {
      printAborted();
      return;
    }
  }

  const since = Date.now();
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
  // The flow parts a shotless direction holds back are named rather than counted into the tail
  // line, so "42 of 44" does not read as a bug in what just ran.
  const postView = directionAcceptanceView(direction, result.acceptance);
  const held = opts.off
    ? []
    : [...postView.parts]
        .filter(([part, status]) => status !== "accepted" && inScope(part) && !acceptable(part))
        .map(([part]) => part);

  const label = whole ? "direction" : partScopes.join(", ");
  const singlePart = decisions.size === 1 && partScopes.length === 1 && decisions.has(label);
  if (result.accepted.length === 0 && result.revoked.length === 0) {
    console.log(`Unchanged: ${label} (already recorded as such)`);
  } else if (singlePart) {
    console.log(`${opts.off ? "Cleared" : "Accepted"}: ${label}`);
  } else if (opts.off) {
    console.log(`Cleared: ${label} — ${result.revoked.length} part(s)`);
  } else {
    const dropped =
      result.revoked.length > 0 ? `  (${result.revoked.length} deleted part(s) dropped)` : "";
    console.log(`Accepted: ${label} — ${result.accepted.length} part(s)${dropped}`);
  }
  if (held.length > 0) {
    console.log(
      `Held: ${held.length} flow part(s) — the direction has no shots yet; accept once they are written`,
    );
  }
  console.log(
    summary.status === "accepted"
      ? `Acceptance: accepted (${summary.total} parts)`
      : summary.gateBlocking > 0
        ? `Acceptance: ${summary.gateBlocking} of ${summary.total} part(s) need review`
        : `Acceptance: nothing blocking — ${formatDirectionRemainder(summary)}`,
  );
  if (opts.verbose) {
    if (result.accepted.length > 0) printAddresses("Accepted parts", result.accepted, true);
    if (result.revoked.length > 0) printAddresses("Cleared parts", result.revoked, true);
    if (held.length > 0) printAddresses("Held flow parts", held, true);
  }
  if (!opts.off) await closeSignedOffFeedback(videoRoot, since);
}

type VariantTarget = { address: string; variantId: string };
// `record` is set when the render recorded a new take, which the commit adopts.
type RenderedLeaf = VariantTarget & { record: VariantState | null };
// A conditional leaf (a stage's overlay) is accepted only if the batch before it leaves it owed one.
type BatchEntry =
  | (VariantTarget & { leaf: false })
  | { address: string; leaf: true; conditional?: boolean };
type ShotStages = Pick<LoadedDefinitions, "video" | "animatic">;
type VariantStage = "reference" | "animatic" | "video";

type ShotDecision = { leaves: string[]; released: string[] };

// What one shot decision lands on, as `shotAcceptTargets` enumerates it: the leaves it accepts, and
// the stems it releases — still accepted after the shot stopped mixing anything into them.
function shotDecision(manager: StateManager, def: StageDefinition, shotId: string): ShotDecision {
  const shot = shotById(def.shots, shotId);
  if (!shot) return { leaves: [], released: [] };
  const released = removedShotStemAddresses(manager.getState(), def, shotId);
  const leaves = shotAcceptTargets(manager, def, {
    shotId,
    pending: isPendingShot(shot),
    shotFn: shot.shotFn ?? null,
  }).leaves.map((leaf) => leaf.address);
  return { leaves: leaves.filter((leaf) => !released.includes(leaf)), released };
}

// A shot scope stands for what the shot's review page signs off with one accept.
function shotScopeDecision(
  manager: StateManager,
  stages: ShotStages,
  target: string,
): ShotDecision | null {
  const scope = parseShotScope(target);
  if (!scope) return null;
  const def = scope.stage === "animatic" ? stages.animatic : stages.video;
  const decision = def ? shotDecision(manager, def, scope.shotId) : { leaves: [], released: [] };
  if (decision.leaves.length === 0 && decision.released.length === 0) {
    throw new KonteError("ADDRESS_NOT_FOUND", `"${target}" has no composition or stem to accept`);
  }
  return decision;
}

// One accept toggle of a stage review: `targets` is what accepting it names (a reference card's
// displayed take id, a shot's leaves), empty with `leftOut` set when the run cannot accept it.
type StageUnit = {
  label: string;
  addresses: string[];
  targets: string[];
  released: string[];
  leftOut: string | null;
};

function leafCauses(
  manager: StateManager,
  def: StageDefinition,
  leaves: readonly string[],
  fallback: string,
): string {
  const causes = leaves.flatMap((leaf) =>
    unresolvedLeafRefs(manager, def, leaf).map((ref) => `${ref.address}: ${ref.cause}`),
  );
  return causes.length > 0 ? [...new Set(causes)].join(", ") : fallback;
}

// Which take is meant there is the human's call: the review shows the newest take awaiting a
// verdict beside an accept, while the batch would act on the accept.
function variantsBesideAccept(manager: StateManager, address: string): string[] {
  return manager.getAcceptedVariant(address) ? manager.readyUndecidedVariants(address) : [];
}

function upstreamVariantsBesideAccept(
  manager: StateManager,
  addresses: readonly string[],
): string[] {
  return addresses.flatMap((address) => {
    const rivals = variantsBesideAccept(manager, address);
    return rivals.length > 0
      ? [`${address}: ${rivals.join(", ")} await a verdict beside its accept`]
      : [];
  });
}

// What the stage review's Accept all covers, read through the review's own rules: each reference
// card's displayed take; each shot `shotAcceptable` admits, the timeline stem. The overlay is left
// to the batch (see `overlayAwaitsAccept`). A pending shot or a board aside is no unit. A unit
// whose verdict a take beside an accept still awaits is left out.
function stageUnits(
  manager: StateManager,
  definitions: StageDefinitions,
  stage: VariantStage,
  dependencies: ReadonlyMap<string, readonly string[]>,
): StageUnit[] {
  if (stage === "reference") {
    if (!definitions.reference) {
      throw new KonteError("ADDRESS_NOT_FOUND", "No reference.tsx found in the video root");
    }
    return listExposedReferenceAssetPaths(definitions.reference).map((address) => {
      const variantId = displayedReferenceVariant(manager, address)?.variantId;
      const beside = variantsBesideAccept(manager, address);
      return {
        label: address,
        addresses: [address],
        targets: variantId && beside.length === 0 ? [variantId] : [],
        released: [],
        leftOut: !variantId
          ? "no take yet"
          : beside.length > 0
            ? `${beside.join(", ")} await a verdict beside its accept`
            : null,
      };
    });
  }
  const def = stage === "animatic" ? definitions.animatic : definitions.video;
  if (!def) throw new KonteError("ADDRESS_NOT_FOUND", `No ${stage}.tsx found in the video root`);
  const leafUnit = (
    label: string,
    { leaves, released }: ShotDecision,
    closed: string | null,
  ): StageUnit => {
    const waiting = leaves.filter((leaf) => !leafReadyForReview(manager, def, leaf));
    const beside = upstreamVariantsBesideAccept(manager, [
      ...new Set(leaves.flatMap((leaf) => dependencies.get(leaf) ?? [])),
    ]);
    const leftOut =
      closed ??
      (waiting.length > 0
        ? leafCauses(manager, def, waiting, "not ready")
        : beside.length > 0
          ? beside.join("; ")
          : null);
    return {
      label,
      addresses: leaves,
      targets: leftOut ? [] : leaves,
      released: leftOut ? [] : released,
      leftOut,
    };
  };
  const plan = buildReelReviewPlan(manager, def, definitions.animatic ?? null);
  const units: StageUnit[] = [];
  for (const shot of reelShotAcceptability(manager, def, plan)) {
    const decision = shotDecision(manager, def, shot.shotId);
    if (decision.leaves.length === 0 && decision.released.length === 0) continue;
    const label = `${stage}:shot.${shot.shotId}`;
    if (shotAcceptable(shot)) {
      units.push(leafUnit(label, decision, null));
    } else if (shot.showingStandIn || shot.notReady) {
      const fallback = shot.notReady ? "a track has no take yet" : "no picture of its own yet";
      units.push(leafUnit(label, decision, leafCauses(manager, def, decision.leaves, fallback)));
    }
  }
  if ((def.timelineSoundtracks?.length ?? 0) > 0) {
    const stem = formatTimelineStemAddress(stage);
    units.push(leafUnit(stem, { leaves: [stem], released: [] }, null));
  }
  return units;
}

function stageOverlay(
  stages: Pick<StageDefinitions, "video" | "animatic">,
  stage: VariantStage,
): string[] {
  const def = stage === "animatic" ? stages.animatic : stage === "video" ? stages.video : null;
  return def ? listOverlayAddresses(def) : [];
}

// Every leaf a stage holds and its reference assets — what `--off` may clear, read off the
// definition and the stems still accepted after their shot stopped mixing into them.
function stageAddresses(
  manager: StateManager,
  definitions: StageDefinitions,
  stage: VariantStage,
): string[] {
  if (stage === "reference") {
    if (!definitions.reference) {
      throw new KonteError("ADDRESS_NOT_FOUND", "No reference.tsx found in the video root");
    }
    return listExposedReferenceAssetPaths(definitions.reference);
  }
  const def = stage === "animatic" ? definitions.animatic : definitions.video;
  if (!def) throw new KonteError("ADDRESS_NOT_FOUND", `No ${stage}.tsx found in the video root`);
  return [
    ...listCompositionAddresses(def),
    ...listStemAddresses(def),
    ...listRemovedShotStemAddresses(manager.getState(), def),
    ...listOverlayAddresses(def),
  ];
}

// A stage stands for every unit its review would sign off now, naming each one it leaves out.
function stageScopeTargets(
  manager: StateManager,
  definitions: StageDefinitions,
  stage: VariantStage,
  dependencies: ReadonlyMap<string, readonly string[]>,
  heldFor: (addresses: readonly string[]) => Finding[],
): { targets: string[]; released: string[]; overlay: string | null; skipped: string[] } {
  const targets: string[] = [];
  const released: string[] = [];
  const skipped: string[] = [];
  const heldReason = (held: readonly Finding[]) =>
    `held by a finding to fix — ${held.map(formatFindingLine).join("; ")}`;
  for (const unit of stageUnits(manager, definitions, stage, dependencies)) {
    const held = heldFor(unit.addresses);
    if (unit.leftOut) skipped.push(`${unit.label} — ${unit.leftOut}`);
    else if (held.length > 0) skipped.push(`${unit.label} — ${heldReason(held)}`);
    else {
      targets.push(...unit.targets);
      released.push(...unit.released);
    }
  }
  let overlay = stageOverlay(definitions, stage)[0] ?? null;
  if (overlay) {
    const held = heldFor([overlay]);
    const beside = upstreamVariantsBesideAccept(manager, dependencies.get(overlay) ?? []);
    const leftOut =
      held.length > 0 ? heldReason(held) : beside.length > 0 ? beside.join("; ") : null;
    if (leftOut) {
      skipped.push(`${overlay} — ${leftOut}`);
      overlay = null;
    }
  }
  return { targets, released, overlay, skipped };
}

function leafStage(stages: ShotStages, address: string): StageDefinition {
  // Rendered from the stage the address names: handing the video definition a board address writes
  // to the wrong stage's shot, or finds nothing there.
  const stage = parseAddress(address).stage === "animatic" ? stages.animatic : stages.video;
  if (!stage) {
    throw new KonteError(
      "ADDRESS_NOT_FOUND",
      `Cannot accept "${address}" — its stage has no definition loaded`,
    );
  }
  return stage;
}

// Rendered on a manager that is never saved, from what the batch has accepted before it; reuses a
// matching variant.
async function renderLeaf(
  manager: StateManager,
  stages: ShotStages,
  address: string,
): Promise<RenderedLeaf> {
  const stage = leafStage(stages, address);
  const prepared = await prepareLeafForAddress(manager, stage, address);
  const before = new Set(Object.keys(manager.tryGetAssetState(address)?.variants ?? {}));
  const id = await (
    prepared ? commitLeafForAddress(manager, stage, address, prepared) : Promise.resolve(null)
  ).finally(() => discardPreparedLeaf(prepared));
  if (!id) {
    throw new KonteError(
      "VARIANT_NOT_FOUND",
      `Nothing to accept for "${address}" — its upstream refs are not ready, or it has no audio`,
    );
  }
  const record = before.has(id)
    ? null
    : structuredClone(manager.getAssetState(address).variants![id]!);
  return { address, variantId: id, record };
}

async function removeRenderedLeaves(
  videoRoot: string,
  leaves: readonly RenderedLeaf[],
): Promise<void> {
  await Promise.all(
    leaves
      .filter((leaf) => leaf.record)
      .map((leaf) =>
        fs.rm(variantDir(videoRoot, leaf.address, leaf.variantId), {
          recursive: true,
          force: true,
        }),
      ),
  );
}

type AcceptCascadeOpts = Parameters<typeof cascadeAcceptConsumedDeps>[4];

async function applyAccept(
  manager: StateManager,
  jobManager: JobManager,
  { address, variantId }: VariantTarget,
  cascadeOpts: AcceptCascadeOpts,
  dismiss: readonly string[] = [],
): Promise<{ previous: string | null; cascaded: string[]; keptAgainst: string[] }> {
  const previous = manager.getAcceptedVariant(address);
  manager.setAccepted(address, variantId, { dismiss });
  // A leaf's cascade signs off what the leaf DISPLAYS, resolved now — so re-accepting the same
  // variant is not a no-op there: it is how a take swapped under an already-accepted leaf (a panel
  // rerolled under an accepted animatic) gets signed off. A generation variant's cascade replays
  // what its job consumed, so for one there is nothing new to sign and the shortcut stands.
  const cascaded =
    previous !== variantId || isMaterializedLeafAddress(address)
      ? await cascadeAcceptConsumedDeps(manager, jobManager, address, variantId, cascadeOpts)
      : [];
  const keptAgainst = keepAcceptedInputs(manager, address, variantId);
  return { previous, cascaded, keptAgainst };
}

// An address naming a definition-stale accept means the take a reroll drew beside it.
function replacementForStaleAccept(manager: StateManager, hit: VariantTarget): VariantTarget {
  const variant = manager.getState().assets[hit.address]?.variants?.[hit.variantId];
  if (variant?.status !== "accepted") return hit;
  if (!manager.variantStaleness(hit.address, hit.variantId)?.definitionStale) return hit;
  const rivals = manager.readyUndecidedVariants(hit.address);
  if (rivals.length === 0) return hit;
  if (rivals.length > 1) {
    throw new KonteError(
      "VARIANT_AMBIGUOUS",
      `${hit.address}'s accept ${hit.variantId} predates its definition and ${rivals.length} takes stand beside it — pass a variant id instead. Candidates: ${rivals.join(", ")}`,
    );
  }
  return { address: hit.address, variantId: rivals[0]! };
}

// Two names for one take (an id and the address showing it) are one target; two takes of one address
// are a contradiction. Ordered dependencies first: a cascade never overwrites an accept, so a named
// take lands before a downstream target's cascade could sign off the one that target consumed, and
// a leaf is rendered from the takes named upstream of it.
function orderAcceptBatch(
  manager: StateManager,
  definitions: StageDefinitions,
  targets: readonly string[],
  topologicalOrder: readonly string[],
  conditional: readonly string[],
): BatchEntry[] {
  const isLeafArg = (t: string) => t.includes(":") && isMaterializedLeafAddress(t);
  const byAddress = new Map<string, BatchEntry>();
  for (const address of conditional)
    byAddress.set(address, { address, leaf: true, conditional: true });
  for (const address of targets.filter(isLeafArg)) byAddress.set(address, { address, leaf: true });
  for (const target of targets.filter((t) => !isLeafArg(t))) {
    const named = resolveVariantArg(manager, target, definitions);
    const hit = target.includes(":") ? replacementForStaleAccept(manager, named) : named;
    const seen = byAddress.get(hit.address);
    // A stage's overlay was never named: a take named for it stands instead.
    if (
      seen &&
      !(seen.leaf && seen.conditional) &&
      (seen.leaf || seen.variantId !== hit.variantId)
    ) {
      throw new KonteError(
        "TARGETS_CONFLICT",
        `${hit.address} is named twice (${seen.leaf ? "by its address" : seen.variantId}, ${hit.variantId}) — an address holds one accept`,
      );
    }
    byAddress.set(hit.address, { ...hit, leaf: false });
  }
  const rank = new Map(topologicalOrder.map((address, i) => [address, i]));
  const rankOf = (entry: BatchEntry) =>
    entry.leaf && entry.conditional
      ? Number.MAX_SAFE_INTEGER
      : (rank.get(entry.address) ?? Number.MAX_SAFE_INTEGER - 1);
  return [...byAddress.values()].sort((a, b) => rankOf(a) - rankOf(b));
}

async function runAccept(rawTargets: string[], opts: AcceptOptions): Promise<void> {
  const videoRoot = requireVideoRoot();
  // An address argument lands on the take the address resolves to — "accept what was on screen".
  const {
    definitions: { video, animatic, reference },
    graph,
    manager: loaded,
  } = await openVideoSession(videoRoot);
  const definitions = { video, animatic, reference };
  // Only for the direction cascade below, so a broken direction.ts must not take the accept down
  // with it — this is not a spend command, and the gate that does demand a loadable direction runs
  // elsewhere. Without one there is simply nothing to cascade into.
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  // An accept signs off everything the review page shows for that target, so it cannot land while
  // a finding to fix sits on it: a named target is refused, a stage's unit left out and named.
  // A dep the cascade reaches that one holds is left for its own accept.
  const findings = await collectFindings(
    await loadCheckContext({ videoRoot, definitions, direction, manager: loaded, graph }),
    (t) => t.holds.accept === true,
  );
  const heldFor = (addresses: readonly string[]) =>
    reviewHeldFindings(
      findings,
      addresses.map((address) => ({ op: "accept", address })),
    );
  const skipped: string[] = [];
  const overlays: string[] = [];
  const releasing = new Set<string>();
  const targets = [
    ...new Set(
      rawTargets.flatMap((t) => {
        if (isStageScope(t)) {
          const scoped = stageScopeTargets(
            loaded,
            definitions,
            t as VariantStage,
            graph.dependencies,
            heldFor,
          );
          skipped.push(...scoped.skipped);
          if (scoped.overlay) overlays.push(scoped.overlay);
          for (const stem of scoped.released) releasing.add(stem);
          return scoped.targets;
        }
        const decision = shotScopeDecision(loaded, { video, animatic }, t);
        if (!decision) return [t];
        for (const stem of decision.released) releasing.add(stem);
        return decision.leaves;
      }),
    ),
  ];
  const batch = orderAcceptBatch(
    loaded,
    definitions,
    targets,
    graph.topologicalOrder,
    overlays.filter((overlay) => !targets.includes(overlay)),
  );
  const addresses = batch.flatMap((entry) =>
    entry.leaf && entry.conditional ? [] : [entry.address],
  );
  const held = reviewHeldError(`Cannot accept ${addresses.join(", ")}`, heldFor(addresses));
  if (held) throw held;
  for (const entry of batch) {
    if (entry.leaf) continue;
    assertSongLinesPlaced(videoRoot, direction, loaded.getState(), entry.address, entry.variantId);
  }

  // A patch script is the second definition source a take can go stale against, so the candidate
  // set below needs it as it needs the definition hash. A catalog that will not load is swallowed:
  // accept spends nothing.
  const patchHashes = await loadPatchCatalog(videoRoot, loaded.getState())
    .then(patchHashesOf)
    .catch(() => undefined);
  // The address's live definition, so a take the next `generate` will replace is not counted among
  // the candidates this accept decides against.
  const definitionHashOf = (address: string): string | null => {
    const stageDef = definitions[getAssetStage(address)] as DefinitionLike | null;
    return stageDef ? definitionHashForAddress(stageDef, address) : null;
  };
  const cascadeOpts = {
    ...(video ? { video } : {}),
    animatic,
    held: (address: string) => reviewHeldFindings(findings, [{ op: "accept", address }]).length > 0,
  };
  const jobManager = new JobManager(videoRoot);

  // The batch run in order on a copy that is never saved: each leaf is rendered from the takes
  // accepted before it, and what is left stale drives the prompt. The reported figures are
  // re-derived inside the lock below.
  const rendered: RenderedLeaf[] = [];
  // A leaf rendered here is undone unless the accept it was rendered for commits.
  let committed = false;
  try {
    const preview = await StateManager.load(videoRoot);
    const items: VariantTarget[] = [];
    // A stem the shot stopped mixing into is released with the shot's decision.
    const release = (manager: StateManager): VariantTarget[] =>
      [...releasing].flatMap((address) => {
        const variantId = manager.getAcceptedVariant(address);
        if (!variantId) return [];
        manager.setUnaccepted(address, variantId);
        return [{ address, variantId }];
      });
    const previewRoots: string[] = release(preview).map((r) => r.address);
    for (const entry of batch) {
      if (entry.leaf && entry.conditional) {
        const stage = leafStage({ video, animatic }, entry.address);
        const counterpart = stage.stage === "video" ? animatic : video;
        if (!overlayAwaitsAccept(preview, stage, counterpart)) {
          if (!shotAcceptsStand(preview, stage, counterpart)) {
            skipped.push(`${entry.address} — a shot's accept under it does not stand`);
          }
          continue;
        }
        if (!leafReadyForReview(preview, stage, entry.address)) {
          skipped.push(
            `${entry.address} — ${leafCauses(preview, stage, [entry.address], "not ready")}`,
          );
          continue;
        }
      }
      // A leaf named by its id is the take it is: one this run's upstream accepts move out from under
      // is not what the run renders, so it is refused.
      if (
        !entry.leaf &&
        isMaterializedLeafAddress(entry.address) &&
        preview.variantStaleness(entry.address, entry.variantId)?.inputStale &&
        !loaded.variantStaleness(entry.address, entry.variantId)?.inputStale
      ) {
        throw new KonteError(
          "TARGETS_CONFLICT",
          `${entry.variantId} shows ${entry.address} over takes this run moves — name ${entry.address} instead, to render it from them`,
        );
      }
      let item: VariantTarget;
      if (entry.leaf) {
        const leaf = await renderLeaf(preview, { video, animatic }, entry.address);
        rendered.push(leaf);
        item = { address: leaf.address, variantId: leaf.variantId };
      } else {
        item = { address: entry.address, variantId: entry.variantId };
      }
      items.push(item);
      const { previous, cascaded } = await applyAccept(preview, jobManager, item, cascadeOpts);
      // Stale dependents of the accepted asset AND of every dependency we accept — a sibling consumer
      // that used a different variant of an accepted dep becomes stale. An accept that changed nothing
      // is no root of its own: its dependents' staleness predates this run.
      previewRoots.push(...(previous === item.variantId ? cascaded : [item.address, ...cascaded]));
    }
    if (items.length === 0 && releasing.size === 0) {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `Nothing is ready to accept${skipped.length > 0 ? ` — left unaccepted: ${skipped.join("; ")}` : ""}`,
      );
    }
    const previewStaleMarked = staleFrom(
      preview,
      previewRoots.map((address) => ({ address })),
      graph.dependents,
    );

    // Asked off the computed set alone — a re-accept that moved nothing computes an empty one, while a
    // leaf's re-accept can still cascade, and a cascade that propagates stale needs consent whether or
    // not the accept it rode in on changed.
    if (!(await consentToStale(previewStaleMarked, opts))) {
      printAborted();
      return;
    }

    // Exactly which assets the user consented to restale: the set the prompt above showed them.
    // `--yes` is blanket consent, so it needs no set.
    const consentedStale = opts.yes ? null : new Set(previewStaleMarked);
    const since = Date.now();
    const renderedByAddress = new Map(rendered.map((leaf) => [leaf.address, leaf]));
    const superseded: RenderedLeaf[] = [];

    // Re-derive previous-accepted, cascade, and stale set from inside the lock (like clean does), so
    // the committed figures — and the reported previousAccepted — reflect the real locked state, not
    // the pre-lock preview snapshot a concurrent accept could have invalidated.
    const { results, released, staleMarked, directionParts, staleAccepted } =
      await StateManager.withLock(videoRoot, async (manager) => {
        const results = [];
        const released = release(manager);
        const roots: string[] = released.map((r) => r.address);
        for (const item of items) {
          const { address } = item;
          let { variantId } = item;
          const leaf = renderedByAddress.get(address);
          if (leaf?.record) {
            // Materialized elsewhere meanwhile (a review submit, another accept): that take is reused.
            const existing = manager.tryGetAssetState(address);
            const match =
              existing && leaf.record.definitionHash
                ? findMatchingCompositionVariant(
                    existing,
                    leaf.record.definitionHash,
                    leaf.record.inputFingerprints,
                  )
                : null;
            if (match) {
              superseded.push(leaf);
              variantId = match;
            } else {
              manager.adoptVariant(address, variantId, leaf.record);
            }
          }
          // The prompt above may have waited on a human: an input re-picked meanwhile makes the leaf
          // a take nobody signed off, so it is refused here rather than accepted stale.
          if (leaf) {
            const staleness = manager.variantStaleness(address, variantId);
            if (staleness?.inputStale || staleness?.definitionStale) {
              throw new KonteError(
                "DEPENDENCY_NOT_RESOLVED",
                `Cannot accept ${address}: what it was rendered from changed meanwhile — run the accept again`,
              );
            }
          }
          const previousAccepted = manager.getAcceptedVariant(address);
          // The takes this accept decides against: every other take at the address still awaiting a
          // verdict, plus the accept this one moves off — naming another id IS the decision against it.
          // Read inside the lock, so what is dismissed is what stands right now.
          const dismissed = [
            ...readyUndecidedVariants(
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
          const { cascaded: cascadeAccepted, keptAgainst } = await applyAccept(
            manager,
            jobManager,
            { address, variantId },
            cascadeOpts,
            dismissed,
          );
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
          ...cascadeDirectionShotAccepts(
            manager,
            direction,
            directionCascadeShotIds(accepted),
            cascadeOpts.held,
          ),
          ...cascadeDirectionReferenceAccepts(
            manager,
            direction,
            directionCascadeReferenceIds(accepted),
            cascadeOpts.held,
          ),
        ];
        return { results, released, staleMarked, directionParts, staleAccepted };
      });
    committed = true;
    await removeRenderedLeaves(videoRoot, superseded);

    for (const r of released) console.log(`Unaccepted: ${r.address} → ${r.variantId}`);
    for (const r of results) {
      const extras: string[] = [];
      if (r.cascadeAccepted.length > 0) extras.push(`+${r.cascadeAccepted.length} consumed dep(s)`);
      if (r.dismissed.length > 0) extras.push(`${r.dismissed.length} take(s) dismissed`);
      const suffix = extras.length > 0 ? `  (${extras.join(", ")})` : "";
      console.log(`Accepted: ${r.address} → ${r.variantId}${suffix}`);
      if (r.keptAgainst.length > 0) console.log(`kept against newer: ${r.keptAgainst.join(", ")}`);
    }
    for (const line of skipped) console.log(`Left unaccepted: ${line}`);
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
    await closeSignedOffFeedback(videoRoot, since);
  } finally {
    if (!committed) await removeRenderedLeaves(videoRoot, rendered);
  }
}

// Clearing acts on what is accepted, which for a leaf is not always what the address resolves to —
// an edited leaf's accepted variant goes stale and a fresh one can outrank it. Target the accepted
// one directly; with none there is nothing to clear, said as such rather than reported as some
// resolved variant being "not accepted".
function acceptedVariantOf(
  manager: StateManager,
  definitions: StageDefinitions,
  target: string,
): VariantTarget {
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
      : resolveVariantArg(manager, target, definitions));
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

async function runUnaccept(rawTargets: string[], opts: AcceptOptions): Promise<void> {
  const videoRoot = requireVideoRoot();

  // Registered before the target is resolved — without them resolution is blind to the definition
  // axis.
  const {
    definitions: { video, animatic, reference },
    graph,
    manager: previewManager,
  } = await openVideoSession(videoRoot, { sync: "none" });
  const targets = rawTargets.flatMap((target) => {
    const stage = isStageScope(target) ? (target as VariantStage) : null;
    const scoped = stage
      ? stageAddresses(previewManager, { video, animatic, reference }, stage)
      : (() => {
          const decision = shotScopeDecision(previewManager, { video, animatic }, target);
          return decision && [...decision.leaves, ...decision.released];
        })();
    if (!scoped) return [target];
    const accepted = scoped.filter(
      (address) => previewManager.getAcceptedVariant(address) !== null,
    );
    if (accepted.length === 0) {
      throw new KonteError("VARIANT_NOT_ACCEPTED", `"${target}" has no accepted take to clear`);
    }
    return accepted;
  });
  // Resolved before anything is applied, so an unknown or unaccepted target fails with nothing
  // half-cleared.
  const resolved = new Map<string, VariantTarget>();
  for (const target of targets) {
    const hit = acceptedVariantOf(previewManager, { video, animatic, reference }, target);
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
