import type { Command } from "commander";
import {
  isOverlayAddress,
  type AssetStage,
  type ShotStage,
  formatAddress,
  formatCompositionAddress,
  formatPlateAddress,
  formatShotAddress,
  listShotStems,
  formatTimelineAddress,
  formatTimelineStemAddress,
  getAssetEntry,
  isDeliveryAddress,
  isMaterializedLeafAddress,
  isPatchAddress,
  patchSourceVariantIdOf,
  isStemAddress,
  parseAddress,
  parseDirectionScope,
  tryParseAddress,
  validateAddress,
  assetNameOf,
} from "../../core/address.js";
import { acceptedVariant, acceptedVariantId } from "../../core/accepted-variant.js";
import { definitionHashForAddress } from "../../core/composition-resource.js";
import { shotById } from "../../core/shot-index.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import {
  adapterChange,
  diffDefinitions,
  formatDefinitionValue,
  readDefinitionSnapshot,
} from "../../core/definition-snapshot.js";
import { collectShots } from "../../core/direction.js";
import { isAsideShot, isGraphicShot, resolveDirectionTimeline } from "../../core/dsl/direction.js";
import { formatShotSpan } from "../../core/format-duration.js";
import { directionShotCascadeTargets } from "../../core/direction-acceptance.js";
import { KonteError } from "../../core/errors.js";
import { buildDependencyGraph, extractRefs } from "../../core/graph.js";
import { loadPatch, patchStepDependents } from "../../core/patch.js";
import {
  collectStaleVariants,
  computeVariantStaleness,
  formatStaleCause,
  formatStaleReason,
  type PatchHashes,
  resolvedStaleness,
  type StaleVariant,
  type StalenessCache,
} from "../../core/staleness.js";
import { StateManager } from "../../core/state/index.js";
import { readVariantThumbnails } from "../../core/variant-thumbnails.js";
import { generatedOrigin, isReviewLeaf } from "../../core/variant-lineage.js";
import { variantOwningFile } from "../../core/variant-dir.js";
import type {
  AssetDefinition,
  AssetState,
  KonteState,
  VariantState,
} from "../../core/types/index.js";
import { type ScriptLine, scriptLinesToView } from "../../core/types/script.js";
import {
  loadDefinitionForAddress,
  loadDirectionIfPresent,
  loadStageDefinitions,
} from "../../core/stage-definitions.js";
import { requireVideoRoot } from "../context.js";
import { inspectDirection } from "./inspect-direction.js";
import {
  type FeedbackReader,
  type FeedbackView,
  assetFeedbackReader,
  feedbackTag,
  printFeedback,
} from "./inspect-feedback.js";
import {
  applyResolutionDefinitions,
  definitionForAddress,
  type StageDefinitions,
} from "../../core/definition-hashes.js";
import { staleRefreshStep } from "../stale-refresh-step.js";
import {
  type DefinitionWithDuration,
  type ShotLike,
  loadDefinitionWithDuration,
} from "./inspect-definition.js";
import { inspectPrompts, type PromptScope } from "./inspect-prompts.js";
import { type PlateFrame, plateFrameOf } from "../../core/prompt-shots.js";

type InspectScope = PromptScope | { level: "variant"; variantId: string };

// Canonical bare forms shared with clean/status — a trailing ":" or "." matches
// none of these and falls through to the error below.
const STAGE_PATTERN = /^(animatic|video|reference)$/;
const SHOT_PATTERN = /^(animatic|video):shot\.([a-zA-Z0-9_-]+)$/;
const VARIANT_PATTERN = /^v-[A-Za-z0-9_-]+$/;

function parseInspectScope(input: string): InspectScope {
  // The direction stage has its own grammar (feedback-only parts, no asset suffix), so it is routed
  // before the asset forms rather than falling through them.
  if (input === "direction" || input.startsWith("direction:")) {
    return { level: "direction", address: parseDirectionScope(input).address };
  }

  try {
    const parsed = parseAddress(input);
    return { level: "asset", stage: parsed.stage, address: input };
  } catch {
    // not an asset address
  }

  const shotMatch = SHOT_PATTERN.exec(input);
  if (shotMatch) {
    return { level: "shot", stage: shotMatch[1] as ShotStage, shotId: shotMatch[2]! };
  }

  if (input === "animatic:plate") return { level: "plates", stage: "animatic" };

  if (VARIANT_PATTERN.test(input)) return { level: "variant", variantId: input };

  const stageMatch = STAGE_PATTERN.exec(input);
  if (stageMatch) {
    return { level: "stage", stage: stageMatch[1] as AssetStage };
  }

  throw new KonteError(
    "INVALID_ADDRESS",
    `Invalid address-scope format: "${input}" (expected an address, shot scope, stage scope, or variant id — no trailing ":" or ".")`,
  );
}

// A materialized leaf (composition / stem) as a listing row. It has no AssetDefinition — it is
// rendered live from the definition and gains a variant only when accepted — so it carries its own
// kind and live definition hash instead of going through `assetDefHash`.
interface LeafEntry {
  address: string;
  kind: "composition" | "stem";
  defHash: string | null;
}

