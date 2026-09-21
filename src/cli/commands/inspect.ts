import type { Command } from "commander";
import {
  type AssetStage,
  type ShotStage,
  formatAddress,
  formatCompositionAddress,
  formatPlateAssetPath,
  formatShotAddress,
  listShotStems,
  formatTimelineAddress,
  formatTimelineStemAddress,
  getAssetEntryByAddress,
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
import { assertNever } from "../../core/assert.js";
import { definitionHashForAddress } from "../../core/composition-resource.js";
import { shotById } from "../../core/shot-index.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import {
  diffDefinitions,
  formatDefinitionValue,
  readDefinitionSnapshot,
} from "../../core/definition-snapshot.js";
import { collectShots } from "../../core/direction.js";
import { isAsideShot, isGraphicShot } from "../../core/dsl/direction.js";
import { directionShotCascadeTargets } from "../../core/direction-acceptance.js";
import { KonteError } from "../../core/errors.js";
import type { PromptOccurrence } from "../../core/prompt-check.js";
import {
  buildDependencyGraph,
  extractRefs,
  listPanelConditioning,
  type PanelConditioning,
  shotLaneChains,
} from "../../core/graph.js";
import { loadAnimatic } from "../../core/loader.js";
import { loadPatch, patchStepDependents } from "../../core/patch.js";
import {
  collectStaleVariants,
  computeVariantStaleness,
  formatStaleCause,
  formatStaleReason,
  resolvedStaleness,
  type StaleVariant,
  type StalenessCache,
} from "../../core/staleness.js";
import { StateManager } from "../../core/state/index.js";
import { readVariantThumbnails } from "../../core/thumbnail.js";
import { isReviewLeaf } from "../../core/variant-lineage.js";
import { variantOwningFile } from "../../core/variant-dir.js";
import type {
  AssetDefinition,
  AssetState,
  KonteState,
  ShotDefinition,
  VariantState,
} from "../../core/types/index.js";
import { type ScriptLine, scriptLinesToView } from "../../core/types/script.js";
import type { Respelling } from "../../core/types/definition.js";
import { spellingsOf } from "../../core/dsl/respell.js";
import {
  loadDefinitionForAddress,
  loadDirectionIfPresent,
  loadStageDefinitions,
  loadVideoAndAnimatic,
} from "../load-definition.js";
import { loadReference } from "../../core/loader.js";
import { requireVideoRoot } from "../context.js";
import { inspectDirection } from "./inspect-direction.js";
import {
  type FeedbackReader,
  type FeedbackView,
  assetFeedbackReader,
  feedbackTag,
  printFeedback,
} from "./inspect-feedback.js";
import { applyResolutionDefinitions } from "../../core/definition-hashes.js";
import { staleRefreshStep } from "../stale-refresh-step.js";

type InspectScope =
  | { level: "asset"; stage: AssetStage; address: string }
  | { level: "shot"; stage: ShotStage; shotId: string }
  | { level: "stage"; stage: AssetStage }
  // Every plate the animatic returned (`animatic:plate`).
  | { level: "plates"; stage: "animatic" }
  // The direction: the whole stage, or one of its parts (`address` null / set).
  | { level: "direction"; address: string | null };

// Canonical bare forms shared with clean/prune/status — a trailing ":" or "." matches
// none of these and falls through to the error below.
const STAGE_PATTERN = /^(animatic|video|reference)$/;
const SHOT_PATTERN = /^(animatic|video):shot\.([a-zA-Z0-9_-]+)$/;

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

  const stageMatch = STAGE_PATTERN.exec(input);
  if (stageMatch) {
    return { level: "stage", stage: stageMatch[1] as AssetStage };
  }

  throw new KonteError(
    "INVALID_ADDRESS",
    `Invalid address-scope format: "${input}" (expected an address, shot scope, or stage scope — no trailing ":" or ".")`,
  );
}

