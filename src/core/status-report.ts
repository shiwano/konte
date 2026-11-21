import { existsSync } from "node:fs";
import * as path from "node:path";
import { acceptedVariant } from "./accepted-variant.js";
import { holdsHumanVerdict } from "./accept-cascade.js";
import {
  getStage,
  isDeliveryAddress,
  isPlateAddress,
  isMaterializedLeafAddress,
  isOverlayAddress,
  isPatchAddress,
  isStemAddress,
  isThumbnailAddress,
  formatReferenceAddress,
  formatTimelineOverlayAddress,
  formatTimelineStemAddress,
  type Stage,
  assertValidAddressScope,
  matchesAddressScope,
  formatAddress,
  formatShotAddress,
  parseAddress,
} from "./address.js";
import {
  getAssetEntry,
  listExposedReferenceAddresses,
  listCompositionAddresses,
  listOverlayAddresses,
  listStemAddresses,
  listAddresses,
  listReferenceAddresses,
} from "./definition-addresses.js";
import {
  type AssetStageDefinition,
  type AssetDefinition,
  type GenerationJob,
  type JobRecord,
  type VideoDefinition,
  type ReferenceDefinition,
  type AnimaticDefinition,
  type DirectionAcceptance,
  type KonteState,
  isPendingShot,
  isShotStageDefinition,
  isPendingAnimaticShot,
} from "./types/index.js";
import { assertNever } from "./assert.js";
import { staleSettledLeaves } from "./board-leaves.js";
import { loadCheckContext } from "./check-context.js";
import {
  type CheckContext,
  type PatchSubject,
  type StaleWaiverLine,
  collectFindings,
  waiverCoverageOf,
} from "./checks.js";
import { definitionHashForAddress } from "./leaf-hash.js";
import { collectDeadStemVariants, listRemovedShotStemAddresses } from "./stem-resource.js";
import { collectDeadCompositionVariants } from "./composition-resource.js";
import {
  boardCompositionAwaitsVideo,
  boardStemAwaitsVideo,
  leafSettledAcross,
  leafReadyForReview,
  leafSignedOff,
  materializedLeafReviewStatus,
  shotAcceptsStand,
} from "./leaf-review.js";
import { computeDefinitionHash } from "./definition-hash.js";
import {
  type StageDefinitions,
  applyResolutionDefinitions,
  definitionDriftFields,
} from "./definition-hashes.js";
import { deliveryUpscalerMissing } from "./delivery.js";
import {
  type DirectionAcceptanceSummary,
  directionAcceptanceView,
  shotWaiversAwaitingAccept,
  songGateBlocking,
  summarizeDirectionAcceptance,
} from "./direction-acceptance.js";
import { directionPartHashes } from "./direction-hash.js";
import { directionHasShots, leafSequenceShotIds } from "./direction-frames.js";
import { type ShotWaiver, type WaiverCoverage } from "./direction.js";
import { type Direction } from "./dsl/direction.js";
import { KonteError } from "./errors.js";
import { computeExportSignature } from "./export-signature.js";
import { liveDefinitionHashesOf } from "./feedback/definition-hashes.js";
import { feedbackStaleness, listAllFeedback } from "./feedback/index.js";
import { syncFileAssets } from "./file-sync.js";
import { type Finding, reviewHold } from "./finding.js";
import { listSpendingAssets, liveGenerationVariantIds } from "./generation-selection.js";
import {
  type DependencyGraph,
  videoDependentsHoldVerdicts,
  buildDependencyGraph,
  listUnusedAddresses,
} from "./graph.js";
import { jobStatusFlags } from "./job-diagnosis.js";
import { JobIndex } from "./job-index.js";
import { JobManager, isJobTerminal } from "./job-manager.js";
import { type PatchCatalog, findPendingPatches, loadPatchCatalog, patchHashesOf } from "./patch.js";
import { unacceptedOutsideRefs, unacceptedThumbnailRefs } from "./render-plan.js";
import { reviewTimes as readReviewTimes } from "./review-record.js";
import { requireShotStages } from "./select-definition.js";
import { shotNeedsVerdict, stageReviewDecidableAddresses } from "./shot-accept-targets.js";
import { unreadSongVariants } from "./song-queue.js";
import { sourceViewOf, unreadChunks } from "./source-direction.js";
import { sourceDirLabel } from "./source-chunker.js";
import {
  unsatisfiedCharacters,
  unsatisfiedVoices,
  judgeSpend,
  type SpendRequest,
  patchSpendRequest,
  spendHeldError,
} from "./spend-gate.js";
import { loadStageDefinitions, loadDirectionIfPresent } from "./stage-definitions.js";
import { type StalenessView, rebakesOverAccept } from "./staleness.js";
import { StateManager } from "./state/index.js";
import {
  type AddressInfo,
  type ExportReadiness,
  type LastExport,
  type ReelProgress,
  type StatusSections,
  buildAddressInfo,
  computeExportReadiness,
  computeLastExports,
  computeStatusSections,
  detectOrphans,
  latestFailedExport,
  isProblemAddress,
} from "./status-sections.js";
import {
  type SuggestedAction,
  type DefinitionRestore,
  type SongPending,
  suggestForStatus,
  type SourceGaps,
} from "./suggested-actions.js";
import { ERROR_GLIMPSE_WIDTH, truncateSingleLine } from "./truncate.js";

export interface StatusReport {
  infos: AddressInfo[];
  sections: StatusSections;
  /** Every job record, read once for the whole report. */
  jobs: JobRecord[];
  readiness: ExportReadiness[];
  lastExports: LastExport[];
  /**
   * Job ids of jobs still in flight whose variant is gone from state. `clean` refuses an active
   * job, so the step is a cancel.
   */
  orphanJobIds: string[];
  /** Job ids of failed comfy provisioning jobs — model downloads and node install/activate. */
  standaloneFailureJobIds: string[];
  /** Patch scripts that failed to load. Keyed by file path, which is not an address. */
  patchErrors: { filePath: string; message: string }[];
  /** What each outstanding patch would spend on, for the checks to read. */
  patchSubjects: PatchSubject[];
}