function leafEntry(
  definition: DefinitionWithDuration,
  address: string,
  kind: LeafEntry["kind"],
): LeafEntry {
  return { address, kind, defHash: definitionHashForAddress(definition, address) };
}

// The no-job leaves a shot offers for review: its composition (it has a shotFn) and its audio stems
// (it has audio cues). Video-stage only — an animatic shot renders no composition.
function shotLeafEntries(
  definition: DefinitionWithDuration,
  stage: AssetStage,
  shot: ShotLike,
): LeafEntry[] {
  if (stage === "reference") return [];
  const entries: LeafEntry[] = [];
  if (shot.shotFn)
    entries.push(leafEntry(definition, formatCompositionAddress(stage, shot.id), "composition"));
  for (const stem of listShotStems(stage, shot)) {
    entries.push(leafEntry(definition, stem.address, "stem"));
  }
  return entries;
}

// The timeline's own leaf: the soundtrack-bed stem, when the video declares beds.
function timelineLeafEntries(definition: DefinitionWithDuration, stage: AssetStage): LeafEntry[] {
  if (stage === "reference" || (definition.timelineSoundtracks?.length ?? 0) === 0) return [];
  return [leafEntry(definition, formatTimelineStemAddress(stage), "stem")];
}

function tryGetAssetState(manager: StateManager, address: string): AssetState | null {
  try {
    return manager.getAssetState(address);
  } catch {
    return null;
  }
}

async function loadManager(videoRoot: string): Promise<StateManager | null> {
  try {
    return await StateManager.load(videoRoot);
  } catch (err) {
    if (err instanceof KonteError && err.code === "STATE_NOT_FOUND") {
      return null;
    }
    throw err;
  }
}

function assetDefHash(assetDef: AssetDefinition): string | null {
  return assetDef.kind === "file" ? null : computeDefinitionHash(assetDef);
}

function formatStaleLine(
  state: KonteState,
  address: string,
  stale: StaleVariant | null,
  currentDefinitionHash: string | null,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): string {
  if (!stale) return "-";
  const cause = formatStaleCause(stale);
  const verdict = cause ? `yes — ${stale.variantId} (${cause})` : `no — ${stale.variantId}`;
  const accepted = acceptedVariant(state, address);
  if (!accepted || accepted.variantId === stale.variantId) return verdict;
  const acceptedCause = formatStaleCause(
    computeVariantStaleness(
      state,
      address,
      accepted.variant,
      currentDefinitionHash,
      patchHashes,
      cache,
    ),
  );
  return `${verdict}; resolves in place of the accepted ${accepted.variantId} (${acceptedCause})`;
}

function formatAssetSummary(
  address: string,
  kind: string,
  state: KonteState | null,
  defHash: string | null,
  feedback: readonly FeedbackView[],
  cache?: StalenessCache,
): string {
  const accepted = state ? acceptedVariantId(state, address) : null;
  const status = accepted ? `accepted: ${accepted}` : "-";
  const staleVariants = state
    ? collectStaleVariants(state, address, defHash, undefined, cache)
    : [];
  const staleInfo = staleVariants.length > 0 ? ` — ${formatStaleReason(staleVariants[0]!)}` : "";
  return `${address} (${kind}): ${status}${staleInfo}${feedbackTag(feedback)}`;
}

async function inspectComposition(videoRoot: string, address: string): Promise<void> {
  const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
  // The hash is read from the stage the address names: asking the video definition for a board leaf
  // reports another shot's hash, or none.
  const stageDef = parseAddress(address).stage === "animatic" ? animatic : video;
  const leafKind = isStemAddress(address)
    ? "stem"
    : isOverlayAddress(address)
      ? "overlay"
      : "composition";
  const defHash = stageDef ? definitionHashForAddress(stageDef, address) : null;
  if (defHash === null) {
    throw new KonteError("ADDRESS_NOT_FOUND", `No ${leafKind} found for address "${address}"`);
  }

  const parsed = parseAddress(address);
  const graph = buildDependencyGraph(video, animatic, reference);
  const depPaths = [...(graph.dependencies.get(address) ?? [])];

  const manager = await loadManager(videoRoot);
  const assetState = manager ? tryGetAssetState(manager, address) : null;
  const state = manager?.getState() ?? null;
  const cache = manager?.stalenessCache();
  const feedback = (await assetFeedbackReader(videoRoot, parsed.stage, state, cache))(address);

  const dependencies = depPaths.map((depAddress) => ({
    address: depAddress,
    acceptedVariantId: manager?.getAcceptedVariant(depAddress) ?? null,
  }));

  const stale = state ? resolvedStaleness(state, address, defHash, undefined, cache) : null;
  const variantEntries = Object.entries(assetState?.variants ?? {});

  console.log(`Address: ${address}`);
  console.log(`Kind: ${leafKind}`);
  if (dependencies.length > 0) {
    console.log("Dependencies:");
    for (const dep of dependencies) {
      console.log(`  ${dep.address} (accepted: ${dep.acceptedVariantId ?? "-"})`);
    }
  } else {
    console.log("Dependencies: none");
  }
  console.log("Dependents: none");

  if (variantEntries.length > 0) {
    console.log(`Accepted: ${(state && acceptedVariantId(state, address)) ?? "-"}`);
    const staleLine = state
      ? formatStaleLine(state, address, stale, defHash, undefined, cache)
      : "-";
    console.log(`Stale: ${staleLine}`);
    console.log("Variants:");
    for (const [vid, v] of variantEntries) {
      const s = state
        ? computeVariantStaleness(state, address, v, defHash, undefined, cache)
        : { inputStale: false, definitionStale: false, patchStale: false, changedInputs: [] };
      const tags: string[] = [];
      if (s.inputStale) tags.push("input-stale");
      if (s.definitionStale) tags.push("definition-stale");
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      console.log(`  ${vid}: ${v.status}${tagStr}`);
      for (const ci of s.changedInputs) {
        console.log(
          `    input-stale: ${ci.address} changed (${ci.recorded.slice(0, 8)} → ${(ci.current ?? "none").slice(0, 8)})`,
        );
      }
    }
  } else {
    console.log(`No ${leafKind} variants yet (not signed off).`);
  }

  printFeedback(feedback);
}

