import type { Command } from "commander";
import { KonteError } from "../../core/errors.js";
import { JobManager } from "../../core/job-manager.js";
import { lyricLines } from "../../core/direction.js";
import { placeDirectionLyrics } from "../../core/dsl/direction.js";
import { syncFileAssets } from "../../core/file-sync.js";
import { unreadSongTakes } from "../../core/song-queue.js";
import {
  currentSongTake,
  setSongLine,
  songAddressOf,
  songDownbeatSec,
} from "../../core/song-take.js";
import { runSongAnalysisJob } from "../../backends/run-song-analysis-job.js";
import { printLyrics, printSongReading } from "./probe/audio.js";
import { StateManager } from "../../core/state/index.js";
import { songAnalysisOf } from "../../core/song-reading.js";
import type { SongAnalysis, SongRecord, VariantState } from "../../core/types/index.js";
import { requireVideoRoot } from "../context.js";
import { loadDirectionIfPresent, loadStageDefinitions } from "../load-definition.js";

function readSongVariant(
  manager: StateManager,
  variantId: string,
): { address: string; variant: VariantState; record: SongRecord; analysis: SongAnalysis } {
  const address = manager.resolveVariantAddress(variantId);
  const variant = manager.getState().assets[address]!.variants![variantId]!;
  const analysis = songAnalysisOf(manager.videoRoot, address, variantId, variant.song);
  if (!variant.song || !analysis) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${address} ${variantId} has not been read as the song yet — run \`konte song analyze\``,
    );
  }
  return { address, variant, record: variant.song, analysis };
}

function takeDurationSec(variant: VariantState): number {
  return variant.media && variant.media.kind !== "image" ? variant.media.durationSec : Infinity;
}

