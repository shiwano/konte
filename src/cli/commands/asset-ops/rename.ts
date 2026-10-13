import type { Command } from "commander";
import {
  getAssetEntryByAddress,
  isCompositionAddress,
  isOverlayAddress,
  isStemAddress,
  parseAddress,
  patchSourceVariantIdOf,
} from "../../../core/address.js";
import {
  carryDefinitionHashes,
  carryPatchHashes,
  createFileMover,
  createHashCarrier,
  moveAssetDirs,
  renameJob,
  renameMoves,
} from "../../../core/asset-rename.js";
import {
  applyResolutionDefinitions,
  definitionForAddress,
} from "../../../core/definition-hashes.js";
import { KonteError } from "../../../core/errors.js";
import { FeedbackManager } from "../../../core/feedback/index.js";
import { isJobTerminal, JobManager } from "../../../core/job-manager.js";
import { StateManager } from "../../../core/state/index.js";
import { requireVideoRoot } from "../../context.js";
import { loadStageDefinitions } from "../../load-definition.js";

const FEEDBACK_STAGES = ["reference", "animatic", "video"] as const;

function assertRenamable(address: string): void {
  if (isCompositionAddress(address) || isStemAddress(address) || isOverlayAddress(address)) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `"${address}" is a materialized leaf; only a generated asset is renamed`,
    );
  }
  const parsed = parseAddress(address);
  if (parsed.kind === "patch" || parsed.delivery) {
    throw new KonteError(
      "INVALID_ADDRESS",
      parsed.kind === "patch"
        ? `"${address}" is a patch step; it moves with its source take`
        : `"${address}" is a delivery derivative; it moves with its source address`,
    );
  }
}

export function registerRenameCommand(program: Command): void {
  program
    .command("rename <from> <to>")
    .description("Move an asset's takes, accept and comments to the name it was renamed to")
    .addHelpText(
      "after",
      `
Rename the asset in its stage file first, then move what konte holds under the old
address to the new one: every take with its files, its accept, its #delivery
derivative and the comments on it. A take that consumes the asset was made against
the old name; where the rename is all that changed in its definition, it stays
current rather than turning definition-stale.

Both addresses are generated assets of one stage. <to> must be declared and hold no
takes; no job may still be making a take at <from>, and no export may be running.

Examples:
  konte rename animatic:plate.counterClose animatic:plate.counterReverse
  konte rename video:shot.03.motion video:shot.03.walkIn`,
    )
    .action(async (from: string, to: string) => {
      const videoRoot = requireVideoRoot();
      assertRenamable(from);
      assertRenamable(to);
      if (from === to) {
        throw new KonteError("INVALID_ADDRESS", `"${from}" and "${to}" are the same address`);
      }
      if (parseAddress(from).stage !== parseAddress(to).stage) {
        throw new KonteError(
          "INVALID_ADDRESS",
          `"${from}" and "${to}" are in different stages; a take moves only within its stage`,
        );
      }

      const definitions = await loadStageDefinitions(videoRoot);
      const definition = definitionForAddress(definitions, to);
      if (!definition && definitions.video === null && parseAddress(to).stage !== "reference") {
        throw definitions.songUnread;
      }
      try {
        if (!definition) throw new Error();
        getAssetEntryByAddress(definition, to);
      } catch {
        throw new KonteError(
          "ADDRESS_NOT_FOUND",
          `"${to}" is not declared — rename the asset in its stage file first`,
        );
      }

      const moves = renameMoves(from, to);
      const jobs = await new JobManager(videoRoot).listJobs();
      const takesAtFrom = new Set(
        Object.keys(
          (await StateManager.load(videoRoot)).getRecordedState().assets[from]?.variants ?? {},
        ),
      );
      // An export reads files from every take its render plan resolved, which its job does not list.
      // A patch chain's step finalizes against its source take wherever the step sits.
      const active = jobs.find(
        (job) =>
          !isJobTerminal(job.status) &&
          (job.kind === "export" ||
            (job.kind === "song-analysis" && moves.has(job.address)) ||
            (job.kind === "generation" &&
              ([job.address, ...job.dependsOnAssets].some((address) => moves.has(address)) ||
                takesAtFrom.has(patchSourceVariantIdOf(job.address) ?? "")))),
      );
      if (active) {
        throw new KonteError(
          "RENAME_JOB_ACTIVE",
          `Job ${active.id} is still ${active.status} — konte job wait ${active.id}, then rename`,
        );
      }

      const moveFile = createFileMover(moves);
      const moved = await StateManager.withLock(videoRoot, async (manager) => {
        const recorded = manager.getRecordedState();
        const takes = Object.keys(recorded.assets[from]?.variants ?? {});
        if (takes.length === 0) {
          throw new KonteError("ASSET_NOT_FOUND", `"${from}" holds no takes`);
        }
        for (const target of moves.values()) {
          if (Object.keys(recorded.assets[target]?.variants ?? {}).length > 0) {
            throw new KonteError(
              "RENAME_TARGET_TAKEN",
              `"${target}" already holds takes — konte clean ${target} to drop them first`,
            );
          }
        }
        const undoMove = await moveAssetDirs(videoRoot, moves);
        try {
          manager.renameAddresses(moves, moveFile);
          const patches = await carryPatchHashes(videoRoot, manager.getRecordedState(), moves);
          await manager.save();
          return { takes, accepted: manager.getAcceptedVariant(to), patches };
        } catch (err) {
          // A save that wrote the state and then failed has committed the move.
          const committed = await StateManager.load(videoRoot)
            .then((m) => m.getRecordedState().assets[to]?.variants?.[takes[0]!] !== undefined)
            .catch(() => false);
          if (!committed) await undoMove();
          throw err;
        }
      });

      const jobManager = new JobManager(videoRoot);
      for (const job of jobs) {
        const renamed = renameJob(job, moves, moveFile);
        if (renamed) await jobManager.putJob(renamed);
      }

      // Read again: a board cut to the song being renamed reads only once the song's take is there.
      const current = await loadStageDefinitions(videoRoot);
      await applyResolutionDefinitions({ videoRoot, definitions: current });
      const carry = createHashCarrier(current, moves);
      const carried = await StateManager.withLock(videoRoot, async (manager) =>
        carryDefinitionHashes(videoRoot, manager.getRecordedState(), carry, moves),
      );
      for (const stage of FEEDBACK_STAGES) {
        const peek = await FeedbackManager.load(videoRoot, stage);
        if (!peek.renameAddresses(moves, carry)) continue;
        await FeedbackManager.withLock(videoRoot, stage, async (manager) => {
          manager.renameAddresses(moves, carry);
        });
      }

      console.log(
        `Renamed: ${from} → ${to} (${moved.takes.length} take(s)${moved.accepted ? `, accepted ${moved.accepted}` : ""})`,
      );
      for (const address of [...carried, ...moved.patches]) {
        console.log(`  ${address}: still current under the new name`);
      }
    });
}