async function inspectAsset(videoRoot: string, address: string): Promise<void> {
  if (isMaterializedLeafAddress(address)) {
    await inspectComposition(videoRoot, address);
    return;
  }

  const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
  const plateFrame = await plateFrameOfAddress(videoRoot, animatic, address);
  const definition = await loadDefinitionForAddress(videoRoot, address);

  let manager = await loadManager(videoRoot);

  // A patch step is declared by its patch script, so it is neither in the stage definition nor in
  // the dependency graph — validating or looking it up there would report a live step as unknown.
  const patchChain =
    isPatchAddress(address) && manager
      ? await loadPatch(videoRoot, manager.getState(), patchSourceVariantIdOf(address)!)
      : null;
  const patchStepDef = patchChain?.assets[assetNameOf(parseAddress(address))] ?? null;
  if (!patchStepDef) validateAddress(address, definition);
  const graph = buildDependencyGraph(video, animatic, reference);

  const assetDef = patchStepDef ?? getAssetEntry(definition, address);
  // A `#delivery` asset is synthesized, not authored — getAssetEntry resolves it to its
  // SOURCE asset (the suffix is stripped), so hashing that here would compare the source definition to
  // the variant's delivery-upscale definition and always read as definition-stale. Its definition hash is
  // re-derived per-variant from the snapshotted target and enforced at export, so (like `status`)
  // skip definition-staleness here; input-staleness (the source changed) still surfaces.
  const currentDefHash =
    isDeliveryAddress(address) || assetDef.kind === "file" ? null : computeDefinitionHash(assetDef);

  // Patch scripts are the second definition source in a video, so staleness here needs them too —
  // otherwise an output produced by an edited script reads fresh in `inspect` while `status`
  // reports it stale, and the two disagree about the same variant. Read off this command's own
  // registration rather than importing every script a second time.
  const patchHashes = manager?.patchHashes();
  // One memo for the whole report, carrying the registered definitions.
  const cache = manager?.stalenessCache();

  let assetState = manager ? tryGetAssetState(manager, address) : null;
  const parsed = parseAddress(address);
  const feedback = (
    await assetFeedbackReader(videoRoot, parsed.stage, manager?.getState() ?? null, cache)
  )(address);
  // A patch step's edges live in its chain, not in the stage graph — reading them from the graph
  // would report every step as depending on nothing and feeding nothing.
  const depPaths = patchChain
    ? [...new Set(extractRefs(assetDef))]
    : [...(graph.dependencies.get(address) ?? [])];
  const depOfPaths = patchChain
    ? patchStepDependents(patchChain, address)
    : [...(graph.dependents.get(address) ?? [])];

  const depsWithAccepted = depPaths.map((depAddress) => ({
    address: depAddress,
    acceptedVariantId: manager?.getAcceptedVariant(depAddress) ?? null,
  }));
  const depOfWithAccepted = depOfPaths.map((depAddress) => ({
    address: depAddress,
    acceptedVariantId: manager?.getAcceptedVariant(depAddress) ?? null,
  }));
  console.log(`Address: ${address}`);
  console.log(`Kind: ${assetDef.kind}`);
  if (plateFrame !== null) {
    console.log(`Within: ${plateFrame.within ?? "root"}`);
    console.log(`Framing: ${plateFrame.framing}`);
    if (plateFrame.view) console.log(`View: ${plateFrame.view}`);
    if (plateFrame.set.length > 0) {
      console.log(`Set: ${plateFrame.set.map((l) => l.label).join(" | ")}`);
    }
  }

  if ("inputs" in assetDef && assetDef.inputs) {
    printInputs(assetDef, "Inputs:");
  } else if (assetDef.kind === "file") {
    console.log(`Path: ${assetDef.path}`);
  }

  if (depsWithAccepted.length > 0) {
    console.log("Dependencies:");
    for (const dep of depsWithAccepted) {
      const accepted = dep.acceptedVariantId ?? "-";
      console.log(`  ${dep.address} (accepted: ${accepted})`);
    }
  } else {
    console.log("Dependencies: none");
  }
  if (depOfWithAccepted.length > 0) {
    console.log("Dependents:");
    for (const dep of depOfWithAccepted) {
      const accepted = dep.acceptedVariantId ?? "-";
      console.log(`  ${dep.address} (accepted: ${accepted})`);
    }
  } else {
    console.log("Dependents: none");
  }

  if (assetState) {
    const state = manager!.getState();
    console.log(`Accepted: ${acceptedVariantId(state, address) ?? "-"}`);
    const stale = resolvedStaleness(state, address, currentDefHash, patchHashes, cache);
    console.log(
      `Stale: ${formatStaleLine(state, address, stale, currentDefHash, patchHashes, cache)}`,
    );
    const allVariants: Array<[string, VariantState]> = [];
    for (const [vid, v] of Object.entries(assetState.variants ?? {})) {
      allVariants.push([vid, v]);
    }
    if (allVariants.length > 0) {
      console.log("Variants:");
      for (const [vid, v] of allVariants) {
        const staleness = computeVariantStaleness(
          state,
          address,
          v,
          currentDefHash,
          patchHashes,
          cache,
        );
        const tags: string[] = [];
        if (staleness.inputStale) tags.push("input-stale");
        if (staleness.patchStale) tags.push("patch-stale");
        if (staleness.definitionStale && !staleness.patchStale) tags.push("definition-stale");
        const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        const fileInfo = v.file ? ` [${v.file}]` : "";
        const thumbs = readVariantThumbnails(videoRoot, address, vid, v.outputHash, v.file);
        const thumbInfo = thumbs.length > 0 ? ` (${thumbs.length} thumbnails)` : "";
        console.log(`  ${vid}: ${v.status}${tagStr}${fileInfo}${thumbInfo}`);
        if (v.seed != null) console.log(`    seed: ${v.seed}`);
        if (v.derivedFrom) {
          const owner = v.file ? variantOwningFile(state, v.file) : null;
          const fileFrom =
            owner && owner.variantId !== vid
              ? `; file from ${owner.address} (${owner.variantId})`
              : "";
          console.log(`    patch of ${v.derivedFrom} (patches/${v.derivedFrom}.ts)${fileFrom}`);
        }
        // Worth saying out loud: this take is no longer one of the choices, so an accept or a
        // reroll aimed at it is not what the reviewer will be looking at. Name the way back only
        // while the script that displaced it is still there.
        if (!isReviewLeaf(state, address, vid)) {
          console.log(
            patchHashes?.has(vid)
              ? `    superseded by a patch (not a review candidate) — konte patch remove ${vid} hands the address back to it`
              : "    superseded by a patch (not a review candidate)",
          );
        }
        const errMsg = typeof v.metadata?.error === "string" ? v.metadata.error : null;
        if (errMsg) console.log(`    error: ${errMsg}`);
        // Decided against: nothing it differs by is review work.
        if (v.status === "dismissed") continue;
        for (const ci of staleness.changedInputs) {
          console.log(
            `    input-stale: ${ci.address} changed (${ci.recorded.slice(0, 8)} → ${(ci.current ?? "none").slice(0, 8)})`,
          );
        }
        if (staleness.patchStale) {
          console.log(
            `    patch-stale: patches/${v.derivedFrom}.ts changed since this take was produced`,
          );
        }
        if (staleness.definitionStale) {
          const snapshot = readDefinitionSnapshot(videoRoot, address, vid);
          const adapter = snapshot ? adapterChange(snapshot, assetDef) : null;
          const changes = snapshot ? diffDefinitions(snapshot, assetDef) : null;
          if (adapter) {
            console.log(`    definition-stale: adapter changed (${adapter.old} → ${adapter.new})`);
          } else if (changes && changes.length > 0) {
            console.log(
              `    definition-stale: definition changed (${changes.length} field${changes.length === 1 ? "" : "s"})`,
            );
            for (const c of changes.slice(0, 10)) {
              console.log(
                `      ${c.path}: ${formatDefinitionValue(c.old)} → ${formatDefinitionValue(c.new)}`,
              );
            }
            if (changes.length > 10) {
              console.log(`      … and ${changes.length - 10} more`);
            }
            console.log(`      the definition it was made from, in full: konte inspect ${vid}`);
          } else if (!staleness.patchStale) {
            console.log(
              changes
                ? "    definition-stale: definition changed (no field-level diff available)"
                : "    definition-stale: definition changed since this variant was generated",
            );
          }
        }
        if (staleness.inputStale || staleness.definitionStale) {
          const step = staleRefreshStep({
            manager: manager!,
            address,
            variantId: vid,
            patchHashes,
            animatic,
            cache,
          });
          if (step.kind !== "none") {
            console.log(
              step.kind === "clean"
                ? "    Suggested: konte clean (its patch script is gone)"
                : step.kind === "patch-apply"
                  ? `    Suggested: konte patch apply ${step.sourceVariantId}`
                  : step.kind === "accept"
                    ? `    Suggested: konte accept ${step.variantId} (already generated, matches the current definition)`
                    : step.kind === "prerequisite"
                      ? `    Suggested: write ${step.missing.join("/")} in ${step.writeIn}, then konte accept ${step.variantId} (already generated, matches the current definition)`
                      : step.kind === "generate"
                        ? `    Suggested: konte generate ${step.stage} (a deterministic take has no alternative to pick)`
                        : step.kind === "review"
                          ? `    Suggested: konte preview ${step.stage} (materialized by its accept)`
                          : step.kind === "stands"
                            ? step.cause === "adapter"
                              ? "    Its adapter changed since; the accept stands"
                              : "    Accepted against an older upstream; the accept stands"
                            : step.kind === "restore"
                              ? `    Suggested: restore the fields above in ${step.file} to what made this take — the accept stands (konte reroll ${address} draws a new take beside it)`
                              : `    Suggested: konte reroll ${address}`,
            );
          }
        }
      }
    }
  }

  printFeedback(feedback);
}