interface ShotLike {
  id: string;
  duration: number;
  assets: Record<string, AssetDefinition>;
  pending?: boolean;
  // What makes the shot carry a composition / an audio stem. Both are declared here so a listing
  // can offer those no-job leaves without casting to VideoDefinition per call.
  shotFn?: unknown;
  stemRefs?: readonly string[];
  narrationStemRefs?: readonly string[];
  compositionRefs?: string[];
  panels?: ShotDefinition["panels"];
  cutin?: ShotDefinition["cutin"];
}

interface DefinitionWithDuration {
  shots: ShotLike[];
  topLevelAssets?: Record<string, AssetDefinition>;
  timelineSoundtracks?: readonly unknown[];
  prompts?: readonly PromptOccurrence[];
  respellings?: readonly Respelling[];
  // Animatic only: the returned plates, in return order, and the sentence each says it holds.
  exposedPlateIds?: string[];
  platePrompts?: Record<string, string>;
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

async function loadDefinitionWithDuration(
  videoRoot: string,
  stage: AssetStage,
): Promise<DefinitionWithDuration> {
  switch (stage) {
    case "reference":
      return loadReference(videoRoot);
    case "video": {
      const { video } = await loadVideoAndAnimatic(videoRoot);
      return video;
    }
    case "animatic":
      return await loadAnimatic(videoRoot);
    default:
      return assertNever(stage, "loadDefinitionWithDuration");
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

function getAcceptedVariant(assetState: AssetState | null): string | null {
  if (!assetState?.variants) return null;
  return Object.entries(assetState.variants).find(([, v]) => v.status === "accepted")?.[0] ?? null;
}

function assetDefHash(assetDef: AssetDefinition): string | null {
  return assetDef.kind === "file" ? null : computeDefinitionHash(assetDef);
}

function formatStaleLine(stale: StaleVariant | null): string {
  if (!stale) return "-";
  const cause = formatStaleCause(stale);
  return cause ? `yes — ${stale.variantId} (${cause})` : "no";
}

function formatAssetSummary(
  address: string,
  kind: string,
  assetState: AssetState | null,
  state: KonteState | null,
  defHash: string | null,
  feedback: readonly FeedbackView[],
  cache?: StalenessCache,
): string {
  const accepted = getAcceptedVariant(assetState);
  const status = accepted ? `accepted: ${accepted}` : "-";
  const staleVariants = state
    ? collectStaleVariants(state, address, defHash, undefined, cache)
    : [];
  const staleInfo = staleVariants.length > 0 ? ` — ${formatStaleReason(staleVariants[0]!)}` : "";
  return `${address} (${kind}): ${status}${staleInfo}${feedbackTag(feedback)}`;
}

async function inspectComposition(videoRoot: string, address: string): Promise<void> {
  const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
  const leafKind = isStemAddress(address) ? "stem" : "composition";
  // The hash is read from the stage the address names: asking the video definition for a board leaf
  // reports another shot's hash, or none.
  const stageDef = parseAddress(address).stage === "animatic" ? animatic : video;
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
    console.log(`Accepted: ${getAcceptedVariant(assetState) ?? "-"}`);
    console.log(`Stale: ${formatStaleLine(stale)}`);
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
          `    input-stale: ${ci.assetPath} changed (${ci.recorded.slice(0, 8)} → ${(ci.current ?? "none").slice(0, 8)})`,
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
  const platePrompt = platePromptOf(animatic, address);
  const plateWithin = platePrompt === null ? null : await plateWithinOf(videoRoot, address);
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

  const assetDef = patchStepDef ?? getAssetEntryByAddress(definition, address);
  // A `#delivery` asset is synthesized, not authored — getAssetEntryByAddress resolves it to its
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
  if (platePrompt !== null) {
    console.log(`Within: ${plateWithin ?? "root"}`);
    console.log(`Plate: ${platePrompt}`);
  }

  if ("inputs" in assetDef && assetDef.inputs) {
    const entries = Object.entries(assetDef.inputs);
    if (entries.length > 0) {
      const labels = ("inputLabels" in assetDef ? assetDef.inputLabels : undefined) ?? {};
      console.log("Inputs:");
      for (const [key, value] of entries) {
        const name = labels[key];
        const formatted = typeof value === "string" ? value : JSON.stringify(value);
        console.log(`  ${name ? `${name} (${key})` : key}: ${formatted}`);
      }
    }
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
    const acceptedEntries: Array<string> = [];
    for (const [vid, v] of Object.entries(assetState.variants ?? {})) {
      if (v.status === "accepted") {
        acceptedEntries.push(vid);
      }
    }
    if (acceptedEntries.length > 0) {
      console.log(`Accepted: ${acceptedEntries.join(", ")}`);
    } else {
      console.log("Accepted: -");
    }
    const state = manager!.getState();
    const stale = resolvedStaleness(state, address, currentDefHash, patchHashes, cache);
    console.log(`Stale: ${formatStaleLine(stale)}`);
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
        if (v.derivedFrom) {
          const owner = v.file ? variantOwningFile(state, v.file) : null;
          const fileFrom =
            owner && owner.variantId !== vid
              ? `; file from ${owner.address} (${owner.variantId})`
              : "";
          console.log(`    patch of ${v.derivedFrom} (patches/${v.derivedFrom}.ts)${fileFrom}`);
        }
        if (v.turbo) {
          console.log(
            "    turbo: the address's first take, on its adapter's turbo inputs — every later take uses the defaults",
          );
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
        for (const ci of staleness.changedInputs) {
          console.log(
            `    input-stale: ${ci.assetPath} changed (${ci.recorded.slice(0, 8)} → ${(ci.current ?? "none").slice(0, 8)})`,
          );
        }
        if (staleness.patchStale) {
          console.log(
            `    patch-stale: patches/${v.derivedFrom}.ts changed since this take was produced`,
          );
        }
        if (staleness.definitionStale) {
          const snapshot = readDefinitionSnapshot(videoRoot, address, vid);
          const changes = snapshot ? diffDefinitions(snapshot, assetDef) : null;
          if (changes && changes.length > 0) {
            const fields = changes.map((c) => c.path).join(", ");
            console.log(`    definition-stale: definition changed (${fields})`);
            for (const c of changes.slice(0, 10)) {
              console.log(
                `      ${c.path}: ${formatDefinitionValue(c.old)} → ${formatDefinitionValue(c.new)}`,
              );
            }
            if (changes.length > 10) {
              console.log(`      … and ${changes.length - 10} more`);
            }
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
              step.kind === "prune"
                ? "    Suggested: konte prune (its patch script is gone)"
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
                            ? "    Accepted against an older upstream; the accept stands"
                            : `    Suggested: konte reroll ${address}`,
            );
          }
        }
      }
    }
  }

  printFeedback(feedback);
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
  duration: number;
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
  if (isAsideShot(shot)) {
    return {
      view: {
        address,
        role: null,
        setup: null,
        framing: null,
        location: null,
        action: shot.label,
        duration: shot.duration,
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
      duration: shot.duration,
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
    const assetState = manager ? tryGetAssetState(manager, address) : null;
    return { assetName, address, assetDef, assetState };
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
        `  ${formatAssetSummary(entry.address, entry.assetDef.kind, entry.assetState, state, assetDefHash(entry.assetDef), readFeedback(entry.address))}`,
      );
    }
    for (const leaf of leaves) {
      console.log(`  ${formatLeafSummary(leaf, manager, state, readFeedback)}`);
    }
  }

  printFeedback(shotFeedback);
}

function formatLeafSummary(
  leaf: LeafEntry,
  manager: StateManager | null,
  state: KonteState | null,
  readFeedback: FeedbackReader,
  cache?: StalenessCache,
): string {
  const leafState = manager ? tryGetAssetState(manager, leaf.address) : null;
  return formatAssetSummary(
    leaf.address,
    leaf.kind,
    leafState,
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
    const assetState = manager ? tryGetAssetState(manager, address) : null;
    console.log(
      `${indent}  ${formatAssetSummary(address, assetDef.kind, assetState, state, assetDefHash(assetDef), readFeedback(address), cache)}`,
    );
  }
  for (const leaf of shotLeafEntries(definition, stage, shot)) {
    console.log(`${indent}  ${formatLeafSummary(leaf, manager, state, readFeedback, cache)}`);
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
    const assetState = manager ? tryGetAssetState(manager, address) : null;
    console.log(
      `${indent}  ${formatAssetSummary(address, assetDef.kind, assetState, state, assetDefHash(assetDef), readFeedback(address), cache)}`,
    );
  }
  for (const leaf of timelineLeafEntries(definition, stage)) {
    console.log(`${indent}  ${formatLeafSummary(leaf, manager, state, readFeedback, cache)}`);
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

// The text every model under a scope will read: the `"prompt"` / `"negativePrompt"` conditioning
// and the `"spokenText"` a speech or music model voices, each at the address that declares it.
// Collected as `asset()` ran, so a value assembled from shared constants is listed expanded. A
// patch script's steps declare their own and are not listed here.
async function inspectPrompts(videoRoot: string, scope: InspectScope): Promise<void> {
  const stage = scope.level === "direction" ? null : scope.stage;
  const definition = stage ? await loadDefinitionWithDuration(videoRoot, stage) : null;
  const prompts = definition?.prompts ?? [];
  const respellings = definition?.respellings;
  const promptShots = await loadPromptShots(videoRoot);

  const prefix =
    scope.level === "shot"
      ? `${formatShotAddress(scope.stage, scope.shotId)}.`
      : scope.level === "plates"
        ? "animatic:plate."
        : undefined;
  const matches = prompts.filter((p) =>
    scope.level === "asset"
      ? p.address === scope.address
      : prefix !== undefined
        ? p.address.startsWith(prefix)
        : true,
  );
  const plates = platesUnderScope(definition, scope, promptShots);
  const cutinAddresses =
    definition && stage ? cutinLaneAddresses(stage, definition) : new Set<string>();
  const keyframes = keyframesUnderScope(definition, stage, matches);

  const kindOf = (p: PromptOccurrence): string =>
    p.spoken ? "spokenText" : p.negative ? "negativePrompt" : "prompt";

  // The address's occurrences grouped, so the shot's declarations are stated once above them.
  const byAddress = new Map<string, PromptOccurrence[]>();
  for (const p of matches) {
    const bucket = byAddress.get(p.address) ?? [];
    bucket.push(p);
    byAddress.set(p.address, bucket);
  }

  if (matches.length === 0 && plates.length === 0) {
    console.log("No prompts declared under this scope.");
    return;
  }

  const printOccurrences = (occurrences: readonly PromptOccurrence[]) => {
    for (const p of occurrences) {
      const body = p.value.split("\n").join("\n      ");
      console.log(`  ${p.input} (${kindOf(p)})`);
      console.log(`      ${body}`);
    }
  };

  // Which prompts make each keyframe, ahead of the text they carry.
  if (keyframes.length > 0) {
    console.log("Keyframes:");
    for (const k of keyframes) {
      console.log(`  shot ${k.shotId} · panel ${k.index} of ${k.of} · ${k.lane}   ${k.panel}`);
      console.log(`    conditioning: ${k.conditioning.join(", ") || "(none)"}`);
    }
    console.log("");
  }

  // A plate is listed first, in return order, whether or not a model read a prompt to make it.
  let first = true;
  for (const plate of plates) {
    if (!first) console.log("");
    first = false;
    console.log(plate.address);
    console.log(`  within: ${plate.within ?? "root"}`);
    console.log(`  plate: ${plate.prompt}`);
    printOccurrences(byAddress.get(plate.address) ?? []);
  }

  const plateAddresses = new Set(plates.map((p) => p.address));
  for (const [address, occurrences] of byAddress) {
    if (plateAddresses.has(address)) continue;
    if (!first) console.log("");
    first = false;
    console.log(address);
    for (const line of promptShotLines(
      promptShots,
      respellings,
      address,
      occurrences,
      cutinAddresses.has(address),
    )) {
      console.log(`  ${line}`);
    }
    printOccurrences(occurrences);
  }
}

// The keyframes whose conditioning the listing carries: a panel fed by a prompt under this scope.
// Every address behind the panel stays in `conditioning`, this scope's or not — a narrower scope
// cuts the listing, never the frame.
function keyframesUnderScope(
  definition: DefinitionWithDuration | null,
  stage: AssetStage | null,
  matches: readonly PromptOccurrence[],
): PanelConditioning[] {
  if (!definition || stage !== "animatic") return [];
  const listed = new Set(matches.map((p) => p.address));
  return listPanelConditioning(definition).filter((k) =>
    k.conditioning.some((address) => listed.has(address)),
  );
}

// The addresses only a shot's `<Cutin>` reaches. One the main frame reaches too keeps the shot's
// lines.
function cutinLaneAddresses(stage: AssetStage, definition: DefinitionWithDuration): Set<string> {
  const out = new Set<string>();
  if (stage !== "animatic" && stage !== "video") return out;
  for (const shot of definition.shots) {
    if (!shot.cutin) continue;
    const { main, cutin } = shotLaneChains(stage, shot);
    for (const address of cutin) if (!main.has(address)) out.add(address);
  }
  return out;
}

// The wider frame a plate's setup declares itself a window of; null at the root of its own camera
// axis, and for any address that is not a plate.
async function plateWithinOf(videoRoot: string, address: string): Promise<string | null> {
  const parsed = tryParseAddress(address);
  if (!parsed || parsed.kind !== "plate") return null;
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  return direction?.setups?.[parsed.assetName]?.within ?? null;
}

// What a returned plate says it holds, for a plate address; null for any other address or an
// intermediate the plates callback did not return.
function platePromptOf(
  animatic: DefinitionWithDuration | null | undefined,
  address: string,
): string | null {
  const parsed = tryParseAddress(address);
  if (!parsed || parsed.kind !== "plate") return null;
  return animatic?.platePrompts?.[parsed.assetName] ?? null;
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
    await inspectAsset(videoRoot, formatPlateAssetPath(id));
  }
}

function platesUnderScope(
  definition: DefinitionWithDuration | null,
  scope: InspectScope,
  promptShots: PromptShots | null,
): { address: string; prompt: string; within: string | null }[] {
  if (!definition?.platePrompts) return [];
  if (scope.level === "shot" || scope.level === "direction") return [];
  const out: { address: string; prompt: string; within: string | null }[] = [];
  for (const id of definition.exposedPlateIds ?? []) {
    const prompt = definition.platePrompts[id];
    if (prompt === undefined) continue;
    const address = formatPlateAssetPath(id);
    if (scope.level === "asset" && scope.address !== address) continue;
    out.push({ address, prompt, within: promptShots?.within.get(id) ?? null });
  }
  return out;
}

// The direction facts printed beside a stage's prompts: what each shot lands, who its frame holds
// left to right, and the lines it speaks with the acting they are to be said with. Best-effort: a
// video with no direction.ts prints prompts alone.
interface PromptShots {
  action: Map<string, string>;
  lineup: Map<string, { lineup: readonly string[]; lineupTo: readonly string[] | null }>;
  // What the shot's frame carries of its set, left to right — the setup's `holds`, resolved to the
  // landmarks of the place it is set in. Empty on an insert, which holds nothing; absent only for a
  // shot whose setup the roster does not declare, so a reader can tell the two apart.
  set: Map<string, { id: string; label: string }[]>;
  // Per SETUP id, not per shot: the wider frame that one steps in from, null where there is
  // none — a frame that declared nothing answers as a root here, and the two are told apart on the
  // direction's own surfaces.
  within: Map<string, string | null>;
  // Printed above the addresses only the `<Cutin>` reaches, in place of the shot's own frame.
  cutin: Map<
    string,
    {
      setup: string;
      lineup: readonly string[];
      lineupTo: readonly string[] | null;
      set: { id: string; label: string }[] | null;
    }
  >;
  script: Map<string, { speaker: string; text: string; acting: string | null }[]>;
  // `<name> (<id>)`, the form the script line's speaker uses: the prompt names a subject by its
  // roster NAME, and a reader barred from `direction.ts` has no roster to map an id through. The
  label: (id: string) => string;
}

async function loadPromptShots(videoRoot: string): Promise<PromptShots | null> {
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  if (!direction) return null;
  const nameById = new Map(
    Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.name]),
  );
  // An id the character roster does not hold is a structural error, so it is labelled as itself.
  const label = (id: string): string => {
    const name = nameById.get(id);
    return name ? `${name} (${id})` : id;
  };
  const lineup = new Map<
    string,
    { lineup: readonly string[]; lineupTo: readonly string[] | null }
  >();
  const set = new Map<string, { id: string; label: string }[]>();
  const within = new Map<string, string | null>(
    Object.entries(direction.setups ?? {}).map(([id, s]) => [id, s.within ?? null]),
  );
  const script = new Map<string, { speaker: string; text: string; acting: string | null }[]>();
  const cutin: PromptShots["cutin"] = new Map();
  // A critic cannot read direction.ts, so what the plate's sentence and the prompt are read against
  // is printed here rather than looked up. An id the place does not declare is `holds-unknown-id`,
  // a structural error, and stands as itself.
  const holdsOf = (setupId: string): { id: string; label: string }[] | null => {
    const setup = direction.setups?.[setupId];
    if (!setup) return null;
    const landmarks = direction.locations?.[setup.location]?.landmarks ?? {};
    return (setup.holds ?? []).map((id) => ({
      id,
      label: Object.hasOwn(landmarks, id) ? `${landmarks[id]!.name} (${id})` : id,
    }));
  };
  const action = new Map<string, string>();
  for (const shot of collectShots(direction)) {
    if (isAsideShot(shot)) continue;
    action.set(shot.id, shot.action);
    if (shot.cutin) {
      cutin.set(shot.id, {
        setup: shot.cutin.setup,
        lineup: shot.cutin.lineup ?? [],
        lineupTo: shot.cutin.lineupTo ?? null,
        set: holdsOf(shot.cutin.setup),
      });
    }
    if (!isGraphicShot(shot)) {
      if (shot.lineup) {
        lineup.set(shot.id, { lineup: shot.lineup, lineupTo: shot.lineupTo ?? null });
      }
      const held = holdsOf(shot.setup);
      if (held) set.set(shot.id, held);
    }
    const lines = (shot.script ?? []).map((line) => ({
      speaker:
        "character" in line
          ? `${nameById.get(line.character) ?? line.character} (${line.character})`
          : "speaker" in line
            ? line.speaker
            : "narration",
      text: "narration" in line ? line.narration : line.text,
      acting: line.acting ?? null,
    }));
    if (lines.length > 0) script.set(shot.id, lines);
  }
  return { action, lineup, set, within, cutin, script, label };
}

