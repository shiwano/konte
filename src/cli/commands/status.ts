import type { Command } from "commander";
import {
  getAssetEntry,
  isDeliveryAddress,
  isMaterializedLeafAddress,
  listAssetPaths,
  parseAddress,
} from "../../core/address.js";
import { findAnimaticOverflows, formatAnimaticOverflow } from "../../core/animatic-overflow.js";
import { isDeterministicAddress } from "../../core/definition-hashes.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import { assetSkipReason } from "../generate-orchestrator.js";
import {
  checkDirection,
  classifyDirectionFinding,
  directionHasShots,
  directionWaiverKey,
  reportableDirectionFindings,
} from "../../core/direction.js";
import { syncFileAssets } from "../../core/file-sync.js";
import { findAllUnmetPrerequisites, prerequisiteShot } from "../../core/review-prerequisites.js";
import { StateManager } from "../../core/state/index.js";
import { feedbackStaleness, listAllFeedback } from "../../core/feedback/index.js";
import { directionPartHashes } from "../../core/direction-hash.js";
import { liveDefinitionHashesOf } from "./feedback/definition-hashes.js";
import { suggestForStatus } from "../../core/suggested-actions.js";
import { isPendingShot, isPendingAnimaticShot } from "../../core/types/index.js";
import {
  loadDirectionIfPresent,
  loadStageDefinitions,
  loadAnimaticSetupState,
  loadStagingStageState,
  unacceptedUpstreamDeps,
  unsatisfiedCharacters,
  unsatisfiedVoices,
} from "../load-definition.js";
import { checkPins, formatPinFinding, type PinCheckSubject } from "../../core/pin-check.js";
import { STAGE_ENTRY_FILE } from "../../core/roots.js";
import {
  checkPrompts,
  formatPromptFinding,
  type PromptCheckSubject,
} from "../../core/prompt-check.js";
import {
  printStatusReport,
  type PinFindingLine,
  type PinStaleWaiverLine,
  type PromptFindingLine,
  type PromptStaleWaiverLine,
} from "../print-status.js";
import { buildAssetStatus, needsReviewItems } from "../asset-status.js";
import { isProblemAddress } from "../../core/status-sections.js";
import {
  type DirectionAcceptanceSummary,
  directionAcceptanceView,
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
        "  Direction errors    Structural errors in direction.ts — generate refuses them; not waivable\n" +
        "  Direction findings  Unresolved structural findings on the direction, each with its waiver key\n" +
        "  Stale direction waivers  Waivers whose finding is gone — remove them from direction.ts\n" +
        "  Prompt findings     Prompts naming what to leave out, each with its waiver key\n" +
        "  Stale prompt waivers     Prompt waivers whose phrase is gone — remove them\n" +
        "  Needs authoring  Targets holding output whose review still needs something written\n" +
        "  Needs retiming   Shots whose animatic narration runs past the duration written for them\n" +
        "  Needs review     Anything awaiting a review and accept\n" +
        "  Problems         A dead variant, a failed job, or a declared file that is not on disk\n" +
        "  Needs regenerate Assets whose every take is stale and unaccepted — `generate` remakes them\n" +
        "  Stale            Accepted variants whose inputs or definition have changed, unless the accept stands\n" +
        "\nThe sections are `-v` only: every state they report, Next steps names a command or an\n" +
        "edit for. Progress, Next steps and the direction and\n" +
        "prompt blocks always print.\n" +
        "\nRunning, queued and pending jobs are not listed — `konte job list` reports them.",
    )
    .option("-v, --verbose", "Print the sections — every address behind the counts and steps above")
    .action(async (opts: { verbose?: boolean }) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      const currentVideo = currentRoots()?.video;
      const videoName = currentVideo?.kind === "selected" ? currentVideo.name : null;
      const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
      // The direction gates animatic/video generation, so status flags an unaccepted (or
      // changed-since-accepted) direction as the first next step. Tolerant: a broken direction.ts
      // surfaces via the gate/doctor, not here.
      const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
      // File assets are synced in memory only, like `generate --plan`: status reports what is on
      // disk and writes nothing — neither the state nor assets/.gitignore.
      const manager = await StateManager.load(videoRoot);
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
      // The parts short of accepted, named. The counts above only tally them; a caller scripting
      // against it (or an agent deciding what to put in front of the human) needs to know
      // WHICH, and a count alone would send it back to diff the direction itself. Both lists ship —
      // they part company once the piece has been accepted whole.
      // An unresolved finding aborts generate/reroll/export with DIRECTION_CHECK_FAILED, so the
      // orientation point lists them beside the acceptance instead of deferring to doctor. Characters
      // findings only become reportable once the direction is accepted (reportableDirectionFindings).
      const directionCheck = direction
        ? checkDirection(direction, {
            referenceAssetNames: reference?.exposedAssetNames ?? [],
            animaticSetups: await loadAnimaticSetupState(videoRoot, direction),
            stagingStage: await loadStagingStageState(videoRoot, direction),
          })
        : null;
      const reportedFindings = directionCheck
        ? reportableDirectionFindings(directionCheck.active, acceptanceView?.gateSatisfied ?? false)
        : [];
      const directionFindings = reportedFindings.map((f) => ({
        key: directionWaiverKey(f),
        class: classifyDirectionFinding(f.code),
        message: f.message,
      }));
      // Structural errors abort generate outright and are not waivable, so they get their own block
      // rather than folding into the findings list. `empty-direction` means "not started", which
      // `directionEmpty` below already carries as a next step, not an error.
      const directionStructureErrors = directionCheck
        ? directionCheck.structureErrors
            .filter((e) => e.code !== "empty-direction")
            .map((e) => ({ code: e.code, message: e.message }))
        : [];
      const directionStaleWaivers = directionCheck
        ? directionCheck.staleWaivers.map((w) => ({ key: w.key, reason: w.reason }))
        : [];

      // The two stage-file gates' twin of the block above: each aborts every spend on its stage.
      // Per stage, since each folds against its own `waivers`.
      const promptFindings: PromptFindingLine[] = [];
      const promptStaleWaivers: PromptStaleWaiverLine[] = [];
      const pinFindings: PinFindingLine[] = [];
      const pinStaleWaivers: PinStaleWaiverLine[] = [];
      const promptBlockedStages: Array<{ stage: string; where: string }> = [];
      const collectStageChecks = (
        where: string,
        subject: PromptCheckSubject & PinCheckSubject,
      ): boolean => {
        const result = checkPrompts(subject.prompts ?? [], subject.waivers ?? {});
        for (const finding of result.active) {
          promptFindings.push({ key: finding.key, where, detail: formatPromptFinding(finding) });
        }
        for (const waiver of result.staleWaivers) {
          promptStaleWaivers.push({ key: waiver.key, where, reason: waiver.reason });
        }
        // Reported over the whole waiver namespace, so a mistyped pin key surfaces here too.
        for (const key of result.unknownWaivers) {
          promptStaleWaivers.push({ key, where, reason: "", unknown: true });
        }
        const pinResult = checkPins(subject.pins ?? [], subject.waivers ?? {});
        for (const finding of pinResult.active) {
          pinFindings.push({ key: finding.key, where, detail: formatPinFinding(finding) });
        }
        for (const waiver of pinResult.staleWaivers) {
          pinStaleWaivers.push({ key: waiver.key, where, reason: waiver.reason });
        }
        // An unknown key aborts the gate exactly as a finding does, so it blocks the same steps.
        return (
          result.active.length > 0 ||
          result.unknownWaivers.length > 0 ||
          pinResult.active.length > 0
        );
      };
      for (const [stage, def] of [
        ["reference", reference],
        ["animatic", animatic],
        ["video", video],
      ] as const) {
        if (!def) continue;
        const where = STAGE_ENTRY_FILE[stage];
        if (collectStageChecks(where, def)) promptBlockedStages.push({ stage, where });
      }
      // The cast gate: a character's look, plus every cast voice sample (the video stage's own
      // gate — surfaced here too, or Next steps would keep offering a `generate video` that aborts).
      // A `file` reference is satisfied by its media landing on disk, never by generating it, so
      // carry the declared path along for the step that says where to put it.
      const unacceptedCast = [
        ...(await unsatisfiedCharacters({ videoRoot, manager, direction, reference })).map((c) => ({
          id: c.id,
          blocks: "all" as const,
        })),
        ...(await unsatisfiedVoices({ videoRoot, manager, direction, reference })).map((v) => ({
          id: v.assetId,
          blocks: "video" as const,
        })),
      ]
        // A sample cast twice is still one asset to clear, so it is offered once.
        .filter((c, i, all) => all.findIndex((o) => o.id === c.id) === i)
        .map(({ id, blocks }) => {
          const entry = reference?.topLevelAssets?.[id];
          return { id, blocks, missingFile: entry?.kind === "file" ? entry.path : null };
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
      });

      // Would `generate <stage>` abort on ANIMATIC_/REFERENCE_ACCEPTANCE_REQUIRED right now?
      // Mirrors the gate's own target set — used assets that run would submit — so Next steps never
      // offers a spend the gate would refuse, nor withholds one it would allow.
      const upstreamReviewBlockedStages = (["animatic", "video"] as const).filter((stage) => {
        const def = stage === "video" ? video : animatic;
        if (graph === null || !def) return false;
        return (
          unacceptedUpstreamDeps({
            manager,
            graph,
            stage,
            assetPaths: listAssetPaths(def, stage).filter((assetPath) => {
              if (unusedPaths.has(assetPath)) return false;
              const assetDef = getAssetEntry(def, assetPath);
              return (
                assetDef.kind !== "file" &&
                !assetSkipReason(
                  manager,
                  assetPath,
                  computeDefinitionHash(assetDef),
                  assetDef.deterministic === true,
                )
              );
            }),
          }).size > 0
        );
      });

      // Feed Next steps the report's definition-aware "Needs review" and job-aware
      // "Problems" sets so it never suggests previewing a composition the section itself
      // excluded, nor cleaning a variant that is still generating (no file yet, no error).
      const pendingReviewAddresses = [...new Set(needsReviewItems(report).map((i) => i.address))];
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
      // Patch scripts are the second definition source a spend reaches, and `patch apply` gates
      // them on their own — so a correction whose delta names an exclusion, or which pins a frame
      // the picture never shows, is reported here too, and carried to Next steps as blocked, which
      // withholds `konte patch apply` for the whole set.
      const promptBlockedPatches = new Set(
        report.patchPrompts
          .filter((p) => collectStageChecks(p.file, { prompts: p.prompts, pins: p.pins }))
          .map((p) => p.sourceAddress),
      );

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
      for (const address of new Set(staleInfos.map((i) => i.address))) {
        (rebakesOnGenerate(address) ? deterministicStaleAddresses : staleAddresses).push(address);
      }
      // A target holding output whose review prerequisites are unwritten. It sits above "Needs
      // review" because it is what the review is waiting on: `konte preview <stage>` aborts with
      // REVIEW_PREREQUISITE_MISSING until every one of these is written.
      const unmetPrerequisites = findAllUnmetPrerequisites({ animatic }, state);
      if (unmetPrerequisites.length > 0) {
        const at = report.sections.findIndex((s) => s.title === "Needs review");
        report.sections.splice(at === -1 ? report.sections.length : at, 0, {
          title: "Needs authoring",
          items: unmetPrerequisites.map((u) => {
            const shot = prerequisiteShot(u);
            return {
              address: u.address,
              detail:
                `${shot ? `${shot}: ` : ""}has output but no ${u.missing.join(", no ")}` +
                ` — write it in ${u.writeIn}`,
            };
          }),
        });
      }

      // Above "Needs review": the fix is a retime, not a verdict.
      const animaticOverflows = findAnimaticOverflows(animatic, manager);
      if (animaticOverflows.length > 0) {
        const at = report.sections.findIndex((s) => s.title === "Needs review");
        report.sections.splice(at === -1 ? report.sections.length : at, 0, {
          title: "Needs retiming",
          // The address names the shot; the detail says only what the address cannot.
          items: animaticOverflows.map((o) => ({
            address: o.address,
            detail: formatAnimaticOverflow(o),
          })),
        });
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
        });
        if (staleness === "stale") continue;
        feedbackAddresses.add(address);
      }

      const suggestedActions = suggestForStatus({
        state,
        stalenessCache: readCache,
        feedbackAddresses: [...feedbackAddresses],
        unmetPrerequisites,
        animaticOverflows,
        pendingReviewAddresses,
        problemAddresses,
        failedJobVariantIds,
        // The whole list, blocked ones included: the bare `konte patch apply` takes every pending
        // patch, so what is offered depends on all of them, not on the appliable subset.
        pendingPatchAddresses,
        blockedPatchAddresses: [...promptBlockedPatches],
        staleAddresses,
        deterministicStaleAddresses,
        missingFilePaths,
        orphanJobIds: report.orphanJobIds,
        provisioningFailureJobIds: report.provisioningFailureJobIds,
        patchErrors: report.patchErrors,
        // Hand Next steps the report's own conclusions rather than leaving it to re-derive them
        // from `state`: only these see a never-generated asset (which has no state entry at all),
        // a job already in flight, and the gates that would abort the command being suggested.
        readiness: report.readiness,
        lastExports: report.lastExports,
        directionBlock:
          reportedFindings.length > 0 || directionStructureErrors.length > 0
            ? {
                findingCodes: reportedFindings.map((f) => f.code),
                hasStructureErrors: directionStructureErrors.length > 0,
              }
            : undefined,
        directionReviewNeeded,
        unacceptedCast,
        directionEmpty,
        upstreamReviewBlockedStages,
        promptBlockedStages,
      });

      if (videoName) console.log(`Video: ${videoName}\n`);
      printStatusReport(report, suggestedActions, {
        videoRoot,
        verbose: opts.verbose,
        directionAcceptance,
        directionEmpty,
        directionFindings,
        directionStructureErrors,
        directionStaleWaivers,
        promptFindings,
        promptStaleWaivers,
        pinFindings,
        pinStaleWaivers,
      });
    });
}