function printInputs(def: AssetDefinition, heading: string): void {
  if (!("inputs" in def) || !def.inputs) return;
  const entries = Object.entries(def.inputs);
  if (entries.length === 0) return;
  console.log(heading);
  const labels = ("inputLabels" in def ? def.inputLabels : undefined) ?? {};
  for (const [key, value] of entries) {
    const name = labels[key];
    const formatted = typeof value === "string" ? value : JSON.stringify(value);
    console.log(`  ${name ? `${name} (${key})` : key}: ${formatted}`);
  }
}

// One take, read from the definition snapshot written when it was generated rather than from the
// stage file, so a take the definition has since moved away from is shown as it was made.
async function inspectVariant(videoRoot: string, variantId: string): Promise<void> {
  const manager = await StateManager.load(videoRoot);
  const address = manager.resolveVariantAddress(variantId);
  const variant = manager.getAssetState(address).variants![variantId]!;
  const staleness = manager.variantStaleness(address, variantId);
  const origin = generatedOrigin(manager.getState(), address, variantId);
  const snapshot = readDefinitionSnapshot(videoRoot, address, origin);

  const tags: string[] = [];
  if (staleness?.inputStale) tags.push("input-stale");
  if (staleness?.patchStale) tags.push("patch-stale");
  if (staleness?.definitionStale && !staleness.patchStale) tags.push("definition-stale");

  console.log(`Variant: ${variantId}`);
  console.log(`Address: ${address}`);
  console.log(`Status: ${variant.status}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`);
  console.log(`File: ${variant.file ?? "-"}`);
  if (variant.seed != null) console.log(`Seed: ${variant.seed}`);
  if (variant.derivedFrom) {
    console.log(
      `Patch of: ${variant.derivedFrom} (patches/${variant.derivedFrom}.ts) — the inputs below are ${origin}'s`,
    );
  }
  for (const ci of staleness?.changedInputs ?? []) {
    console.log(
      `input-stale: ${ci.address} changed (${ci.recorded.slice(0, 8)} → ${(ci.current ?? "none").slice(0, 8)})`,
    );
  }
  if (staleness?.definitionStale && !staleness.patchStale) {
    const current =
      snapshot && !isPatchAddress(address) && !isDeliveryAddress(address)
        ? currentAssetDefinition(await loadStageDefinitions(videoRoot), address)
        : null;
    const adapter = snapshot && current ? adapterChange(snapshot, current) : null;
    const changes = snapshot && current ? diffDefinitions(snapshot, current) : [];
    console.log(
      adapter
        ? `definition-stale: adapter changed (${adapter.old} → ${adapter.new})`
        : changes.length > 0
          ? `definition-stale: changed since this take (${changes.map((c) => c.path).join(", ")})`
          : "definition-stale: definition changed since this take was generated",
    );
  }

  if (!snapshot) {
    console.log("Definition: not recorded for this take");
    return;
  }
  console.log(`Kind: ${snapshot.kind}`);
  if (snapshot.kind === "file") console.log(`Path: ${snapshot.path}`);
  printInputs(snapshot, "Inputs it was made from:");
}