function shotIdOfAddress(address: string): string | null {
  const parsed = tryParseAddress(address);
  return parsed && parsed.kind === "shot" ? parsed.shotId : null;
}

// The shot's lines THIS address voices: the ones it quotes verbatim. A take that declares a
// `spokenText` input and quotes none carries words konte cannot match to a line, so it gets the
// whole shot's script rather than nothing. Every other address gets none — printing a shot's second
// line above the take that carries only its first tells the critic to expect words nobody asked for.
function voicedLines<L extends { text: string }>(
  occurrences: readonly PromptOccurrence[],
  lines: readonly L[],
  respellings: Respellings,
  shotId: string,
): L[] {
  const quoted = lines.filter((l) =>
    spellingsOf(respellings, shotId, l.text).some((spelling) =>
      occurrences.some((p) => p.value.includes(spelling)),
    ),
  );
  if (quoted.length > 0) return quoted;
  return occurrences.some((p) => p.spoken) ? [...lines] : [];
}

type Respellings = readonly Respelling[] | undefined;

// The spellings THIS address quotes, for the critic reading a prompt against the line.
function quotedSpellings(
  occurrences: readonly PromptOccurrence[],
  respellings: Respellings,
  shotId: string,
  line: string,
): string[] {
  return spellingsOf(respellings, shotId, line)
    .slice(1)
    .filter((spelling) => occurrences.some((p) => p.value.includes(spelling)));
}

