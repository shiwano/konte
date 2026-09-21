import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  type DefinitionLike,
  getAssetEntryByAddress,
  getStage,
  isDeliveryAddress,
  isPlateAddress,
  listExposedReferenceAssetPaths,
  isMaterializedLeafAddress,
  isPatchAddress,
  isStemAddress,
} from "../core/address.js";
import {
  collectDeadCompositionVariants,
  collectDeadStemVariants,
  definitionHashForAddress,
  leafReadyForReview,
} from "../core/composition-resource.js";
import { computeDefinitionHash } from "../core/definition-hash.js";
import { type DependencyGraph, videoDependentsHoldVerdicts } from "../core/graph.js";
import { stageReviewDecidableAddresses } from "../core/shot-accept-targets.js";
import { computeExportSignature } from "../core/export-signature.js";
import { formatRelativeTime } from "../core/format-timestamp.js";
import { printCapped } from "./format-list.js";
import { JobIndex } from "../core/job-index.js";
import type { JobManager } from "../core/job-manager.js";
import {
  type PatchCatalog,
  activeGenerationVariantIds,
  findPendingPatches,
  loadPatchCatalog,
  patchHashesOf,
} from "../core/patch.js";
import type { StateManager } from "../core/state/index.js";
import { deliveryUpscalerMissing } from "../core/delivery.js";
import { ERROR_GLIMPSE_WIDTH, truncateSingleLine } from "../core/truncate.js";
import {
  type AddressInfo,
  type ExportReadiness,
  type LastExport,
  type StatusSection,
  buildAddressInfo,
  computeExportReadiness,
  computeLastExports,
  computeStatusSections,
  detectOrphans,
} from "../core/status-sections.js";
import { type SuggestedAction, formatSuggestedActions } from "../core/suggested-actions.js";
import type {
  AssetDefinition,
  GenerationJob,
  JobRecord,
  VideoDefinition,
} from "../core/types/index.js";
import type { Stage } from "../core/address.js";
import type { PinOccurrence } from "../core/pin-check.js";
import type { PromptOccurrence } from "../core/prompt-check.js";

export interface StatusReport {
  infos: AddressInfo[];
  sections: StatusSection[];
  readiness: ExportReadiness[];
  lastExports: LastExport[];
  /**
   * Job ids of jobs still in flight whose variant is gone from state. `prune` refuses an active
   * job, so the step is a cancel.
   */
  orphanJobIds: string[];
  /** Job ids of failed comfy provisioning jobs — model downloads and node install/activate. */
  provisioningFailureJobIds: string[];
  /** Patch scripts that failed to load. Keyed by file path, which is not an address. */
  patchErrors: { filePath: string; message: string }[];
  /** The prompts and pins each outstanding patch would spend on, with the file that holds them. */
  patchPrompts: {
    file: string;
    sourceAddress: string;
    prompts: readonly PromptOccurrence[];
    pins: readonly PinOccurrence[];
  }[];
}

import type {
  DirectionAcceptanceStatus,
  DirectionAcceptanceSummary,
} from "../core/direction-acceptance.js";

export type { DirectionAcceptanceStatus, DirectionAcceptanceSummary };

// An unresolved structural finding, keyed by the waiver key that would silence it.
type DirectionFindingLine = { key: string; class: string; message: string };
type DirectionStructureErrorLine = { code: string; message: string };
type DirectionStaleWaiverLine = { key: string; reason: string };
// A prompt finding as reported: the phrase and where it is written, plus the file that holds both
// it and the waiver that would cancel it.
export type PromptFindingLine = { key: string; where: string; detail: string };
export type PromptStaleWaiverLine = {
  key: string;
  where: string;
  reason: string;
  unknown?: boolean;
};
// A pin finding as reported: the image pinned and the sites pinning it, plus the file that holds
// both the wiring and the waiver that would cancel it.
export type PinFindingLine = { key: string; where: string; detail: string };
export type PinStaleWaiverLine = { key: string; where: string; reason: string };