function currentAssetDefinition(
  definitions: StageDefinitions,
  address: string,
): AssetDefinition | null {
  const definition = definitionForAddress(definitions, address);
  if (!definition) return null;
  try {
    return getAssetEntry(definition, address);
  } catch {
    return null;
  }
}

// The direction shot this stage shot realizes — what the shot is *for*, which the stage definition never
// says (it holds assets and timing only). Read tolerantly: a video with no direction.ts yet, a
// broken one, or a shot the direction does not declare all yield null rather than failing an
// inspection of the assets, which stand on their own.
interface ShotView {
  address: string;
  // Null on an aside, along with every other field the arc reads: it performs no dramatic function,
  // is taken from no camera, and nothing acts or speaks in it. `action` then holds its label.
  role: string | null;
  // The frame this shot is taken from; `framing`/`location` are read through it, and are null when
  // the setup is not a declared one (a structural error the direction gate reports on its own).
  setup: string | null;
  framing: string | null;
  location: string | null;
  action: string;
  // The span as the direction wrote it: seconds on the timeline, and beats on the song clock.
  span: string;
  script: readonly ScriptLine[];
  telop: readonly string[];
}

async function loadShot(
  videoRoot: string,
  shotId: string,
): Promise<{ view: ShotView; characterNameById: ReadonlyMap<string, string> } | null> {
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  if (!direction) return null;
  const shot = collectShots(direction).find((s) => s.id === shotId);
  const address = directionShotCascadeTargets(direction).get(shotId)?.[0];
  if (!shot || !address) return null;
  const characterNameById = new Map(
    Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.name] as const),
  );
  const timeline = resolveDirectionTimeline(direction);
  const span = formatShotSpan(
    timeline.timings.get(shot.id)?.duration ?? 0,
    timeline.song ? (shot.beats ?? null) : null,
    timeline.songGrid?.beatsPerBar,
  );
  if (isAsideShot(shot)) {
    return {
      view: {
        address,
        role: null,
        setup: null,
        framing: null,
        location: null,
        action: shot.label,
        span,
        script: [],
        telop: shot.telop ?? [],
      },
      characterNameById,
    };
  }
  const setup = isGraphicShot(shot) ? null : shot.setup;
  return {
    view: {
      address,
      role: shot.role,
      setup,
      framing: setup === null ? null : (direction.setups?.[setup]?.framing ?? null),
      location: setup === null ? null : (direction.setups?.[setup]?.location ?? null),
      action: shot.action,
      span,
      script: shot.script ?? [],
      telop: shot.telop ?? [],
    },
    characterNameById,
  };
}