// Each composition stage's accept count in its reel review's units, read by the review's own rules
// so the two surfaces report one number.
function reelProgressByStage(
  manager: StateManager,
  leafStages: ReadonlyMap<string, AnimaticDefinition | VideoDefinition>,
  videoDefinition: VideoDefinition | null,
  counterpartOf: (stage: string) => AnimaticDefinition | VideoDefinition | null,
  waiverShotIds: ReadonlySet<string> | undefined,
): Partial<Record<Stage, ReelProgress>> {
  const stages = new Map(leafStages);
  if (videoDefinition) stages.set("video", videoDefinition);
  const out: Partial<Record<Stage, ReelProgress>> = {};
  for (const [stage, def] of stages) {
    const counterpart = counterpartOf(stage);
    // A board aside carries konte's slug, nothing of the author's to sign off.
    const shots = def.shots.filter((s) => !s.pending && !(s.aside && !s.shotFn));
    const acceptedShots = shots.filter(
      (s) =>
        !waiverShotIds?.has(s.id) &&
        !shotNeedsVerdict(
          manager,
          def,
          { shotId: s.id, pending: false, shotFn: s.shotFn ?? null },
          counterpart,
        ),
    ).length;
    const leafNeedsReview = (address: string) =>
      materializedLeafReviewStatus(manager, address).needsReview;
    const stemAddress = formatTimelineStemAddress(def.stage);
    out[stage as Stage] = {
      shots: shots.length,
      acceptedShots,
      soundtrackUnsigned:
        (def.timelineSoundtracks?.length ?? 0) > 0 && leafNeedsReview(stemAddress),
      overlayUnsigned:
        def.overlay !== undefined &&
        shotAcceptsStand(manager, def, counterpart) &&
        leafNeedsReview(formatTimelineOverlayAddress(def.stage)),
      thumbnailUnsigned: unacceptedThumbnailRefs(def, manager).some(isThumbnailAddress),
    };
  }
  return out;
}

// A stranded take is not on the page.
function dropStrandedFromNeedsReview(sections: StatusSections, findings: readonly Finding[]) {
  const stranded = new Set(
    findings.flatMap((f) => (f.code === "take-stranded" && f.variant ? [f.variant] : [])),
  );
  if (stranded.size === 0) return;
  sections.needsReview = sections.needsReview.flatMap((item) => {
    if (!item.variantId) return [item];
    const kept = (item.variants ?? [{ variantId: item.variantId, detail: item.detail }]).filter(
      (v) => !stranded.has(v.variantId),
    );
    const [first] = kept;
    if (!first) return [];
    return [
      {
        ...item,
        detail: first.detail,
        variantId: first.variantId,
        ...(item.variants ? { variants: kept } : {}),
      },
    ];
  });
}