// The direction is the one project-wide, variant-less accept, and it gates every animatic/video
// spend — so it heads the progress block, above the per-stage asset ratios it precedes.
function directionAcceptanceLine(summary: DirectionAcceptanceSummary, empty: boolean): string {
  const label = "direction";
  switch (summary.status) {
    case "accepted":
      return `  ${label}: accepted`;
    case "partial":
      // Only parts that still hold a spend get the imperative; a shot rewritten after the piece was
      // accepted whole is named without one.
      return summary.gateBlocking > 0
        ? `  ${label}: ${summary.gateBlocking} of ${summary.total} parts need review — re-accept`
        : `  ${label}: accepted (${summary.blocking} of ${summary.total} parts changed since)`;
    case "unaccepted":
      return empty ? `  ${label}: not written yet` : `  ${label}: not accepted`;
  }
}

// The shared computation behind `konte status`:
// every section, the per-stage progress, and the last exports are
// derived from the definition-supplied `addresses` so both renderings agree —
// including assets with no variant yet (which carry no `state.assets` entry).
export async function buildStatusReport(
  addresses: string[],
  manager: StateManager,
  jobManager: JobManager,
  getDefinition: (addr: string) => DefinitionLike | null,
  options?: {
    videoRoot?: string;
    unacceptedCast?: readonly string[];
    /** Per-stage undeveloped-shot counts, so a stage with only pending shots still gets a line. */
    pendingShotsByStage?: Partial<Record<Stage, number>>;
    /** The loaded video definition — drives the export signature and last-export scope. */
    videoDefinition?: VideoDefinition | null;
    graph?: DependencyGraph | null;
  },
): Promise<StatusReport> {
  const state = manager.getState();
  const everyJob = await jobManager.listJobs();
  const jobIndex = new JobIndex(everyJob);
  // This whole report is one read-only pass over one loaded state, so every address's
  // staleness walks share one memo instead of re-exploring the same upstream cones. Taken from the
  // manager, so it carries the definitions resolution is judged by.
  const stalenessCache = manager.stalenessCache();

  // Patch scripts are the second definition source in a video (after the stage files), so status
  // loads them for the same reason it loads those: an edited patch ages out the take it produced,
  // and an unapplied one is outstanding work. A broken script is reported, never fatal.
  const patchCatalog: PatchCatalog = options?.videoRoot
    ? await loadPatchCatalog(options.videoRoot, state)
    : { patches: new Map(), orphans: [], absent: [], errors: [] };
  const patchHashes = patchHashesOf(patchCatalog);
  // `patchFilePath` builds an absolute path. What identifies the file to its author is
  // `patches/<variantId>.ts`; the absolute form would put the machine's layout into every report.
  const patchFileLabel = (filePath: string) =>
    options?.videoRoot ? path.relative(options.videoRoot, filePath) : filePath;
  const pendingPatches = findPendingPatches(
    state,
    patchCatalog,
    activeGenerationVariantIds(everyJob),
    stalenessCache,
  );

  // Status is asset/variant-oriented. comfy-model-download jobs carry no asset
  // address (their `address` is a sentinel), so they don't fit the per-asset
  // sections — but a failed one blocks the generation jobs that depend on it, so
  // surface those failures on their own.
  const allJobs = everyJob.filter((job): job is GenerationJob => job.kind === "generation");
  const modelDownloadFailures = everyJob.flatMap((job) => {
    if (job.status !== "failed") return [];
    if (job.kind === "comfy-model-download") {
      return [
        { jobId: job.id, label: job.model.filename, error: job.error, what: "model download" },
      ];
    }
    if (job.kind === "comfy-node-install") {
      return [
        { jobId: job.id, label: `node ${job.node.id}`, error: job.error, what: "node install" },
      ];
    }
    if (job.kind === "comfy-node-activate") {
      return [{ jobId: job.id, label: "custom nodes", error: job.error, what: "node activation" }];
    }
    return [];
  });

  const jobsByVariantId = new Map<string, JobRecord>();
  for (const job of allJobs) {
    jobsByVariantId.set(job.variantId, job);
  }

  // The stage definition behind a leaf, PER STAGE: both composition stages carry leaves, and one
  // stage's definition read for another reports its leaves against the wrong shots.
  const leafStages = new Map<string, VideoDefinition>();
  for (const addr of addresses) {
    if (!isMaterializedLeafAddress(addr)) continue;
    const stage = getStage(addr);
    if (leafStages.has(stage)) continue;
    const def = getDefinition(addr) as unknown as VideoDefinition | null;
    if (def) leafStages.set(stage, def);
  }

  // Dead composition leftover variants (e.g. ghosts from an earlier definition), keyed by
  // address, so they never count as "ready".
  const deadByAddress = new Map<string, Set<string>>();
  for (const def of leafStages.values()) {
    const dead = [
      ...collectDeadCompositionVariants(manager, def),
      ...collectDeadStemVariants(manager, def),
    ];
    for (const { address, variantId } of dead) {
      let set = deadByAddress.get(address);
      if (!set) {
        set = new Set();
        deadByAddress.set(address, set);
      }
      set.add(variantId);
    }
  }

  // Every address a stage's reel review can land a verdict on. An address status would call review
  // work that is outside its stage's set is one no toggle reaches — reported as a konte bug rather
  // than left asking for a verdict nothing can give. Absent for a stage not in scope, whose
  // addresses then keep the ordinary review path.
  const decidableByStage = new Map<string, ReturnType<typeof stageReviewDecidableAddresses>>();
  for (const [stage, def] of leafStages) {
    decidableByStage.set(stage, stageReviewDecidableAddresses(manager, def));
  }

  // The reference stage's exposed pool, resolved once: every address outside it is an intermediate.
  const referenceAddr = addresses.find((a) => getStage(a) === "reference");
  const referenceDef = referenceAddr ? getDefinition(referenceAddr) : null;
  const exposedReferences = new Set(
    referenceDef ? listExposedReferenceAssetPaths(referenceDef) : [],
  );

  const deterministicAddresses = new Set<string>();
  const infos: AddressInfo[] = addresses.map((addr) => {
    let assetKind: AddressInfo["assetKind"] = null;
    let definitionHash: string | null = null;
    // A file asset is "accepted" once its file is on disk — no generate/review needed — so
    // a declared-and-present file counts as complete even before the first sync registers it.
    let fileOnDisk = false;
    let missingFilePath: string | null = null;
    let leafReady = false;
    let deterministic = false;
    const def = getDefinition(addr);
    // An asset the stage declared without returning it is an intermediate: it is generated and
    // tracked, but no review surface lists it and no accept is owed on it (see
    // `listExposedReferenceAssetPaths`). A plate is judged inside the panels drawn on it, whose
    // accept cascades onto it. Every other address is somebody's to decide.
    const reviewTarget =
      (getStage(addr) !== "reference" || isDeliveryAddress(addr) || exposedReferences.has(addr)) &&
      !isPlateAddress(addr);
    if (def && isMaterializedLeafAddress(addr)) {
      // A composition/stem has no AssetDefinition; it is a no-job leaf of its stage's definition.
      assetKind = isStemAddress(addr) ? "stem" : "composition";
      definitionHash = definitionHashForAddress(def, addr);
      const leafDef = leafStages.get(getStage(addr)) ?? null;
      // Leaves are materialized only on accept, so a never-accepted leaf has no variant — its
      // first-review need is this live signal (renderable + refs resolvable), not a ready variant.
      leafReady =
        definitionHash !== null && leafDef !== null && leafReadyForReview(manager, leafDef, addr);
    } else if (isPatchAddress(addr)) {
      // A patch step is declared by `patches/<variantId>.ts`, so the stage definition has no entry
      // to hash. Its whole chain is hashed as the patch's own `patchHash`, and an edit surfaces
      // under "Pending patches" — as a correction to re-apply, which is the actionable framing.
    } else if (def && isDeliveryAddress(addr)) {
      // A delivery (#delivery) asset is synthesized, not authored — no review. Its definition
      // hash depends on the resolved source's real dimensions (ffprobed at export), which
      // status doesn't resolve, so leave definitionHash null: input-staleness (the source
      // changed) still surfaces; definition-staleness for delivery is checked at export.
    } else if (def) {
      try {
        const entry = getAssetEntryByAddress(def, addr) as AssetDefinition;
        assetKind = entry.kind;
        if (entry.kind === "file") {
          fileOnDisk = options?.videoRoot
            ? existsSync(path.resolve(options.videoRoot, entry.path))
            : false;
          // Carry the declared path, not the resolved one: it is what the author wrote and where
          // they must put the media.
          if (!fileOnDisk) missingFilePath = entry.path;
        } else {
          definitionHash = computeDefinitionHash(entry);
          deterministic = entry.deterministic === true;
        }
      } catch {
        // definition not found for this address
      }
    }
    // Materialized leaves and patch steps are decided elsewhere (the leaf by its own address, a
    // patch step by its source), so the reachability question is only about a stage asset. Asked of
    // whichever composition stage owns the address — both have a reel review to reach it from.
    const decidable = decidableByStage.get(getStage(addr)) ?? null;
    const reviewUnreachable =
      reviewTarget &&
      decidable !== null &&
      !isPatchAddress(addr) &&
      !isDeliveryAddress(addr) &&
      !decidable.has(addr);

    if (deterministic) deterministicAddresses.add(addr);
    return buildAddressInfo(
      addr,
      state,
      jobsByVariantId,
      assetKind,
      definitionHash,
      jobIndex,
      fileOnDisk,
      deadByAddress.get(addr),
      leafReady,
      missingFilePath,
      patchHashes,
      stalenessCache,
      reviewTarget,
      reviewUnreachable,
      deterministic,
    );
  });

  // A stale accept every video take built on stands over too: its refresh would not change the cut.
  const graph = options?.graph;
  if (graph) {
    const infoByAddress = new Map(infos.map((info) => [info.address, info]));
    const verdictOf = (address: string): "holds" | "rebakes" | "open" | null => {
      const info = infoByAddress.get(address);
      if (!info) return null;
      if (!info.hasAccepted) return "open";
      const accepted = Object.values(state.assets[address]?.variants ?? {}).find(
        (v) => v.status === "accepted",
      );
      return deterministicAddresses.has(address) && accepted?.derivedFrom == null
        ? "rebakes"
        : "holds";
    };
    for (const info of infos) {
      if (info.staleVariants.length === 0 || info.staleAcceptStands) continue;
      if (isMaterializedLeafAddress(info.address) || isDeliveryAddress(info.address)) continue;
      info.staleAcceptStands = videoDependentsHoldVerdicts(graph, info.address, verdictOf);
    }
  }

  const orphans = detectOrphans(state, allJobs);
  const sections = computeStatusSections(infos, orphans, modelDownloadFailures);
  // Declared but not yet realized — the same status as an ungenerated asset, so it gets its own
  // block rather than hiding inside "Needs review" (there is nothing to review yet). `konte
  // generate` picks these up, so the fix is the command the author was going to run anyway.
  if (pendingPatches.length > 0 || patchCatalog.errors.length > 0) {
    sections.push({
      title: "Pending patches",
      items: [
        ...pendingPatches.map((p) => ({
          address: p.sourceAddress,
          detail:
            p.reason === "never-applied"
              ? `patch of ${p.sourceVariantId}`
              : p.reason === "script-changed"
                ? "patch script changed"
                : "an input changed since it was applied",
        })),
        ...patchCatalog.errors.map((e) => ({
          address: patchFileLabel(e.filePath),
          detail: truncateSingleLine(e.message, ERROR_GLIMPSE_WIDTH),
        })),
      ],
    });
  }
  // Undeveloped shots (pendingShot) carry no address, so they never reach `infos` — but the stage
  // must still show its "N shots undeveloped" line even when it has no other asset. Seed the count
  // into readiness so status (the single orientation point) reports it and never reads
  // "ready to export" with a shot pending.
  const readiness = computeExportReadiness(infos, options?.pendingShotsByStage);

  // The loaded video definition drives the export signature (to flag a last export whose
  // soundtrack/delivery config has since changed) and marks the video stage in scope for last
  // exports. Taken from the caller, not an address — a video whose shots are all undeveloped has no
  // address yet still owns any prior export.
  const videoDef = options?.videoDefinition ?? null;

  // A cast reference is an unaccepted `reference:<id>` asset, so it belongs on the reference
  // stage's line — the one place the cast gate can be acted on.
  if (options?.unacceptedCast?.length) {
    for (const r of readiness) {
      if (r.label === "reference") r.unacceptedCast = [...options.unacceptedCast];
    }
  }
  if (videoDef && deliveryUpscalerMissing(videoDef)) {
    const videoLine = readiness.find((r) => r.label === "video");
    if (videoLine) videoLine.deliveryUpscalerMissing = true;
  }
  const currentSignature = videoDef ? () => computeExportSignature(videoDef) : undefined;
  const lastExports = computeLastExports(videoDef != null, everyJob, currentSignature);

  return {
    infos,
    sections,
    readiness,
    lastExports,
    orphanJobIds: orphans.orphanJobs.map((j) => j.variantId),
    provisioningFailureJobIds: modelDownloadFailures.map((f) => f.jobId),
    patchPrompts: pendingPatches
      .filter((p) => (p.prompts?.length ?? 0) > 0 || (p.pins?.length ?? 0) > 0)
      .map((p) => ({
        file: patchFileLabel(p.filePath),
        sourceAddress: p.sourceAddress,
        prompts: p.prompts ?? [],
        pins: p.pins ?? [],
      })),
    patchErrors: patchCatalog.errors.map((e) => ({
      filePath: patchFileLabel(e.filePath),
      message: e.message,
    })),
  };
}