// Character ids resolve to names — the `action` prose names them that way, so the script reads
// against it — while the setup and location stay their raw ids, which are the roster keys and the
// `animatic:timeline.<id>` / `reference:<id>` assets this inspection sits next to.
function printShot(view: ShotView, characterNameById: ReadonlyMap<string, string>): void {
  console.log("");
  console.log(view.role ? `Role: ${view.role}` : "Aside");
  if (view.setup) console.log(`  Setup:    ${view.setup}`);
  if (view.framing) console.log(`  Framing:  ${view.framing}`);
  if (view.location) console.log(`  Location: ${view.location}`);
  console.log(view.role ? `  Action:   ${view.action}` : `  Label:    ${view.action}`);
  console.log(`  Span:     ${view.span}`);
  const lines = scriptLinesToView(view.script, characterNameById);
  if (lines.length > 0) {
    console.log("  Script:");
    for (const line of lines) {
      console.log(`    ${line.speaker === null ? "(narration)" : `${line.speaker}:`} ${line.text}`);
    }
  }
  if (view.telop.length > 0) {
    console.log("  Telop:");
    for (const text of view.telop) console.log(`    ${text}`);
  }
}

async function inspectShot(videoRoot: string, stage: ShotStage, shotId: string): Promise<void> {
  const definition = await loadDefinitionWithDuration(videoRoot, stage);

  const shot = shotById(definition.shots, shotId);
  if (!shot) {
    throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" not found in ${stage} definition`);
  }

  let startTime = 0;
  for (const s of definition.shots) {
    if (s.id === shotId) break;
    startTime += s.duration;
  }
  const endTime = startTime + shot.duration;

  const manager = await loadManager(videoRoot);
  const state = manager?.getState() ?? null;
  const directionView = await loadShot(videoRoot, shotId);
  const readFeedback = await assetFeedbackReader(
    videoRoot,
    stage,
    state,
    manager?.stalenessCache(),
  );

  const assetEntries = Object.entries(shot.assets).map(([assetName, assetDef]) => {
    const address = formatAddress(stage, shotId, assetName);
    return { assetName, address, assetDef };
  });

  // The shot's no-job leaves (its composition, its audio stem) are reviewable targets alongside its
  // assets, so a listing of the shot has to offer them.
  const leaves = shotLeafEntries(definition, stage, shot);
  // Composite feedback on the shot as a whole hangs off the bare `<stage>:shot.<id>` target — it
  // belongs to no single asset, so this listing is the only place it can surface.
  const shotFeedback = readFeedback(formatShotAddress(stage, shotId));

  console.log(`Shot: ${shotId}`);
  console.log(`Duration: ${shot.duration}s`);
  console.log(`Timeline: ${startTime}s — ${endTime}s`);

  if (directionView) printShot(directionView.view, directionView.characterNameById);

  if (assetEntries.length > 0 || leaves.length > 0) {
    console.log("");
    console.log("Assets:");
    for (const entry of assetEntries) {
      console.log(
        `  ${formatAssetSummary(entry.address, entry.assetDef.kind, state, assetDefHash(entry.assetDef), readFeedback(entry.address))}`,
      );
    }
    for (const leaf of leaves) {
      console.log(`  ${formatLeafSummary(leaf, state, readFeedback)}`);
    }
  }

  printFeedback(shotFeedback);
}

