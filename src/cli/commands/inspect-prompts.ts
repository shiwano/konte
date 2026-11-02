import {
  type AssetStage,
  type ShotStage,
  formatPlateAssetPath,
  formatShotAddress,
  tryParseAddress,
} from "../../core/address.js";
import {
  listPanelConditioning,
  type PanelConditioning,
  shotLaneChains,
} from "../../core/board-analysis.js";
import { loadCheckContext } from "../../core/check-context.js";
import { panelRole } from "../../core/direction.js";
import { spellingsOf } from "../../core/dsl/respell.js";
import { selectGenerationAssets } from "../../core/generation-selection.js";
import type { PromptOccurrence } from "../../core/prompt-check.js";
import { loadPromptShots, type PlateFrame, type PromptShots } from "../../core/prompt-shots.js";
import { loadVideoAndAnimatic } from "../../core/stage-definitions.js";
import type { AnimaticDefinition } from "../../core/types/animatic.js";
import type { PanelDefinition, PanelLane, Respelling } from "../../core/types/definition.js";
import { openVideoSession } from "../../core/video-session.js";
import { spendHeldAssets } from "../finding-gates.js";
import { type DefinitionWithDuration, loadDefinitionWithDuration } from "./inspect-definition.js";

export type PromptScope =
  | { level: "asset"; stage: AssetStage; address: string }
  | { level: "shot"; stage: ShotStage; shotId: string }
  | { level: "stage"; stage: AssetStage }
  // Every plate the animatic returned (`animatic:plate`).
  | { level: "plates"; stage: "animatic" }
  // The direction: the whole stage, or one of its parts (`address` null / set).
  | { level: "direction"; address: string | null };

// The text every model under a scope will read: the `"prompt"` / `"negativePrompt"` conditioning
// and the `"spokenText"` a speech or music model voices, each at the address that declares it.
// Collected as `asset()` ran, so a value assembled from shared constants is listed expanded. A
// patch script's steps declare their own and are not listed here.
export async function inspectPrompts(
  videoRoot: string,
  scope: PromptScope,
  pendingGeneration = false,
): Promise<void> {
  const stage = scope.level === "direction" ? null : scope.stage;
  const shotStages = stage === "video" ? await loadVideoAndAnimatic(videoRoot) : null;
  const definition = shotStages
    ? shotStages.video
    : stage
      ? await loadDefinitionWithDuration(videoRoot, stage)
      : null;
  const boardMoves = panelMovesByShot(shotStages?.animatic);
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

  let pending: Set<string> | undefined;
  if (pendingGeneration && stage) {
    const { definitions, manager, graph } = await openVideoSession(videoRoot, {
      sync: "memory",
      through: stage,
    });
    const { spending } = selectGenerationAssets({ definitions, stage, manager, graph });
    const held = await spendHeldAssets(
      await loadCheckContext({ videoRoot, definitions, manager, graph }),
      { command: "generate", stage, assetPaths: spending, targeted: false },
    );
    pending = new Set(spending.filter((address) => !held.has(address)));
    const addresses = new Set([
      ...matches.map((p) => p.address),
      ...plates.map((p) => p.address),
      ...keyframes.map((k) => k.panel),
    ]);
    const targets = [...pending].filter((address) => addresses.has(address));
    if (targets.length === 0) {
      console.log("No pending generation under this scope.");
      return;
    }
    console.log(
      `Pending generation: ${targets.length} asset(s). Other entries are comparison only.`,
    );
    console.log("");
  }
  const printGeneration = (address: string) => {
    if (pending)
      console.log(`  generation: ${pending.has(address) ? "pending" : "comparison only"}`);
  };

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
      const role = panelRole(
        k.index,
        k.of,
        promptShots?.continuous.has(`${k.shotId}/${k.lane}`) ?? false,
      );
      console.log(
        `  shot ${k.shotId} · panel ${k.index} of ${k.of} · ${k.lane} · ${role}   ${k.panel}`,
      );
      console.log(`    conditioning: ${k.conditioning.join(", ") || "(none)"}`);
      if (pending) {
        console.log(`    generation: ${pending.has(k.panel) ? "pending" : "comparison only"}`);
      }
      const plate = panelPlate(k, promptShots);
      if (plate) console.log(`    plate: ${plate}`);
    }
    console.log("");
  }

  // A plate is listed first, in return order, whether or not a model read a prompt to make it.
  let first = true;
  for (const plate of plates) {
    if (!first) console.log("");
    first = false;
    console.log(plate.address);
    printGeneration(plate.address);
    if (plate.frame) {
      console.log(`  within: ${plate.frame.within ?? "root"}`);
      console.log(`  framing: ${plate.frame.framing}`);
      if (plate.frame.view) console.log(`  view: ${plate.frame.view}`);
      if (plate.frame.set.length > 0) {
        console.log(`  set: ${plate.frame.set.map((l) => l.label).join(" | ")}`);
      }
    }
    printOccurrences(byAddress.get(plate.address) ?? []);
  }

  const plateAddresses = new Set(plates.map((p) => p.address));
  for (const [address, occurrences] of byAddress) {
    if (plateAddresses.has(address)) continue;
    if (!first) console.log("");
    first = false;
    console.log(address);
    printGeneration(address);
    for (const line of promptShotLines(
      promptShots,
      respellings,
      address,
      occurrences,
      cutinAddresses.has(address),
    )) {
      console.log(`  ${line}`);
    }
    if (occurrences.some((p) => !p.spoken)) {
      for (const line of panelMoveLines(boardMoves, address, cutinAddresses.has(address))) {
        console.log(`  ${line}`);
      }
    }
    printOccurrences(occurrences);
  }
}