export function printStatusReport(
  report: StatusReport,
  suggestedActions: SuggestedAction[],
  options?: {
    videoRoot?: string;
    verbose?: boolean;
    directionAcceptance?: DirectionAcceptanceSummary | null;
    directionEmpty?: boolean;
    directionFindings?: DirectionFindingLine[];
    directionStructureErrors?: DirectionStructureErrorLine[];
    directionStaleWaivers?: DirectionStaleWaiverLine[];
    promptFindings?: PromptFindingLine[];
    promptStaleWaivers?: PromptStaleWaiverLine[];
    pinFindings?: PinFindingLine[];
    pinStaleWaivers?: PinStaleWaiverLine[];
  },
): void {
  const { sections, readiness, lastExports } = report;
  const formatted = formatSuggestedActions(suggestedActions);

  if (readiness.length > 0 || options?.directionAcceptance) {
    // "Ready to export" only fits a fully-accepted profile; with anything still
    // pending the heading would contradict the count below it. Keep the heading
    // neutral and mark export-readiness per profile instead.
    console.log("Progress:");
    if (options?.directionAcceptance) {
      console.log(
        directionAcceptanceLine(options.directionAcceptance, options.directionEmpty ?? false),
      );
    }
    const fileWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
    for (const r of readiness) {
      // Readiness ("can I export?") includes file assets, so they fold into the accept
      // ratio with a `(x/y files)` breakdown. "Generated" is a generation-pipeline axis
      // only (files are never generated), so it stays on the generation count — its
      // denominator differs from the accept total by exactly the file count.
      const fileTotal = r.filesReady + r.filesMissing.length;
      const acceptTotal = r.total + fileTotal;
      const accepted = r.accepted + r.filesReady;
      const fileSuffix = fileTotal > 0 ? ` (${r.filesReady}/${fileTotal} files)` : "";

      // Only the video stage has a deliverable — `konte export` refuses reference (an upstream
      // pool) and animatic (a working stage), so only the video line claims export-readiness.
      const exportable = r.label === "video";

      // An undeveloped shot carries no address, so it is absent from the ratio below — without this
      // an animatic of three placeholders and one real panel would read "all 1 accepted". The DSL
      // form goes unsaid — it is `pendingShot` in either stage, so naming it here would only
      // translate the label already on the line.
      const undeveloped = r.pendingShots;

      // Qualifies the accept count in either shape: an accepted take whose definition or inputs have
      // moved since, and whose accept does not stand, is counted as accepted and isn't finished work. Left off the count, a partly
      // accepted stage reads as plain progress and the aged accepts are invisible until `inspect`.
      // Not a problem to fix — export uses the accepted output as-is. Next steps picks the refresh
      // and names the addresses with it — the accept once a fresh take has landed, the reroll
      // otherwise — so repeating them here would say it twice.
      const staleCount = r.staleAwaitingAccept.length + r.staleAwaitingReroll.length;
      const staleSuffix = staleCount > 0 ? ` (${staleCount} stale)` : "";

      const parts: string[] = [];
      if (acceptTotal > 0) {
        if (accepted !== acceptTotal) {
          let clause = `${accepted}/${acceptTotal} accepted${fileSuffix}${staleSuffix}`;
          // Pair the accept ratio with a generate ratio so a not-fully-accepted profile
          // reads unambiguously: what's never been generated (run `generate`) vs what's
          // generated and only awaiting review (see "Needs review").
          if (r.total > 0) {
            clause += ` · ${r.generated}/${r.total} generated`;
            // Counts, not addresses: `generate` is stage-scoped, so it acts on every one of these
            // whether or not this line names them — and an in-flight one is already handled. Naming
            // them would only restate the stage this line already leads with.
            const notes: string[] = [];
            if (r.inFlight > 0) notes.push(`${r.inFlight} in flight`);
            if (r.notGenerated.length > 0) {
              notes.push(`${r.notGenerated.length} not generated`);
            }
            if (notes.length > 0) clause += ` (${notes.join("; ")})`;
          }
          parts.push(clause);
        } else {
          // Two fully-accepted stages are still not exportable: a static-only pool (r.total === 0),
          // and one whose developed shots are all accepted while an undeveloped shot remains
          // (surfaced below). Neither should read as "ready to export".
          const ready =
            exportable && undeveloped === 0 && r.total > 0 && !r.deliveryUpscalerMissing;
          parts.push(
            `all ${acceptTotal} accepted${fileSuffix}${ready ? " — ready to export" : ""}${staleSuffix}`,
          );
        }
      }
      if (undeveloped > 0) {
        parts.push(`${undeveloped} shot${undeveloped === 1 ? "" : "s"} undeveloped`);
      }
      // A count, like every other list on this line: Next steps' "add file" note names each missing
      // file by the path to put it at.
      if (r.filesMissing.length > 0) {
        parts.push(`${fileWord(r.filesMissing.length)} missing`);
      }
      // A count: the gate is cleared by `konte generate reference` (stage-scoped) for a generated
      // reference, and a `file` one's path is named by the "add file" step under Next steps.
      if (r.unacceptedCast.length > 0) {
        const n = r.unacceptedCast.length;
        parts.push(`${n} cast reference${n === 1 ? "" : "s"} not accepted`);
      }
      if (r.deliveryUpscalerMissing) parts.push("no delivery upscaler");
      console.log(`  ${r.label}: ${parts.join(", ")}`);
    }
  }

  // Above the sections, not below them: every list is capped but the caps stack, and a piped read
  // (`konte status | head -20`) loses a trailing block. Progress is one bounded line per stage.
  if (formatted) console.log(`\n${formatted}`);

  // Above the findings: a structural error breaks the definition itself, so nothing below it can
  // be trusted until it is fixed.
  const structureErrors = options?.directionStructureErrors ?? [];
  if (structureErrors.length > 0) {
    console.log();
    console.log(`Direction errors: ${structureErrors.length}`);
    printCapped(structureErrors, (e) => `[${e.code}] ${e.message}`, { verbose: options?.verbose });
  }

  const findings = options?.directionFindings ?? [];
  if (findings.length > 0) {
    console.log();
    console.log(`Direction findings: ${findings.length}`);
    printCapped(findings, (f) => `[${f.key}] (${f.class}) ${f.message}`, {
      verbose: options?.verbose,
    });
  }

  const staleWaivers = options?.directionStaleWaivers ?? [];
  if (staleWaivers.length > 0) {
    console.log();
    console.log(
      `Stale direction waivers: ${staleWaivers.length} — the finding is gone; remove the waiver`,
    );
    printCapped(staleWaivers, (w) => `[${w.key}] ${w.reason}`, { verbose: options?.verbose });
  }

  // Beside the direction blocks: an unresolved prompt finding aborts generate/reroll/export.
  const promptFindings = options?.promptFindings ?? [];
  if (promptFindings.length > 0) {
    console.log();
    console.log(
      `Prompt findings: ${promptFindings.length} — a negation working against the input it is written in`,
    );
    printCapped(promptFindings, (f) => `[${f.key}] (${f.where}) ${f.detail}`, {
      verbose: options?.verbose,
    });
  }

  const promptStaleWaivers = options?.promptStaleWaivers ?? [];
  if (promptStaleWaivers.length > 0) {
    console.log();
    console.log(
      `Stale prompt waivers: ${promptStaleWaivers.length} — the phrase is gone; remove the waiver`,
    );
    printCapped(
      promptStaleWaivers,
      (w) => `[${w.key}] (${w.where}) ${w.unknown ? "unknown key" : w.reason}`,
      { verbose: options?.verbose },
    );
  }

  // The prompt findings' twin over wiring: a pinned image that is not a frame of the picture.
  const pinFindings = options?.pinFindings ?? [];
  if (pinFindings.length > 0) {
    console.log();
    console.log(
      `Pin findings: ${pinFindings.length} — an image pinned as a frame that the picture never shows`,
    );
    printCapped(pinFindings, (f) => `[${f.key}] (${f.where}) ${f.detail}`, {
      verbose: options?.verbose,
    });
  }

  const pinStaleWaivers = options?.pinStaleWaivers ?? [];
  if (pinStaleWaivers.length > 0) {
    console.log();
    console.log(
      `Stale pin waivers: ${pinStaleWaivers.length} — the image is no longer pinned; remove the waiver`,
    );
    printCapped(pinStaleWaivers, (w) => `[${w.key}] (${w.where}) ${w.reason}`, {
      verbose: options?.verbose,
    });
  }

  if (lastExports.length > 0) {
    console.log();
    console.log("Last export:");
    const labelWidth = lastExports.reduce((max, e) => Math.max(max, e.label.length), 0);
    for (const e of lastExports) {
      // Relative, as every other list in the CLI reports a time (`konte job list`). The exact
      // instant is not lost: the output dir is stamped with it.
      const when = e.completedAt ? formatRelativeTime(e.completedAt) : "";
      const stale = e.outOfDate ? "  — out of date" : "";
      const file = options?.videoRoot
        ? path.relative(process.cwd(), path.join(options.videoRoot, e.outputFile))
        : e.outputFile;
      console.log(
        `  ${e.label.padEnd(labelWidth)}  [${e.noDelivery ? "working size" : "delivery"}]  ${file}${when ? `  (${when})` : ""}${stale}`,
      );
    }
  }

  // `-v` only. status is read in a loop, and every state a section reports is one Next steps names
  // a command or an edit for — down to the orphan job, the failed model download and the broken
  // patch script.
  if (options?.verbose) {
    for (const section of sections) {
      console.log();
      console.log(`${section.title}: ${section.items.length}`);
      for (const item of section.items) {
        // The take the item is about, when it has one — an address with several variants gives the
        // An item with nothing to add beyond its address (the plain case the section title already
        // describes) prints bare rather than trailing the separator into empty space.
        const trailer = [item.variantId, item.detail].filter(Boolean).join("  ");
        console.log(trailer ? `  ${item.address}  ${trailer}` : `  ${item.address}`);
      }
    }
  }

  // Unused assets are deliberately absent: nothing consumes them, so they gate neither review nor
  // export and there is no step to take now. `konte doctor`'s "unused assets" check owns them.
}