function formatLeafSummary(
  leaf: LeafEntry,
  state: KonteState | null,
  readFeedback: FeedbackReader,
  cache?: StalenessCache,
): string {
  return formatAssetSummary(
    leaf.address,
    leaf.kind,
    state,
    leaf.defHash,
    readFeedback(leaf.address),
    cache,
  );
}

function printShotBlock(
  definition: DefinitionWithDuration,
  shot: ShotLike,
  stage: ShotStage,
  startTime: number,
  manager: StateManager | null,
  readFeedback: FeedbackReader,
  indent: string,
): void {
  const endTime = startTime + shot.duration;
  const state = manager?.getState() ?? null;
  const cache = manager?.stalenessCache();
  const shotFeedback = readFeedback(formatShotAddress(stage, shot.id));
  console.log(
    `${indent}Shot: ${shot.id} (${startTime}s — ${endTime}s, ${shot.duration}s)${feedbackTag(shotFeedback)}`,
  );
  for (const [assetName, assetDef] of Object.entries(shot.assets)) {
    const address = formatAddress(stage, shot.id, assetName);
    console.log(
      `${indent}  ${formatAssetSummary(address, assetDef.kind, state, assetDefHash(assetDef), readFeedback(address), cache)}`,
    );
  }
  for (const leaf of shotLeafEntries(definition, stage, shot)) {
    console.log(`${indent}  ${formatLeafSummary(leaf, state, readFeedback, cache)}`);
  }
}

// The reference stage reuses `topLevelAssets` as its flat pool, but its addresses are bare
// (`reference:<name>`), not `timeline.`-prefixed — and the key IS the suffix, so the stage prefix is
// the whole formatter.
function poolAssetAddress(stage: AssetStage, assetName: string): string {
  return stage === "reference" ? `${stage}:${assetName}` : formatTimelineAddress(stage, assetName);
}

function printTimelineBlock(
  definition: DefinitionWithDuration,
  stage: AssetStage,
  manager: StateManager | null,
  readFeedback: FeedbackReader,
  indent: string,
): void {
  const state = manager?.getState() ?? null;
  const cache = manager?.stalenessCache();
  // The flat-pool stage names its own block; only animatic/video have a timeline.
  const heading = stage === "reference" ? "Reference" : "Timeline";
  console.log(`${indent}${heading}:`);
  for (const [assetName, assetDef] of Object.entries(definition.topLevelAssets ?? {})) {
    const address = poolAssetAddress(stage, assetName);
    console.log(
      `${indent}  ${formatAssetSummary(address, assetDef.kind, state, assetDefHash(assetDef), readFeedback(address), cache)}`,
    );
  }
  for (const leaf of timelineLeafEntries(definition, stage)) {
    console.log(`${indent}  ${formatLeafSummary(leaf, state, readFeedback, cache)}`);
  }
}

async function inspectStage(videoRoot: string, stage: AssetStage): Promise<void> {
  const definition = await loadDefinitionWithDuration(videoRoot, stage);

  const manager = await loadManager(videoRoot);
  const readFeedback = await assetFeedbackReader(
    videoRoot,
    stage,
    manager?.getState() ?? null,
    manager?.stalenessCache(),
  );
  // The reference pool is flat — it declares `shots: []` — so this narrowing skips nothing and
  // hands the shot helpers the stage type a `shot.<id>.<name>` address actually needs.
  const shotStage: ShotStage | null = stage === "reference" ? null : stage;

  let startTime = 0;
  if (shotStage) {
    for (const shot of definition.shots) {
      printShotBlock(definition, shot, shotStage, startTime, manager, readFeedback, "");
      startTime += shot.duration;
    }
  }
  // The timeline block also carries the video's soundtrack stem, so it prints for a video that
  // declares beds and no timeline asset of its own.
  if (
    Object.keys(definition.topLevelAssets ?? {}).length > 0 ||
    timelineLeafEntries(definition, stage).length > 0
  ) {
    printTimelineBlock(definition, stage, manager, readFeedback, "");
  }
}

// Null for any address that is not a returned plate.
async function plateFrameOfAddress(
  videoRoot: string,
  animatic: DefinitionWithDuration | null | undefined,
  address: string,
): Promise<PlateFrame | null> {
  const parsed = tryParseAddress(address);
  if (!parsed || parsed.kind !== "plate") return null;
  if (!animatic?.exposedPlateIds?.includes(parsed.assetName)) return null;
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  return direction ? plateFrameOf(direction, parsed.assetName) : null;
}

async function inspectPlates(videoRoot: string): Promise<void> {
  const definition = await loadDefinitionWithDuration(videoRoot, "animatic");
  const ids = definition.exposedPlateIds ?? [];
  if (ids.length === 0) {
    console.log("No plates returned.");
    return;
  }
  let first = true;
  for (const id of ids) {
    if (!first) console.log("");
    first = false;
    await inspectAsset(videoRoot, formatPlateAddress(id));
  }
}