// The shared computation behind `konte status`:
// every section, the per-stage progress, and the last exports are
// derived from the definition-supplied `addresses` so both renderings agree —
// including assets with no variant yet (which carry no `state.assets` entry).
async function buildStatusReport(
  addresses: string[],
  manager: StateManager,
  jobManager: JobManager,
  getDefinition: (addr: string) => AssetStageDefinition | null,
  options?: {
    videoRoot?: string;
    unacceptedCast?: readonly string[];
    /** Per-stage undeveloped-shot counts, so a stage with only pending shots still gets a line. */
    pendingShotsByStage?: Partial<Record<Stage, number>>;
    /** The loaded video definition — drives the export signature and last-export scope. */
    videoDefinition?: VideoDefinition | null;
    graph?: DependencyGraph | null;
    /** Shots with a direction waiver their accept would sign off. */
    waiverShotIds?: ReadonlySet<string>;
  },
): Promise<StatusReport> {
  const state = manager.getState();
  const everyJob = await jobManager.listJobs();
  const jobIndex = new JobIndex(everyJob);
  // This whole report is one read-only pass over one loaded state, so every address's
  // staleness walks share one memo instead of re-exploring the same upstream cones. Taken from the
  // manager, so it carries the definitions resolution is judged by.
  const stalenessView = manager.stalenessView();

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
    await liveGenerationVariantIds(jobManager.videoRoot, everyJob, state),
    stalenessView,
  );

  // Status is asset/variant-oriented. Provisioning and export jobs carry no asset
  // address, so they don't fit the per-asset sections — but a failed provisioning job
  // blocks the generation jobs that depend on it, and a failed export is the outcome of
  // the last `konte export`, so surface those failures on their own.
  const allJobs = everyJob.filter((job): job is GenerationJob => job.kind === "generation");
  const failedExport = latestFailedExport(everyJob);
  const jobFailures = everyJob.flatMap((job) => {
    if (job.status !== "failed") return [];
    if (job === failedExport) {
      return [{ jobId: job.id, label: "video", error: job.error, what: "export" }];
    }
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
  const isLeafAddress = isMaterializedLeafAddress;
  const leafStages = new Map<string, AnimaticDefinition | VideoDefinition>();
  for (const addr of addresses) {
    if (!isLeafAddress(addr)) continue;
    const stage = getStage(addr);
    if (leafStages.has(stage)) continue;
    const def = getDefinition(addr);
    if (def && isShotStageDefinition(def)) leafStages.set(stage, def);
  }
  // The other shot stage, whose accept may settle a leaf of this one (`leafSettledAcross`).
  const counterpartOf = (stage: string): AnimaticDefinition | VideoDefinition | null =>
    stage === "animatic"
      ? (options?.videoDefinition ?? null)
      : stage === "video"
        ? (leafStages.get("animatic") ?? null)
        : null;

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
    referenceDef ? listExposedReferenceAddresses(referenceDef) : [],
  );

  const infos: AddressInfo[] = addresses.map((addr) => {
    let assetKind: AddressInfo["assetKind"] = null;
    let definitionHash: string | null = null;
    let missingFilePath: string | null = null;
    let leafReady = false;
    const def = getDefinition(addr);
    const shotStageDef = def && isShotStageDefinition(def) ? def : null;
    // An asset the stage declared without returning it is an intermediate: it is generated and
    // tracked, but no review surface lists it and no accept is owed on it (see
    // `listExposedReferenceAddresses`). A plate is judged inside the panels drawn on it, whose
    // accept cascades onto it. Every other address is somebody's to decide.
    // The overlay is signed off by the shot accepts under it, and reviewed on its own only once they
    // all stand.
    const overlayStage = isOverlayAddress(addr) ? (leafStages.get(getStage(addr)) ?? null) : null;
    const settledAcross = leafSettledAcross(
      manager,
      shotStageDef,
      counterpartOf(getStage(addr)),
      addr,
    );
    // Reviewed on the video's page; status never sends anyone to the board's.
    const awaitsVideo = [boardCompositionAwaitsVideo, boardStemAwaitsVideo].some((awaits) =>
      awaits(manager, shotStageDef, options?.videoDefinition ?? null, addr),
    );
    const reviewTarget =
      (getStage(addr) !== "reference" || isDeliveryAddress(addr) || exposedReferences.has(addr)) &&
      !isPlateAddress(addr) &&
      !settledAcross &&
      !awaitsVideo &&
      (!isOverlayAddress(addr) ||
        (overlayStage !== null &&
          shotAcceptsStand(manager, overlayStage, counterpartOf(overlayStage.stage))));
    if (def && isLeafAddress(addr)) {
      // A composition/stem/overlay has no AssetDefinition; it is a no-job leaf of its stage's
      // definition.
      assetKind = isStemAddress(addr) ? "stem" : isOverlayAddress(addr) ? "overlay" : "composition";
      definitionHash = definitionHashForAddress(def, addr);
      const leafDef = leafStages.get(getStage(addr)) ?? null;
      // Leaves are materialized only on accept, so a never-accepted leaf has no variant — its
      // first-review need is this live signal (renderable + refs resolvable), not a ready variant.
      leafReady =
        definitionHash !== null &&
        leafDef !== null &&
        leafReadyForReview(
          manager,
          leafDef,
          addr,
          getStage(addr) === "video" ? leafStages.get("animatic") : null,
        );
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
        const entry = getAssetEntry(def, addr) as AssetDefinition;
        assetKind = entry.kind;
        if (entry.kind === "file") {
          const onDisk = options?.videoRoot
            ? existsSync(path.resolve(options.videoRoot, entry.path))
            : false;
          // Carry the declared path, not the resolved one: it is what the author wrote and where
          // they must put the media.
          if (!onDisk) missingFilePath = entry.path;
        } else {
          definitionHash = computeDefinitionHash(entry);
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

    const info = buildAddressInfo(addr, stalenessView, {
      jobsByVariantId,
      assetKind,
      jobs: jobIndex,
      deadVariantIds: deadByAddress.get(addr),
      leafReadyForReview: leafReady,
      missingFilePath,
      patchHashes,
      reviewTarget,
      reviewUnreachable,
    });
    if (settledAcross) info.staleAcceptStands = info.staleVariants.length > 0;
    return info;
  });

  // A stale accept every video take built on stands over too: its refresh would not change the cut.
  const graph = options?.graph;
  if (graph) {
    const infoByAddress = new Map(infos.map((info) => [info.address, info]));
    const verdictOf = (address: string): "holds" | "rebakes" | "open" | null => {
      const info = infoByAddress.get(address);
      if (!info) return null;
      if (!info.hasAccepted) return "open";
      const accepted = acceptedVariant(state, address)?.variant;
      return accepted && rebakesOverAccept(accepted, manager.registeredDeterministic(address))
        ? "rebakes"
        : "holds";
    };
    for (const info of infos) {
      if (info.staleVariants.length === 0 || info.staleAcceptStands) continue;
      if (isLeafAddress(info.address) || isDeliveryAddress(info.address)) continue;
      info.staleAcceptStands = videoDependentsHoldVerdicts(graph, info.address, verdictOf);
    }
  }

  // A human accept whose definition moved only under its adapter stands: the stage file holds
  // nothing to restore, and a reroll would replace the human's pick for a change they never made.
  for (const info of infos) {
    if (info.staleVariants.length === 0 || info.staleAcceptStands) continue;
    if (!holdsHumanVerdict(manager, info.address)) continue;
    const accepted = manager.getAcceptedVariant(info.address);
    const sv = info.staleVariants.find((v) => v.variantId === accepted);
    if (!sv || sv.patchStale || !sv.definitionStale) continue;
    info.staleAcceptStands = manager.registeredAdapterDrift(info.address, sv.variantId);
  }

  const orphans = detectOrphans(state, allJobs);
  // A board stem the video develops past the board, aged out by an edit. The video spend that
  // consumes it re-mixes it first.
  const board = leafStages.get("animatic") ?? null;
  const developing = options?.videoDefinition ?? null;
  const remixes =
    board && developing ? staleSettledLeaves(manager, board, developing, null, "stems") : [];
  const sections: StatusSections = {
    ...computeStatusSections(infos, orphans, jobFailures),
    // Declared but not yet realized — the same status as an ungenerated asset, so it is kept apart
    // from `needsReview` (there is nothing to review yet). `konte generate` picks these up, so the
    // fix is the command the author was going to run anyway.
    pendingPatches: [
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
    boardRemixes: remixes.map(({ address }) => ({
      address,
      detail: "the video develops the shot past the board",
    })),
  };
  // Undeveloped shots (pendingShot) carry no address, so they never reach `infos` — but the stage
  // must still show its "N shots undeveloped" line even when it has no other asset. Seed the count
  // into readiness so status (the single orientation point) reports it and never reads
  // "ready to export" with a shot pending.
  const readiness = computeExportReadiness(
    infos,
    options?.pendingShotsByStage,
    reelProgressByStage(
      manager,
      leafStages,
      options?.videoDefinition ?? null,
      counterpartOf,
      options?.waiverShotIds,
    ),
  );

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
  const videoLine = readiness.find((r) => r.label === "video");
  if (videoDef && videoLine) {
    videoLine.deliveryUpscalerMissing = deliveryUpscalerMissing(videoDef);
    videoLine.thumbnailUndecided = videoDef.thumbnail === undefined;
    videoLine.leavesUnsigned = [
      ...listCompositionAddresses(videoDef),
      ...listStemAddresses(videoDef),
      ...listOverlayAddresses(videoDef),
    ].some((address) => !leafSignedOff(manager, videoDef, address));
    videoLine.refsUnaccepted = unacceptedOutsideRefs(videoDef, manager).length;
  }
  const currentSignature = videoDef ? () => computeExportSignature(videoDef) : undefined;
  const lastExports = computeLastExports(videoDef != null, everyJob, currentSignature);

  return {
    infos,
    sections,
    jobs: everyJob,
    readiness,
    lastExports,
    orphanJobIds: orphans.orphanJobs.map((j) => j.variantId),
    standaloneFailureJobIds: jobFailures.map((f) => f.jobId),
    patchSubjects: pendingPatches.map((p) => ({
      sourceVariantId: p.sourceVariantId,
      sourceAddress: p.sourceAddress,
      prompts: p.prompts ?? [],
      pins: p.pins ?? [],
      assets: p.assets,
    })),
    patchErrors: patchCatalog.errors.map((e) => ({
      filePath: patchFileLabel(e.filePath),
      message: e.message,
    })),
  };
}

interface AssetStatus {
  report: StatusReport;
  /** The addresses the report covers — every stage's, minus the ones no deliverable consumes. */
  addresses: string[];
  /** Null when the definitions do not form a valid graph (a bad ref); graph-derived views are then skipped. */
  graph: DependencyGraph | null;
  /** Addresses no composition or panel consumes. */
  unusedPaths: Set<string>;
}

/** The address set and status report behind `konte status`, over already-loaded definitions. */
export async function buildAssetStatus(opts: {
  videoRoot: string;
  manager: StateManager;
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  reference: ReferenceDefinition | null;
  /** Progress/readiness only — no section depends on these. */
  unacceptedCast?: readonly string[];
  pendingShotsByStage?: Partial<Record<Stage, number>>;
  waiverShotIds?: ReadonlySet<string>;
}): Promise<AssetStatus> {
  const { videoRoot, manager, video, animatic, reference } = opts;
  const state = manager.getState();

  // Delivery (#delivery) targets are synthesized at export, not part of the definition — surface
  // whichever already exist in state so they can be tracked and cleaned.
  let addresses = [
    ...new Set([
      ...(reference ? listReferenceAddresses(reference) : []),
      ...listAddresses(animatic, "animatic"),
      ...listAddresses(video, "video"),
      // Both composition stages carry materialized leaves.
      ...listCompositionAddresses(animatic),
      ...listStemAddresses(animatic),
      ...listCompositionAddresses(video),
      ...listStemAddresses(video),
      ...listOverlayAddresses(animatic),
      ...listOverlayAddresses(video),
      ...listRemovedShotStemAddresses(state, animatic),
      ...listRemovedShotStemAddresses(state, video),
      ...Object.keys(state.assets).filter(isDeliveryAddress),
    ]),
  ];

  let graph: DependencyGraph | null = null;
  try {
    graph = buildDependencyGraph(video, animatic, reference ?? undefined);
  } catch {
    // dependency graph invalid (e.g. a bad ref) — skip the unused split; other commands report it.
  }
  // Drop assets no composition/panel consumes: they aren't part of any deliverable, so they must
  // not count toward acceptance or be nagged as needing review. `konte doctor` owns reporting them.
  const unusedPaths = new Set(graph ? listUnusedAddresses(video, animatic, graph, reference) : []);
  if (graph) {
    addresses = addresses.filter((addr) => !unusedPaths.has(addr));
  }

  const getDefinition = (addr: string) => {
    const stage = getStage(addr);
    switch (stage) {
      case "reference":
        return reference;
      case "animatic":
        return animatic;
      case "video":
        return video;
      case "direction":
        // The direction stage is feedback-only — its addresses never enter the status report
        // (they are not among any stage's listed asset addresses).
        throw new KonteError("INVALID_ADDRESS", "The direction stage has no asset definition");
      default:
        return assertNever(stage, "status getDefinition");
    }
  };

  // Registered before the report resolves anything.
  await applyResolutionDefinitions({
    videoRoot,
    state,
    definitions: { video, animatic, reference },
  });

  // After applyResolutionDefinitions: the gate reads `assetSkipReason`, which judges staleness by
  // the registered definitions. Each animatic's hash is memoized on the definition, so the report's
  // own pass over the same leaves pays for it once.

  const report = await buildStatusReport(
    addresses,
    manager,
    new JobManager(videoRoot),
    getDefinition,
    {
      videoRoot,
      unacceptedCast: opts.unacceptedCast,
      pendingShotsByStage: opts.pendingShotsByStage,
      videoDefinition: video,
      graph,
      waiverShotIds: opts.waiverShotIds,
    },
  );

  return { report, addresses, graph, unusedPaths };
}

export async function loadNeedsReviewTargets(videoRoot: string, scope?: string) {
  if (scope !== undefined) assertValidAddressScope(scope);
  const definitions = requireShotStages(await loadStageDefinitions(videoRoot));
  const manager = await StateManager.withLock(videoRoot, async (m) => {
    await syncFileAssets(definitions, m);
    return m;
  });
  const { report } = await buildAssetStatus({ videoRoot, manager, ...definitions });
  const items = report.sections.needsReview
    .filter((item) => scope === undefined || matchesAddressScope(item.address, scope))
    .flatMap((item) =>
      item.variants ? item.variants.map((variant) => ({ ...item, ...variant })) : [item],
    );
  return { definitions, manager, items };
}

type ProjectStatus = {
  report: StatusReport;
  suggestedActions: SuggestedAction[];
  directionAcceptance: DirectionAcceptanceSummary | null;
  directionEmpty: boolean;
  findings: Finding[];
  staleWaivers: StaleWaiverLine[];
};

// Everything `konte status` reports over one video, read-only: file assets are synced in memory, and
// nothing is written — neither the state nor assets/.gitignore.
export async function buildProjectStatus(videoRoot: string): Promise<ProjectStatus> {
  const { video, animatic, reference } = requireShotStages(await loadStageDefinitions(videoRoot));
  const definitions = { reference, animatic, video };
  // The direction gates animatic/video generation, so status flags an unaccepted (or
  // changed-since-accepted) direction as the first next step. A broken direction.ts fails here,
  // as the stages built on it already have — it is never reported as missing.
  const direction = await loadDirectionIfPresent(videoRoot);
  // File assets are synced in memory only, like `generate --plan`: status reports what is on
  // disk and writes nothing — neither the state nor assets/.gitignore.
  const manager = await StateManager.load(videoRoot);
  const savedOutputHashes = outputHashesOf(manager);
  await syncFileAssets(definitions, manager);
  const state = manager.getState();

  // The two gates on animatic/video spend — the direction's human acceptance and the characters'.
  // The reference stage is exempt from the direction gate (it is generated before it), but this
  // whole-project view always reports the direction; the characters are accepted *in* the reference
  // stage and reported alongside it.
  const baseCheckContext = await loadCheckContext({
    cueTakes: "played",
    videoRoot,
    definitions,
    direction,
    manager,
    graph: null,
  });
  const { directionAcceptance, acceptanceView, shotWaivers } = directionGateOf(
    direction,
    manager.getDirectionAcceptance(),
    waiverCoverageOf(baseCheckContext),
  );
  const unacceptedCast = unacceptedCastOf({ videoRoot, manager, direction, reference });

  // Undeveloped shots carry no address, so their stage would otherwise vanish from Progress —
  // seed the per-stage count so a pending-only stage still shows its "N shots undeveloped" line.
  const pendingShotsByStage = {
    animatic: animatic.shots.filter(isPendingAnimaticShot).length,
    video: video.shots.filter(isPendingShot).length,
  };
  // Derive the report from the definition-supplied addresses so both the text
  // and JSON renderings agree — including assets with no variant in state yet.
  const { report, graph, unusedPaths } = await buildAssetStatus({
    videoRoot,
    manager,
    video,
    animatic,
    reference,
    unacceptedCast: unacceptedCast.map((c) => c.id),
    pendingShotsByStage,
    waiverShotIds: new Set(shotWaivers.flatMap((w) => w.shotIds)),
  });
  dropUnsavedTakeIds(report, savedOutputHashes, outputHashesOf(manager));

  // Every finding, and what each spend and review it holds — the same judgement the gates make.
  const checkContext: CheckContext = {
    ...baseCheckContext,
    graph,
    patches: report.patchSubjects,
  };
  const findingReport = await collectFindings(checkContext);
  const findings = findingReport.findings.filter((f) => f.code !== "empty-direction");
  dropStrandedFromNeedsReview(report.sections, findingReport.findings);
  // A spend consumes the cue takes each address resolves to.
  const spendReport = await collectFindings(
    { ...checkContext, cueTakes: "resolved" },
    (traits) => traits.holds.spend !== undefined,
  );
  const spendHeld = (req: SpendRequest) =>
    spendHeldError(req, judgeSpend(checkContext, spendReport, req)) !== null;
  const { jobs } = report;
  const liveJobs = await liveGenerationVariantIds(videoRoot, jobs, state);
  const spendHeldStages = (["reference", "animatic", "video"] as const).filter((stage) => {
    const def = stage === "video" ? video : stage === "animatic" ? animatic : reference;
    const spending = listSpendingAssets(
      def,
      new Set(listAddresses(def, stage).filter((p) => !unusedPaths.has(p))),
      manager,
      liveJobs,
      graph,
    );
    return spendHeld({ command: "generate", stage, addresses: spending, targeted: false });
  });
  const previewHeldStages = (["reference", "animatic", "video"] as const).filter((stage) =>
    findingReport.findings.some((f) => reviewHold(f, { op: "preview", stage })),
  );

  // Feed Next steps the report's definition-aware "Needs review" and job-aware
  // "Problems" sets so it never suggests previewing a composition the section itself
  // excluded, nor cleaning a variant that is still generating (no file yet, no error).
  const waiverShotAddresses = waiverShotAddressesOf({ video, animatic, manager, shotWaivers });
  const pendingReviewAddresses = [
    ...new Set([...report.sections.needsReview.map((i) => i.address), ...waiverShotAddresses]),
  ];
  const { problemAddresses, failedJobVariantIds, missingFilePaths } = problemTargetsOf(
    report,
    unacceptedCast,
  );
  // Next steps offers the direction review only while it holds a spend. A part that changed
  // after the piece was signed off whole still shows on the review page, but is not a step.
  const directionReviewNeeded = acceptanceView !== null && !acceptanceView.gateSatisfied;
  // A shotless direction is the untouched template: the review step becomes "write it".
  const directionEmpty = direction !== null && !directionHasShots(direction);
  const songPending = pendingSong(manager, direction);
  const sourceGaps =
    directionReviewNeeded && direction ? await pendingSourceGaps(direction, videoRoot) : null;
  const jobSignals = jobSignalsOf({ videoRoot, direction, state, report });
  const pendingPatchAddresses = pendingPatchAddressesOf(report);
  // A patch the spend gate holds withholds `konte patch apply` for the set.
  const heldPatchAddresses = [
    ...new Set(
      report.patchSubjects
        .filter((p) => spendHeld(patchSpendRequest(p, "patch")))
        .map((p) => p.sourceAddress),
    ),
  ];
  const staleTargets = staleTargetsOf({
    videoRoot,
    manager,
    definitions,
    report,
    pendingPatchAddresses,
  });
  // One memo for the rest of this pass: a comment's subject and a take Next steps calls
  // awaiting review are both takes the review pages display, read by their resolution.
  const readView = manager.stalenessView();
  const feedbackAddresses = await standingFeedbackAddresses({
    videoRoot,
    video,
    animatic,
    direction,
    state,
    readView,
  });

  const suggestedActions = suggestForStatus({
    state,
    stalenessView: readView,
    feedbackAddresses: [...feedbackAddresses],
    findings,
    spendHeldStages,
    previewHeldStages,
    pendingReviewAddresses,
    problemAddresses,
    failedJobVariantIds,
    // The whole list, blocked ones included: the bare `konte patch apply` takes every pending
    // patch, so what is offered depends on all of them, not on the appliable subset.
    pendingPatchAddresses,
    blockedPatchAddresses: heldPatchAddresses,
    boardRemixAddresses: report.sections.boardRemixes.map((i) => i.address),
    ...staleTargets,
    missingFilePaths,
    orphanJobIds: report.orphanJobIds,
    standaloneFailureJobIds: report.standaloneFailureJobIds,
    patchErrors: report.patchErrors,
    // Hand Next steps the report's own conclusions rather than leaving it to re-derive them
    // from `state`: only these see a never-generated asset (which has no state entry at all),
    // a job already in flight, and the gates that would abort the command being suggested.
    readiness: report.readiness,
    lastExports: report.lastExports,
    directionReviewNeeded,
    unacceptedCast,
    directionEmpty,
    ...(songPending ? { songPending } : {}),
    ...(sourceGaps ? { sourceGaps } : {}),
    ...jobSignals,
    ...pendingShotSteps({ video, animatic, direction, manager }),
  });

  return {
    report,
    suggestedActions,
    directionAcceptance,
    directionEmpty,
    findings,
    staleWaivers: findingReport.staleWaivers,
  };
}

function outputHashesOf(manager: StateManager): Map<string, string | null> {
  return new Map(
    Object.values(manager.getState().assets).flatMap((a) =>
      Object.entries(a.variants ?? {}).map(([id, v]) => [id, v.outputHash] as const),
    ),
  );
}

// A file placed or replaced since the last write is a take only the in-memory sync holds: `accept`
// would refuse its id, or sign off the bytes the state still records. The review page records it.
function dropUnsavedTakeIds(
  report: StatusReport,
  saved: ReadonlyMap<string, string | null>,
  synced: ReadonlyMap<string, string | null>,
): void {
  for (const item of Object.values(report.sections).flat()) {
    const id = item.variantId;
    if (id && (!saved.has(id) || saved.get(id) !== synced.get(id))) {
      delete item.variantId;
      delete item.variants;
    }
  }
}

function directionGateOf(
  direction: Direction | null,
  acceptance: DirectionAcceptance | null,
  waiverCoverage: WaiverCoverage | undefined,
): {
  directionAcceptance: DirectionAcceptanceSummary | null;
  acceptanceView: ReturnType<typeof directionAcceptanceView> | null;
  shotWaivers: ShotWaiver[];
} {
  if (!direction) return { directionAcceptance: null, acceptanceView: null, shotWaivers: [] };
  return {
    directionAcceptance: summarizeDirectionAcceptance(direction, acceptance, waiverCoverage),
    acceptanceView: directionAcceptanceView(direction, acceptance, waiverCoverage),
    shotWaivers: shotWaiversAwaitingAccept(direction, acceptance, waiverCoverage),
  };
}

type UnacceptedCast = {
  id: string;
  declared: boolean;
  blocks: "all" | "video";
  missingFile: string | null;
};

// The cast gate: a character's look, plus every cast voice sample (the video stage's own
// gate — surfaced here too, or Next steps would keep offering a `generate video` that aborts).
// A `file` reference is satisfied by its media landing on disk, never by generating it, so
// carry the declared path along for the step that says where to put it. One already on disk
// was synced and waits only on its accept, like a generated one with output.
function unacceptedCastOf(opts: {
  videoRoot: string;
  manager: StateManager;
  direction: Direction | null;
  reference: ReferenceDefinition;
}): UnacceptedCast[] {
  const { videoRoot, manager, direction, reference } = opts;
  return (
    [
      ...unsatisfiedCharacters({ manager, direction }).map((c) => ({
        id: c.id,
        blocks: "all" as const,
      })),
      ...unsatisfiedVoices({ manager, direction }).map((v) => ({
        id: v.assetId,
        blocks: "video" as const,
      })),
    ]
      // A sample cast twice is still one asset to clear, so it is offered once.
      .filter((c, i, all) => all.findIndex((o) => o.id === c.id) === i)
      .map(({ id, blocks }) => {
        const entry = reference?.topLevelAssets?.[id];
        const missingFile =
          entry?.kind === "file" && !existsSync(path.resolve(videoRoot, entry.path))
            ? entry.path
            : null;
        const declared = reference?.exposedAssetNames?.includes(id) ?? false;
        return { id, declared, blocks, missingFile };
      })
  );
}

// A shot's waiver awaiting its accept is review work on the latest stage where the shot can be
// accepted: built, with its own takes and everything its composition draws resolved (the
// reel's `shotNotReady`).
function waiverShotAddressesOf(opts: {
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  manager: StateManager;
  shotWaivers: readonly ShotWaiver[];
}): string[] {
  const { video, animatic, manager } = opts;
  const builtShot = (stage: "animatic" | "video", shotId: string) => {
    const shot = (stage === "video" ? video : animatic).shots.find((s) => s.id === shotId);
    if (!shot || shot.pending || !shot.shotFn) return false;
    return [
      ...Object.keys(shot.assets).map((name) => formatAddress(stage, shotId, name)),
      ...(shot.compositionRefs ?? []),
    ].every((ref) => manager.resolveReference(ref, { includeStale: true }) !== null);
  };
  return opts.shotWaivers.flatMap((w) =>
    w.shotIds.flatMap((shotId) => {
      const stage = (["video", "animatic"] as const).find((s) => builtShot(s, shotId));
      return stage ? [formatShotAddress(stage, shotId)] : [];
    }),
  );
}

function problemTargetsOf(
  report: StatusReport,
  unacceptedCast: readonly UnacceptedCast[],
): { problemAddresses: string[]; failedJobVariantIds: string[]; missingFilePaths: string[] } {
  // Derive clean candidates from the address infos, not the "Problems" section: the
  // section also lists orphan jobs and model-download failures, which have no state
  // variant for `clean` to act on — suggesting clean for them would be a no-op. Mirror
  // the section's real-asset guard (unaccepted, no ready variant, has a dead variant).
  const problemInfos = report.infos.filter(isProblemAddress);
  const failedJobVariantIds = problemInfos.flatMap((info) =>
    info.failedJobs.map((job) => job.variantId),
  );
  const problemAddresses = [...new Set(problemInfos.map((info) => info.address))];
  // A declared `file` whose media is absent. It has no variant, so `problemAddresses` above
  // cannot see it and no `clean` reaches it. The cast's own missing files are named by the
  // cast gate, so they are dropped here.
  const castFilePaths = new Set(
    unacceptedCast.map((c) => c.missingFile).filter((p): p is string => p !== null),
  );
  const missingFilePaths = [
    ...new Set(
      report.infos
        .map((i) => i.missingFilePath)
        .filter((p): p is string => p !== null && !castFilePaths.has(p)),
    ),
  ];
  return { problemAddresses, failedJobVariantIds, missingFilePaths };
}

function jobSignalsOf(opts: {
  videoRoot: string;
  direction: Direction | null;
  state: KonteState;
  report: StatusReport;
}): {
  songReadingsPending: boolean;
  jobsInFlight: boolean;
  stuckJobIds: string[];
  songUnread: boolean;
} {
  const { jobs } = opts.report;
  const songReadingsPending = jobs.some(
    (j) => j.kind === "song-analysis" && (j.status === "pending" || j.status === "running"),
  );
  // An orphan job is offered `konte job cancel` instead.
  const orphanJobIds = new Set(opts.report.orphanJobIds);
  const activeJobs = jobs.filter((j) => !isJobTerminal(j.status) && !orphanJobIds.has(j.id));
  const stuckJobIds = activeJobs
    .filter((job) => jobStatusFlags({ job }).length > 0)
    .map((j) => j.id);
  // A take no job is reading: placed as a file, failed, or read against another clock.
  const songUnread =
    !songReadingsPending &&
    unreadSongVariants(opts.videoRoot, opts.direction, opts.state).length > 0;
  return { songReadingsPending, jobsInFlight: activeJobs.length > 0, stuckJobIds, songUnread };
}

// A broken patch is listed under the same section keyed by its FILE path, which is not an
// address — Next steps parses these with `getStage`, so letting one through would turn a
// report about a bad file into an INVALID_ADDRESS crash. They are offered as an edit instead
// (`patchErrors`).
function pendingPatchAddressesOf(report: StatusReport): string[] {
  return [
    ...new Set(
      report.sections.pendingPatches
        .map((i) => i.address)
        .filter((addr) => {
          try {
            parseAddress(addr);
            return true;
          } catch {
            return false;
          }
        }),
    ),
  ];
}

function staleTargetsOf(opts: {
  videoRoot: string;
  manager: StateManager;
  definitions: StageDefinitions;
  report: StatusReport;
  pendingPatchAddresses: readonly string[];
}): {
  staleAddresses: string[];
  deterministicStaleAddresses: string[];
  definitionRestores: DefinitionRestore[];
} {
  const { videoRoot, manager, definitions, report, pendingPatchAddresses } = opts;
  const state = manager.getState();
  const isPatchOutput = (address: string, variantId: string): boolean =>
    state.assets[address]?.variants?.[variantId]?.derivedFrom != null;
  // Accepted-and-stale, computed against the live definitions — so an edited asset is offered a
  // refresh too (Next steps' own fallback reads `state` alone and sees input-staleness only).
  const staleInfos = report.infos.filter((info) => {
    if (info.staleVariants.length === 0) return false;
    // Produced by `konte export`, never by a reroll — which rejects it (DELIVERY_NOT_REROLLABLE).
    if (isDeliveryAddress(info.address)) return false;
    // A fresh non-stale take is already waiting beside the accept: the refresh is the review,
    // which "Needs review" routes to `konte preview <stage>`.
    if (info.undecidedVariantId !== null) return false;
    if (info.staleAcceptStands) return false;
    // A refresh is already running or queued here; another reroll would spend a second time.
    if (info.generatingJobs.length > 0 || info.blockedJobs.length > 0) return false;
    // The stale take is a patch output. Its refresh is re-applying the correction, never a
    // reroll — which would generate a fresh original and orphan the correction hung off it.
    // Keyed on the take rather than on "Pending patches", because that section drops a patch
    // while its chain is in flight (findPendingPatches) and the output stays stale meanwhile.
    if (info.staleVariants.every((sv) => isPatchOutput(info.address, sv.variantId))) {
      return false;
    }
    // An ordinary take with a correction declared against it: `konte patch apply` is the step,
    // and a reroll would replace the very take that patch names.
    if (pendingPatchAddresses.includes(info.address)) return false;
    return true;
  });
  // `generate` skips an accepted asset even when stale ("accepted-stale") — except an unpatched
  // deterministic take, which it re-bakes over the accept. Read the same way `assetSkipReason` does, so the step named is one that does something:
  // `reroll` refuses a deterministic asset, and `generate` skips a human-accepted rerollable one.
  const rebakesOnGenerate = (address: string): boolean => {
    if (isMaterializedLeafAddress(address)) return false;
    const accepted = acceptedVariant(state, address);
    return (
      accepted !== null &&
      rebakesOverAccept(accepted.variant, manager.registeredDeterministic(address))
    );
  };
  const staleAddresses: string[] = [];
  const deterministicStaleAddresses: string[] = [];
  const definitionRestores: DefinitionRestore[] = [];
  for (const info of staleInfos) {
    const moved = info.staleVariants.find((sv) => sv.definitionStale && !sv.patchStale);
    if (moved && holdsHumanVerdict(manager, info.address)) {
      definitionRestores.push({
        address: info.address,
        variantId: moved.variantId,
        fields: definitionDriftFields(videoRoot, state, definitions, info.address, moved.variantId),
      });
      continue;
    }
    (rebakesOnGenerate(info.address) ? deterministicStaleAddresses : staleAddresses).push(
      info.address,
    );
  }
  return { staleAddresses, deterministicStaleAddresses, definitionRestores };
}

// The human's own words are the one input Next steps had no way to see. A comment counts
// while it still stands — once it is stale, whatever aged it already answered it. Every
// address counts, variant-bearing or not: the step is to read the words.
async function standingFeedbackAddresses(opts: {
  videoRoot: string;
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  direction: Direction | null;
  state: KonteState;
  readView: StalenessView;
}): Promise<Set<string>> {
  const { videoRoot, direction, state } = opts;
  const feedbackAddresses = new Set<string>();
  // The definition-side axes a take cannot carry — a video leaf's definition, a board panel's
  // movement. Without them a comment answered by an edit that minted no variant (rewriting the
  // `blocking` a comment asked for) would keep counting here forever.
  const definitionHashes = liveDefinitionHashesOf(opts.video, opts.animatic);
  // The direction's counterpart of those: a comment on a direction part snapshots that part's
  // content hash, and without them every such comment reads as still standing however far the
  // direction has moved since. `undefined` when direction.ts would not load, which leaves the
  // axis unevaluated rather than reporting every comment stale.
  const subjectHashes = direction ? directionPartHashes(direction) : undefined;
  const reviewTimes = await readReviewTimes(videoRoot);
  for (const { address, entry } of await listAllFeedback(videoRoot)) {
    if (feedbackAddresses.has(address)) continue;
    // Only a verdict of "stale" answers a comment. "unknown" is the reader saying it could
    // not look, which is no reason to stop routing what the human wrote.
    const staleness = feedbackStaleness(entry, address, state, {
      definitionHashes,
      subjectHashes,
      view: opts.readView,
      reviewTimes,
    });
    if (staleness === "stale") continue;
    feedbackAddresses.add(address);
  }
  return feedbackAddresses;
}

function pendingShotSteps(opts: {
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  direction: Direction | null;
  manager: StateManager;
}): {
  boardedPendingVideoShots: string[];
  nextSequencePendingShots?: { animatic: string[]; video: string[] };
} {
  const { video, animatic, direction, manager } = opts;
  const pendingVideoShots = video.shots.filter(isPendingShot).map((s) => s.id);
  const pendingAnimaticShots = new Set(
    animatic.shots.filter(isPendingAnimaticShot).map((s) => s.id),
  );
  const boardedPendingVideoShots = pendingVideoShots.filter((id) => {
    const board = animatic.shots.find((s) => s.id === id);
    if (!board || isPendingAnimaticShot(board)) return false;
    return Object.keys(board.assets).every(
      (name) => manager.getAcceptedVariant(formatAddress("animatic", id, name)) !== null,
    );
  });
  const nextSequence = direction
    ? leafSequenceShotIds(direction).find((ids) => ids.some((id) => pendingVideoShots.includes(id)))
    : undefined;
  const nextSequencePendingShots = nextSequence && {
    animatic: nextSequence.filter((id) => pendingAnimaticShots.has(id)),
    video: nextSequence.filter((id) => pendingVideoShots.includes(id)),
  };
  return {
    boardedPendingVideoShots,
    ...(nextSequencePendingShots ? { nextSequencePendingShots } : {}),
  };
}

// The song `policy.song` names, while no take of it is accepted.
function pendingSong(manager: StateManager, direction: Direction | null): SongPending | undefined {
  const song = direction?.policy.song;
  if (direction === null || song === undefined) return undefined;
  const address = formatReferenceAddress(song);
  if (manager.selectVariant(address, { requireAccepted: true }) !== null) return undefined;
  const variants = Object.values(manager.getState().assets[address]?.variants ?? {});
  return {
    address,
    hasVariant: variants.some((v) => v.file && v.status !== "dismissed"),
    directionReviewNeeded: songGateBlocking(direction, manager.getDirectionAcceptance()).length > 0,
  };
}

// What the digest the direction is written from still lacks; null where it lacks nothing.
async function pendingSourceGaps(
  direction: Direction,
  videoRoot: string,
): Promise<SourceGaps | null> {
  // A source that cannot be read is the locator check's finding, not a stop here.
  const sv = await sourceViewOf(direction, videoRoot).catch(() => null);
  if (!sv) return null;
  const unread = unreadChunks(sv);
  return unread.length > 0 ? { source: sourceDirLabel(sv.ref), unread } : null;
}