function promptShotLines(
  promptShots: PromptShots | null,
  respellings: Respellings,
  address: string,
  occurrences: readonly PromptOccurrence[],
  inCutin: boolean,
): string[] {
  const shotId = promptShots && shotIdOfAddress(address);
  if (!promptShots || !shotId) return [];
  const out: string[] = [];
  const order = (ids: readonly string[]) => ids.map(promptShots.label).join(" | ");
  const action = promptShots.action.get(shotId);
  if (action) out.push(`action: ${action}`);
  const cutin = inCutin ? promptShots.cutin.get(shotId) : undefined;
  if (cutin) {
    const to = cutin.lineupTo ? ` → ${order(cutin.lineupTo)}` : "";
    const set =
      cutin.set && cutin.set.length > 0
        ? ` · set: ${cutin.set.map((l) => l.label).join(" | ")}`
        : "";
    out.push(`cutin: ${cutin.setup} · lineup: ${order(cutin.lineup)}${to}${set}`);
  }
  const declared = cutin ? undefined : promptShots.lineup.get(shotId);
  if (declared) {
    const to = declared.lineupTo ? ` → ${order(declared.lineupTo)}` : "";
    out.push(`lineup: ${order(declared.lineup)}${to}`);
  }
  // An insert holds nothing, so there is no line to print — the
  // empty list, which says "this frame holds nothing" rather than "no set was read".
  const held = cutin ? undefined : promptShots.set.get(shotId);
  if (held && held.length > 0) out.push(`set: ${held.map((l) => l.label).join(" | ")}`);
  for (const line of voicedLines(
    occurrences,
    promptShots.script.get(shotId) ?? [],
    respellings,
    shotId,
  )) {
    out.push(`script (${line.speaker}): ${line.text}`);
    for (const spelling of quotedSpellings(occurrences, respellings, shotId, line.text)) {
      out.push(`  spelled: ${spelling}`);
    }
    if (line.acting) out.push(`  acting: ${line.acting}`);
  }
  return out;
}