export function registerInspectCommand(program: Command): void {
  program
    .command("inspect <variantOrScope>")
    .description("Inspect assets at any scope level (asset, shot, or stage)")
    .option("--prompts", "List the text each address feeds a model, instead of asset state")
    .option(
      "--pending-generation",
      "Mark the next generate targets and comparison prompts (requires --prompts)",
    )
    .addHelpText(
      "after",
      `
One target in depth. An asset address reports its
variants, staleness and feedback; a shot scope reports its place on the timeline, the direction shot
it realizes (role, framing, location, action, script) and every target under it — its assets plus the
no-job leaves (composition, stem); a stage scope reports all of them. A video with no direction.ts,
or a shot the direction does not declare, carries no direction shot.

Every listing line carries its comment count. A stale comment — written against a state the target
has since left — is counted but not quoted.

The direction stage reports every reviewable part of the
direction with its acceptance status and feedback, plus the unresolved findings. A part scope
("direction:<part>") adds the words being reviewed, for one part or for every part under a prefix.

A variant id reports that one take: its status and staleness, and the inputs it was made from, in
full — what to write back to make the definition match a take the definition has since moved away
from.

Examples:
  konte inspect v-abc123                One take — the inputs it was made from
  konte inspect video:shot.01.motion    One asset — variants, staleness, feedback
  konte inspect video:shot.01           One shot — its direction shot, timing and assets
  konte inspect animatic                A whole stage
  konte inspect animatic:plate          Every returned plate — what it holds, and its takes
  konte inspect direction               The direction — per-part acceptance and findings
  konte inspect direction:brief         Every part of the brief — its content and feedback
  konte inspect direction:brief.tone    One direction part — its content and feedback

"--prompts" replaces the listing with the text the addresses under the scope feed a model: the
"prompt" / "negativePrompt" conditioning, and the "spokenText" a speech or music model voices.
Values are what "asset()" built, so one assembled from shared constants is listed expanded. A returned
plate is listed first, whether or not a model read a prompt to make it: its "plate" line is the
sentence its author wrote for that frame, which every panel on that setup carries. Above a
shot address it prints what the direction declared for that shot — its "action" (what the shot
lands), its "lineup" (who the frame holds,
left to right, and the order the shot leaves behind, each as "<name> (<id>)"), its "set" (what the
shot's setup holds of its place, left to right, same form — no line where it holds nothing, an
insert) and the "script" lines the address voices,
with each line's "acting" note. An address a shot's <Cutin> draws prints one "cutin" line in place
of the first two — the wipe's setup, who it holds and what that setup holds — and a graphic shot,
taken from no camera, prints neither. konte never turns any of them into prompt text, so they are what the
prompt under them is read against.

On the board it opens with "Keyframes": one line per <Panel>, saying which shot and lane it stands
in, its place there ("panel 1 of 2"), its role and the addresses behind it that carry a prompt, in
declaration order. A frame's only panel is its "key" — the moment the shot reads — unless a
continuous seam runs into the frame; of several, the first is the "opening" and the last the
"landing".

  konte inspect animatic --prompts        Every prompt and spoken line the board declares
  konte inspect animatic:plate --prompts  What each plate holds, and any prompt that made it
  konte inspect video:shot.01 --prompts   One shot's
  konte inspect animatic --prompts --pending-generation
                                        Next generate targets, with comparison prompts
`,
    )
    .action(
      async (variantOrScope: string, opts: { prompts?: boolean; pendingGeneration?: boolean }) => {
        const videoRoot = requireVideoRoot();
        const scope = parseInspectScope(variantOrScope);
        if (
          opts.pendingGeneration &&
          (!opts.prompts || scope.level === "direction" || scope.level === "variant")
        ) {
          throw new KonteError(
            "INVALID_OPTION",
            "--pending-generation requires --prompts and an asset address-scope",
          );
        }
        // Every path below reports staleness, so all of them read the definitions on disk.
        await applyResolutionDefinitions({ videoRoot });

        if (scope.level === "variant") {
          if (opts.prompts) {
            throw new KonteError(
              "INVALID_OPTION",
              `--prompts reads a scope's current definition; "konte inspect ${scope.variantId}" already prints the inputs that take was made from`,
            );
          }
          await inspectVariant(videoRoot, scope.variantId);
          return;
        }

        if (opts.prompts) {
          await inspectPrompts(videoRoot, scope, opts.pendingGeneration);
          return;
        }

        switch (scope.level) {
          case "asset":
            await inspectAsset(videoRoot, scope.address);
            break;
          case "shot":
            await inspectShot(videoRoot, scope.stage, scope.shotId);
            break;
          case "stage":
            await inspectStage(videoRoot, scope.stage);
            break;
          case "plates":
            await inspectPlates(videoRoot);
            break;
          case "direction":
            await inspectDirection(videoRoot, scope.address);
            break;
        }
      },
    );
}
