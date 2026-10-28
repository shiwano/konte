import { existsSync } from "node:fs";
import { requireShotStages } from "../../core/select-definition.js";
import * as path from "node:path";
import type { Command } from "commander";
import {
  formatAddress,
  formatReferenceAddress,
  formatShotAddress,
  isDeliveryAddress,
  isMaterializedLeafAddress,
  listAssetPaths,
  parseAddress,
} from "../../core/address.js";
import { definitionDriftFields, isDeterministicAddress } from "../../core/definition-hashes.js";
import { holdsHumanVerdict } from "../../core/accept-cascade.js";
import { listSpendingAssets } from "../generation-selection.js";
import { directionHasShots, leafSequenceShotIds } from "../../core/direction.js";
import { syncFileAssets } from "../../core/file-sync.js";
import { StateManager } from "../../core/state/index.js";
import { feedbackStaleness, listAllFeedback } from "../../core/feedback/index.js";
import { directionPartHashes } from "../../core/direction-hash.js";
import { liveDefinitionHashesOf } from "./feedback/definition-hashes.js";
import {
  type DefinitionRestore,
  type SongPending,
  suggestForStatus,
} from "../../core/suggested-actions.js";
import { unreadSongTakes } from "../../core/song-queue.js";
import { isJobTerminal, JobManager } from "../../core/job-manager.js";
import { jobStatusFlags } from "../../core/job-diagnosis.js";
import { reviewTimes as readReviewTimes } from "../../core/review-record.js";
import type { Direction } from "../../core/dsl/direction.js";
import { isPendingShot, isPendingAnimaticShot } from "../../core/types/index.js";
import {
  loadDirectionIfPresent,
  loadStageDefinitions,
  unsatisfiedCharacters,
  unsatisfiedVoices,
} from "../load-definition.js";
import { collectFindings } from "../../core/checks.js";
import { reviewHold } from "../../core/finding.js";
import { judgeSpend, loadCheckContext, spendHeldError } from "../finding-gates.js";
import { printStatusReport } from "../print-status.js";
import { buildAssetStatus, needsReviewItems } from "../asset-status.js";
import { isProblemAddress } from "../../core/status-sections.js";
import {
  type DirectionAcceptanceSummary,
  directionAcceptanceView,
  shotWaiversAwaitingAccept,
  songGateBlocking,
  summarizeDirectionAcceptance,
} from "../../core/direction-acceptance.js";
import { currentRoots, requireVideoRoots } from "../context.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show whole-project status")
    .addHelpText(
      "after",
      "\nThe single orientation point: every stage, in one whole-project view. To narrow to\n" +
        "one asset, use `konte inspect <address>`.\n" +
        "\nSections:\n" +
        "  Progress         The direction's acceptance, then per-stage counts\n" +
        "                   (the video stage is marked ready to export when all accepted)\n" +
        "  Findings         Every machine finding, grouped by the file it is fixed in, each by its\n" +
        "                   waiver key or code — and every waiver whose finding is gone\n" +
        "  Needs review     Anything awaiting a review and accept\n" +
        "  Problems         A dead variant, a failed job, or a declared file that is not on disk\n" +
        "  Needs regenerate Assets whose every take is stale and unaccepted — `generate` remakes them\n" +
        "  Stale            Accepted variants whose inputs or definition have changed, unless the accept stands\n" +
        "\nThe sections are `-v` only: every state they report, Next steps names a command or an\n" +
        "edit for. Progress, Next steps and Findings always print.\n" +
        "\nRunning, queued and pending jobs are not listed — `konte job list` reports them.",
    )
    .option("-v, --verbose", "Print the sections — every address behind the counts and steps above")
    .action(async (opts: { verbose?: boolean }) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      const currentVideo = currentRoots()?.video;
      const videoName = currentVideo?.kind === "selected" ? currentVideo.name : null;
      const { video, animatic, reference } = requireShotStages(
        await loadStageDefinitions(videoRoot),
      );
      // The direction gates animatic/video generation, so status flags an unaccepted (or
      // changed-since-accepted) direction as the first next step. A broken direction.ts fails here,
      // as the stages built on it already have — it is never reported as missing.
      const direction = await loadDirectionIfPresent(videoRoot);
      // File assets are synced in memory only, like `generate --plan`: status reports what is on
      // disk and writes nothing — neither the state nor assets/.gitignore.
      const manager = await StateManager.load(videoRoot);
      const outputHashes = () =>
        new Map(
          Object.values(manager.getState().assets).flatMap((a) =>
            Object.entries(a.variants ?? {}).map(([id, v]) => [id, v.outputHash] as const),
          ),
        );
      const savedOutputHashes = outputHashes();
      await syncFileAssets({ reference, animatic, video }, manager);
      const state = manager.getState();

      // The two gates on animatic/video spend — the direction's human acceptance and the characters'.
      // The reference stage is exempt from the direction gate (it is generated before it), but this
      // whole-project view always reports the direction; the characters are accepted *in* the reference
      // stage and reported alongside it.
      const acceptance = manager.getDirectionAcceptance();
      const directionAcceptance: DirectionAcceptanceSummary | null = direction
        ? summarizeDirectionAcceptance(direction, acceptance)
        : null;
      const acceptanceView = direction ? directionAcceptanceView(direction, acceptance) : null;
      // The cast gate: a character's look, plus every cast voice sample (the video stage's own
      // gate — surfaced here too, or Next steps would keep offering a `generate video` that aborts).
      // A `file` reference is satisfied by its media landing on disk, never by generating it, so
      // carry the declared path along for the step that says where to put it. One already on disk
      // was synced above and waits only on its accept, like a generated one with output.
      const unacceptedCast = [
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
        });

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
        waiverShotIds: new Set(
          direction
            ? shotWaiversAwaitingAccept(direction, manager.getDirectionAcceptance()).flatMap(
                (w) => w.shotIds,
              )
            : [],
        ),
      });
      // A file placed or replaced since the last write is a take only the in-memory sync above holds:
      // `accept` would refuse its id, or sign off the bytes the state still records. The review page
      // records it.
      const syncedOutputHashes = outputHashes();
      for (const item of report.sections.flatMap((section) => section.items)) {
        const id = item.variantId;
        if (
          id &&
          (!savedOutputHashes.has(id) || savedOutputHashes.get(id) !== syncedOutputHashes.get(id))
        ) {
          delete item.variantId;
          delete item.takes;
        }
      }

      // Every finding, and what each spend and review it holds — the same judgement the gates make.
      const checkContext = await loadCheckContext({
        videoRoot,
        definitions: { reference, animatic, video },
        direction,
        manager,
        graph,
        patches: report.patchSubjects,
      });
      const findingReport = await collectFindings(checkContext);
      const spendHeldStages = (["reference", "animatic", "video"] as const).filter((stage) => {
        const def = stage === "video" ? video : stage === "animatic" ? animatic : reference;
        const spending = listSpendingAssets(
          def,
          new Set(listAssetPaths(def, stage).filter((p) => !unusedPaths.has(p))),
          manager,
          graph,
        );
        const req = { command: "generate", stage, assetPaths: spending, targeted: false } as const;
        return spendHeldError(req, judgeSpend(checkContext, findingReport, req)) !== null;
      });
      const previewHeldStages = (["reference", "animatic", "video"] as const).filter((stage) =>
        findingReport.findings.some((f) => reviewHold(f, { op: "preview", stage })),
      );

      // Feed Next steps the report's definition-aware "Needs review" and job-aware
      // "Problems" sets so it never suggests previewing a composition the section itself
      // excluded, nor cleaning a variant that is still generating (no file yet, no error).
      // A shot's waiver awaiting its accept is review work on the latest stage where the shot can be
      // accepted: built, with its own takes and everything its composition draws resolved (the
      // reel's `shotNotReady`).
      const builtShot = (stage: "animatic" | "video", shotId: string) => {
        const shot = (stage === "video" ? video : animatic).shots.find((s) => s.id === shotId);
        if (!shot || shot.pending || !shot.shotFn) return false;
        return [
          ...Object.keys(shot.assets).map((name) => formatAddress(stage, shotId, name)),
          ...(shot.compositionRefs ?? []),
        ].every((ref) => manager.resolveReference(ref, { includeStale: true }) !== null);
      };
      const waiverShotAddresses = direction
        ? shotWaiversAwaitingAccept(direction, manager.getDirectionAcceptance()).flatMap((w) =>
            w.shotIds.flatMap((shotId) => {
              const stage = (["video", "animatic"] as const).find((s) => builtShot(s, shotId));
              return stage ? [formatShotAddress(stage, shotId)] : [];
            }),
          )
        : [];
      const pendingReviewAddresses = [
        ...new Set([...needsReviewItems(report).map((i) => i.address), ...waiverShotAddresses]),
      ];
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
      // Next steps offers the direction review only while it holds a spend. A part that changed
      // after the piece was signed off whole still shows on the review page, but is not a step.
      const directionReviewNeeded = acceptanceView !== null && !acceptanceView.gateSatisfied;
      // A shotless direction is the untouched template: the review step becomes "write it".
      const directionEmpty = direction !== null && !directionHasShots(direction);
      const songPending = pendingSong(manager, direction);
      const jobs = await new JobManager(videoRoot).listJobs();
      const songReadingsPending = jobs.some(
        (j) => j.kind === "song-analysis" && (j.status === "pending" || j.status === "running"),
      );
      // An orphan job is offered `konte job cancel` instead.
      const orphanJobIds = new Set(report.orphanJobIds);
      const activeJobs = jobs.filter((j) => !isJobTerminal(j.status) && !orphanJobIds.has(j.id));
      const stuckJobIds = activeJobs
        .filter((job) => jobStatusFlags({ job }).length > 0)
        .map((j) => j.id);
      // A take no job is reading: placed as a file, failed, or read against another clock.
      const songUnread =
        !songReadingsPending && unreadSongTakes(videoRoot, direction, state).length > 0;
      // A broken patch is listed under the same section keyed by its FILE path, which is not an
      // address — Next steps parses these with `getStage`, so letting one through would turn a
      // report about a bad file into an INVALID_ADDRESS crash. They are offered as an edit instead
      // (`patchErrors`).
      const pendingPatchAddresses = [
        ...new Set(
          report.sections
            .find((s) => s.title === "Pending patches")
            ?.items.map((i) => i.address)
            .filter((addr) => {
              try {
                parseAddress(addr);
                return true;
              } catch {
                return false;
              }
            }) ?? [],
        ),
      ];
      // A patch whose own prompt or pin finding holds it withholds `konte patch apply` for the set.
      const heldPatchAddresses = [
        ...new Set(
          findingReport.findings.flatMap((f) =>
            f.fixIn.patch === undefined
              ? []
              : report.patchSubjects
                  .filter((p) => p.sourceVariantId === f.fixIn.patch)
                  .map((p) => p.sourceAddress),
          ),
        ),
      ];

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
        if (info.undecidedTakeVariantId !== null) return false;
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
      const rebakesOnGenerate = (address: string): boolean =>
        !isMaterializedLeafAddress(address) &&
        Object.values(state.assets[address]?.variants ?? {}).some(
          (v) =>
            v.status === "accepted" &&
            v.derivedFrom == null &&
            isDeterministicAddress({ reference, animatic, video }, address),
        );
      const staleAddresses: string[] = [];
      const deterministicStaleAddresses: string[] = [];
      const definitionRestores: DefinitionRestore[] = [];
      for (const info of staleInfos) {
        const moved = info.staleVariants.find((sv) => sv.definitionStale && !sv.patchStale);
        if (moved && holdsHumanVerdict(manager, info.address)) {
          definitionRestores.push({
            address: info.address,
            variantId: moved.variantId,
            fields: definitionDriftFields(
              videoRoot,
              state,
              { reference, animatic, video },
              info.address,
              moved.variantId,
            ),
          });
          continue;
        }
        (rebakesOnGenerate(info.address) ? deterministicStaleAddresses : staleAddresses).push(
          info.address,
        );
      }
      // The human's own words are the one input Next steps had no way to see. A comment counts
      // while it still stands — once it is stale, whatever aged it already answered it. Every
      // address counts, variant-bearing or not: the step is to read the words.
      const feedbackAddresses = new Set<string>();
      // The definition-side axes a take cannot carry — a video leaf's definition, a board panel's
      // movement. Without them a comment answered by an edit that minted no variant (rewriting the
      // `blocking` a comment asked for) would keep counting here forever.
      const definitionHashes = liveDefinitionHashesOf(video, animatic);
      // The direction's counterpart of those: a comment on a direction part snapshots that part's
      // content hash, and without them every such comment reads as still standing however far the
      // direction has moved since. `undefined` when direction.ts would not load, which leaves the
      // axis unevaluated rather than reporting every comment stale.
      const subjectHashes = direction ? directionPartHashes(direction) : undefined;
      const reviewTimes = await readReviewTimes(videoRoot);
      // One memo for the rest of this pass: a comment's subject and a take Next steps calls
      // awaiting review are both takes the review pages display, read by their resolution.
      const readCache = manager.stalenessCache();
      for (const { address, entry } of await listAllFeedback(videoRoot)) {
        if (feedbackAddresses.has(address)) continue;
        // Only a verdict of "stale" answers a comment. "unknown" is the reader saying it could
        // not look, which is no reason to stop routing what the human wrote.
        const staleness = feedbackStaleness(entry, address, state, {
          definitionHashes,
          subjectHashes,
          cache: readCache,
          reviewTimes,
        });
        if (staleness === "stale") continue;
        feedbackAddresses.add(address);
      }

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
        ? leafSequenceShotIds(direction).find((ids) =>
            ids.some((id) => pendingVideoShots.includes(id)),
          )
        : undefined;
      const nextSequencePendingShots = nextSequence && {
        animatic: nextSequence.filter((id) => pendingAnimaticShots.has(id)),
        video: nextSequence.filter((id) => pendingVideoShots.includes(id)),
      };

      const suggestedActions = suggestForStatus({
        state,
        stalenessCache: readCache,
        feedbackAddresses: [...feedbackAddresses],
        findings: findingReport.findings.filter((f) => f.code !== "empty-direction"),
        spendHeldStages,
        previewHeldStages,
        pendingReviewAddresses,
        problemAddresses,
        failedJobVariantIds,
        // The whole list, blocked ones included: the bare `konte patch apply` takes every pending
        // patch, so what is offered depends on all of them, not on the appliable subset.
        pendingPatchAddresses,
        blockedPatchAddresses: heldPatchAddresses,
        boardRemixAddresses:
          report.sections
            .find((s) => s.title === "Board stems to re-mix")
            ?.items.map((i) => i.address) ?? [],
        staleAddresses,
        deterministicStaleAddresses,
        definitionRestores,
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
        songReadingsPending,
        jobsInFlight: activeJobs.length > 0,
        stuckJobIds,
        songUnread,
        boardedPendingVideoShots,
        ...(nextSequencePendingShots ? { nextSequencePendingShots } : {}),
      });

      if (videoName) console.log(`Video: ${videoName}\n`);
      printStatusReport(report, suggestedActions, {
        videoRoot,
        verbose: opts.verbose,
        directionAcceptance,
        directionEmpty,
        findings: findingReport.findings.filter((f) => f.code !== "empty-direction"),
        staleWaivers: findingReport.staleWaivers,
      });
    });
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
    hasTake: variants.some((v) => v.file && v.status !== "dismissed"),
    directionReviewNeeded: songGateBlocking(direction, manager.getDirectionAcceptance()).length > 0,
  };
}