type PanelMove = { index: number; of: number; blocking?: string; camera?: string };

function panelMovesByShot(
  animatic: AnimaticDefinition | null | undefined,
): Map<string, Record<PanelLane, PanelMove[]>> {
  const out = new Map<string, Record<PanelLane, PanelMove[]>>();
  for (const shot of animatic?.shots ?? []) {
    const moves = (panels: readonly PanelDefinition[] | undefined): PanelMove[] =>
      (panels ?? []).map((p, i, all) => ({
        index: i + 1,
        of: all.length,
        blocking: p.blocking,
        camera: p.camera,
      }));
    out.set(shot.id, { main: moves(shot.panels), cutin: moves(shot.cutin?.panels) });
  }
  return out;
}

function panelMoveLines(
  boardMoves: Map<string, Record<PanelLane, PanelMove[]>>,
  address: string,
  inCutin: boolean,
): string[] {
  const shotId = shotIdOfAddress(address);
  const moves = shotId ? boardMoves.get(shotId)?.[inCutin ? "cutin" : "main"] : undefined;
  const out: string[] = [];
  for (const m of moves ?? []) {
    const place = `panel ${m.index} of ${m.of}`;
    if (m.blocking) out.push(`blocking (${place}): ${m.blocking}`);
    if (m.camera) out.push(`camera (${place}): ${m.camera}`);
  }
  return out;
}

// The plate of the setup the panel's lane is shot from. `conditioning` can reach another setup's
// plate through the frame before the cut, so the order there does not say which one this is.
function panelPlate(k: PanelConditioning, promptShots: PromptShots | null): string | null {
  const setupId =
    k.lane === "cutin" ? promptShots?.cutin.get(k.shotId)?.setup : promptShots?.setup.get(k.shotId);
  if (!setupId) return null;
  const plate = formatPlateAssetPath(setupId);
  return k.conditioning.includes(plate) ? plate : `(none — ${plate} is not in its conditioning)`;
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

function platesUnderScope(
  definition: DefinitionWithDuration | null,
  scope: PromptScope,
  promptShots: PromptShots | null,
): { address: string; frame: PlateFrame | null }[] {
  if (!definition?.exposedPlateIds) return [];
  if (scope.level === "shot" || scope.level === "direction") return [];
  const out: { address: string; frame: PlateFrame | null }[] = [];
  for (const id of definition.exposedPlateIds) {
    const address = formatPlateAssetPath(id);
    if (scope.level === "asset" && scope.address !== address) continue;
    out.push({ address, frame: promptShots?.plateFrame.get(id) ?? null });
  }
  return out;
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
  const span = promptShots.span.get(shotId);
  if (span) out.push(`span: ${span}`);
  const cutin = inCutin ? promptShots.cutin.get(shotId) : undefined;
  if (cutin) {
    const to = cutin.lineupTo ? ` → ${order(cutin.lineupTo)}` : "";
    const set =
      cutin.set && cutin.set.length > 0
        ? ` · set: ${cutin.set.map((l) => l.label).join(" | ")}`
        : "";
    const join = cutin.join ? ` · join: ${cutin.join}` : "";
    out.push(`cutin: ${cutin.setup}${join} · lineup: ${order(cutin.lineup)}${to}${set}`);
  }
  const join = cutin ? undefined : promptShots.join.get(shotId);
  if (join) out.push(`join: ${join}`);
  if (!cutin && promptShots.coverage.has(shotId)) {
    out.push("coverage: one take the model cuts inside — the lineup is its opening frame");
  }
  const declared = cutin ? undefined : promptShots.lineup.get(shotId);
  if (declared) {
    const to = declared.lineupTo ? ` → ${order(declared.lineupTo)}` : "";
    out.push(`lineup: ${order(declared.lineup)}${to}`);
  }
  const frameId = cutin ? `${shotId}.cutin` : shotId;
  const passers = promptShots.passing.get(frameId);
  if (passers?.length) out.push(`passing: ${order(passers)}`);
  // An insert holds nothing, so there is no line to print — the
  // empty list, which says "this frame holds nothing" rather than "no set was read".
  const held = cutin ? undefined : promptShots.set.get(shotId);
  if (held && held.length > 0) out.push(`set: ${held.map((l) => l.label).join(" | ")}`);
  const hinges = promptShots.hinge.get(frameId);
  if (hinges?.length)
    out.push(
      `hinge: ${hinges.map((h) => `${h.name}${h.notInSet ? " (not in set)" : ""}`).join(" | ")}`,
    );
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