export function registerInspectCommand(program: Command): void {
  program
    .command("inspect <address-scope>")
    .description("Inspect assets at any scope level (asset, shot, or stage)")
    .option("--prompts", "List the text each address feeds a model, instead of asset state")
    .addHelpText(
      "after",
      `
One target in depth, where "konte status" is the whole-project view. An asset address reports its
variants, staleness and feedback; a shot scope reports its place on the timeline, the direction shot
it realizes (role, framing, location, action, script) and every target under it — its assets plus the
no-job leaves (composition, stem); a stage scope reports all of them. A video with no direction.ts,
or a shot the direction does not declare, simply carries no direction shot.

Every listing line carries its comment count. A stale comment — written against a state the target
has since left — is counted but not quoted.

The direction stage holds no assets, so it reports what it does have: every reviewable part of the
direction with its acceptance status and feedback, plus the unresolved findings. A part scope
("direction:<part>") adds the words being reviewed, for one part or for every part under a prefix.

Examples:
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
in, its place there ("panel 1 of 2") and the addresses behind it that carry a prompt, in declaration
order. A panel's name is the author's and a wrapper carries no text, so this is what says which
prompt writes a shot's opening frame.

  konte inspect animatic --prompts        Every prompt and spoken line the board declares
  konte inspect animatic:plate --prompts  What each plate holds, and any prompt that made it
  konte inspect video:shot.01 --prompts   One shot's
`,
    )
    .action(async (addressScope: string, opts: { prompts?: boolean }) => {
      const videoRoot = requireVideoRoot();
      const scope = parseInspectScope(addressScope);
      // Every path below reports staleness, so all of them read the definitions on disk.
      await applyResolutionDefinitions({ videoRoot });

      if (opts.prompts) {
        await inspectPrompts(videoRoot, scope);
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
    });
}