export function registerSongCommand(program: Command): void {
  const song = program
    .command("song")
    .description("Correct or re-read what konte read off a take of the song");

  song
    .command("set <variantId>")
    .description("Correct where the first bar head or a lyric line falls in a take of the song")
    .option(
      "--downbeat <sec>",
      "The take-second of the first bar head, where the first shot's beats begin",
    )
    .option("--line <key>", "The lyric line to place, as `<section>.<line>` from 1")
    .option("--start <sec>", "With --line: the take-second the line opens at")
    .option("--end <sec>", "With --line: the take-second the line ends at")
    .option("--unset", "With --line: leave the line to the reading again")
    .addHelpText(
      "after",
      `
Overwrite what konte read off one take of the song \`policy.clock\` counts on.

--downbeat is the take-second the first shot's beats begin at; the first shot holds what plays
before it. The tempo, the section candidates and the sung stretches stay as read.

--line places one lyric line on the take by hand — one the reading left unplaced
(\`lyric-unplaced\`) or placed wrong. It lives on the take: another take reads its lines again,
and so does a line whose words change. Lines open in the order they are sung.

Check the take with \`konte probe audio <variantId>\` or on the song's review page first.

Examples:
  konte song set v-abc123 --downbeat 0.5                     The first bar head is half a second in
  konte song set v-abc123 --line 2.1 --start 16.4 --end 19.8  Line 1 of section 2 is sung there
  konte song set v-abc123 --line 2.1 --unset                 Leave line 2.1 to the reading`,
    )
    .action(
      async (
        variantId: string,
        opts: { downbeat?: string; line?: string; start?: string; end?: string; unset?: boolean },
      ) => {
        const videoRoot = requireVideoRoot();
        if ((opts.downbeat === undefined) === (opts.line === undefined)) {
          throw new KonteError("INVALID_OPTION", "pass one of --downbeat or --line");
        }
        const seconds = (flag: string, value: string | undefined): number => {
          const sec = Number(value);
          if (value === undefined || !Number.isFinite(sec) || sec < 0) {
            throw new KonteError(
              "INVALID_OPTION",
              `${flag} takes a take-second at or after 0, got "${value ?? ""}"`,
            );
          }
          return sec;
        };
        if (opts.line !== undefined) {
          const key = opts.line;
          if (opts.unset === (opts.start !== undefined || opts.end !== undefined)) {
            throw new KonteError("INVALID_OPTION", "--line takes --start and --end, or --unset");
          }
          const span = opts.unset
            ? null
            : { startSec: seconds("--start", opts.start), endSec: seconds("--end", opts.end) };
          const direction = await loadDirectionIfPresent(videoRoot);
          const lines = direction ? lyricLines(direction) : [];
          const address = await StateManager.withLock(videoRoot, async (manager) => {
            const { address, variant, record } = readSongVariant(manager, variantId);
            variant.song = setSongLine(record, lines, key, span, takeDurationSec(variant));
            return address;
          });
          console.log(
            span
              ? `Line ${key} of ${address} ${variantId}: ${span.startSec}s–${span.endSec}s`
              : `Line ${key} of ${address} ${variantId}: left to the reading`,
          );
          console.log(`\nNext steps:\n  konte probe audio ${variantId}`);
          return;
        }
        const downbeat = seconds("--downbeat", opts.downbeat);
        const { address, before } = await StateManager.withLock(videoRoot, async (manager) => {
          const { address, variant, record, analysis } = readSongVariant(manager, variantId);
          const durationSec = takeDurationSec(variant);
          if (downbeat >= durationSec) {
            throw new KonteError(
              "INVALID_OPTION",
              `--downbeat ${downbeat} is past the end of the ${durationSec}s take`,
            );
          }
          const before = songDownbeatSec(analysis);
          variant.song = { ...record, downbeatSet: downbeat };
          return { address, before };
        });
        console.log(`Downbeat of ${address} ${variantId}: ${before}s → ${downbeat}s`);
        console.log(`\nNext steps:\n  konte probe audio ${variantId}`);
      },
    );

  song
    .command("analyze")
    .description("Read the song's takes now, and wait for the reading")
    .addHelpText(
      "after",
      `
Read the song \`policy.clock\` counts on — its tempo, bar heads, section candidates and
sung stretches — and wait for it. It reads the song's current take (the accepted one,
else the newest) again, replacing what was read, a corrected downbeat and placed lines included, and
every other take not read yet: a song placed as a file, a reading that failed, one
read against another tempo or meter. The first run downloads the vocal separator.

A generated take is read on its own when it lands; this is the way in for any other.

Examples:
  konte song analyze   Read the song's takes`,
    )
    .action(async () => {
      const videoRoot = requireVideoRoot();
      const direction = await loadDirectionIfPresent(videoRoot);
      const clock = direction?.policy?.clock;
      const songAddress = songAddressOf(direction);
      if (!direction || !clock || !songAddress) {
        throw new KonteError(
          "VALIDATION_FAILED",
          "direction.ts declares no policy.clock, so there is no song to read",
        );
      }
      const { reference, animatic, video } = await loadStageDefinitions(videoRoot);
      const targets = await StateManager.withLock(videoRoot, async (manager) => {
        await syncFileAssets({ reference, animatic, video }, manager, { measure: true });
        const state = manager.getState();
        const current = currentSongTake(state, songAddress);
        const unread = unreadSongTakes(videoRoot, direction, state);
        const ids = [
          ...new Set([...(current ? [current] : []), ...unread.map((t) => t.variantId)]),
        ];
        return ids.map((variantId) => {
          const variant = state.assets[songAddress]!.variants![variantId]!;
          const setBefore = variant.song?.downbeatSet ?? null;
          const linesSetBefore = Object.keys(variant.song?.lines ?? {});
          delete variant.song;
          return { variantId, outputHash: variant.outputHash ?? null, setBefore, linesSetBefore };
        });
      });
      if (targets.length === 0) {
        throw new KonteError(
          "VALIDATION_FAILED",
          `${songAddress} has no take to read — generate it (\`konte generate reference\`), or ` +
            "place its file where reference.tsx points",
        );
      }

      const jobManager = new JobManager(videoRoot);
      let failed = false;
      for (const target of targets) {
        const job = await jobManager.ensureSongAnalysisJob({
          address: songAddress,
          variantId: target.variantId,
          outputHash: target.outputHash,
          bpm: clock.bpm,
          beatsPerBar: clock.beatsPerBar,
          lang: direction.policy.lang,
          again: true,
        });
        console.log(`Reading ${songAddress} ${target.variantId}...`);
        // Another process (the MCP daemon) may hold the run: keep asking for it until it settles, so
        // a run whose holder died is taken over once its lease lapses.
        let settled = await jobManager.getJob(job.id);
        for (;;) {
          await runSongAnalysisJob(jobManager, videoRoot, job.id);
          settled = await jobManager.getJob(job.id);
          if (settled.status !== "pending" && settled.status !== "running") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        const song = songAnalysisOf(
          videoRoot,
          songAddress,
          target.variantId,
          (await StateManager.load(videoRoot)).getState().assets[songAddress]?.variants?.[
            target.variantId
          ]?.song,
        );
        if (settled.status !== "completed" || !song) {
          failed = true;
          console.log(
            `  failed    ${settled.error ?? settled.status} — see \`konte job logs ${job.id}\``,
          );
          continue;
        }
        if (target.setBefore !== null && target.setBefore !== song.downbeatSec) {
          console.log(
            `  downbeat  set by hand at ${target.setBefore}s, read again at ${song.downbeatSec}s`,
          );
        }
        if (target.linesSetBefore.length > 0) {
          console.log(
            `  lines     placed by hand, read again: ${target.linesSetBefore.join(", ")}`,
          );
        }
        printSongReading(song, clock);
        if (direction.lyrics) {
          printLyrics(
            placeDirectionLyrics(direction, {
              address: songAddress,
              variantId: target.variantId,
              analysis: song,
            }),
          );
        }
      }
      if (failed) process.exitCode = 1;
      console.log(`\nNext steps:\n  konte preview reference\n  konte probe audio ${songAddress}`);
    });
}
