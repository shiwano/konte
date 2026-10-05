import type { Command } from "commander";
import { KonteError } from "../../core/errors.js";
import { JobManager } from "../../core/job-manager.js";
import { lyricLines } from "../../core/direction.js";
import { placeDirectionLyrics } from "../../core/dsl/direction.js";
import { syncFileAssets } from "../../core/file-sync.js";
import { unreadSongTakes } from "../../core/song-queue.js";
import {
  currentSongTake,
  setSongFirstBeat,
  setSongLine,
  songAddressOf,
  songBeatSec,
} from "../../core/song-take.js";
import { runSongAnalysisJob } from "../../backends/run-song-analysis-job.js";
import { printLyrics, printSongReading } from "./probe/audio.js";
import { StateManager } from "../../core/state/index.js";
import { songAnalysisOf } from "../../core/song-reading.js";
import type { SongAnalysis, SongRecord, VariantState } from "../../core/types/index.js";
import { requireVideoRoot } from "../context.js";
import { loadDirectionIfPresent } from "../load-definition.js";
import { loadReference } from "../../core/loader.js";

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
    .description("Correct which beat is the first bar head, or where a lyric line falls")
    .option(
      "--first-beat [sec]",
      "Make the read beat nearest this take-second beat 0, the first bar head the first shot counts from",
    )
    .option("--line <key>", "The lyric line to place, as `<section>.<line>` from 1")
    .option("--start <sec>", "With --line: the take-second the line opens at")
    .option("--end <sec>", "With --line: the take-second the line ends at")
    .option("--unset", "With --first-beat or --line: leave it to the reading again")
    .addHelpText(
      "after",
      `
Overwrite what konte read off one take of the song \`policy.song\` names.

--first-beat makes a read beat beat 0: the bar heads count from it, and the first shot's beats begin
there; the first shot holds what plays before it. Every shot's seconds move with it. The beats
themselves, the meter, the section candidates and the sung stretches stay as read.

--line places one lyric line on the take by hand — one the reading left unplaced
(\`lyric-unplaced\`) or placed wrong. It lives on the take: another take reads its lines again,
and so does a line whose words change. Lines open in the order they are sung.

Check the take with \`konte probe audio <variantId>\` or on the song's review page first.

Examples:
  konte song set v-abc123 --first-beat 2.5                   The first bar head is the beat at 2.5s
  konte song set v-abc123 --first-beat --unset               Leave beat 0 to the reading
  konte song set v-abc123 --line 2.1 --start 16.4 --end 19.8  Line 1 of section 2 is sung there
  konte song set v-abc123 --line 2.1 --unset                 Leave line 2.1 to the reading`,
    )
    .action(
      async (
        variantId: string,
        opts: {
          firstBeat?: string | true;
          line?: string;
          start?: string;
          end?: string;
          unset?: boolean;
        },
      ) => {
        const videoRoot = requireVideoRoot();
        if ((opts.firstBeat === undefined) === (opts.line === undefined)) {
          throw new KonteError("INVALID_OPTION", "pass one of --first-beat or --line");
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
          if ((opts.unset === true) === (opts.start !== undefined || opts.end !== undefined)) {
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
        const unset = opts.unset === true;
        if (unset !== (opts.firstBeat === true)) {
          throw new KonteError("INVALID_OPTION", "--first-beat takes a take-second, or --unset");
        }
        const at = unset ? null : seconds("--first-beat", opts.firstBeat as string);
        const { address, before, after } = await StateManager.withLock(
          videoRoot,
          async (manager) => {
            const { address, variant, record, analysis } = readSongVariant(manager, variantId);
            const durationSec = takeDurationSec(variant);
            if (at !== null && at >= durationSec) {
              throw new KonteError(
                "INVALID_OPTION",
                `--first-beat ${at} is past the end of the ${durationSec}s take`,
              );
            }
            const before = songBeatSec(analysis, 0);
            variant.song = setSongFirstBeat(record, analysis, at);
            const moved = songAnalysisOf(manager.videoRoot, address, variantId, variant.song)!;
            return { address, before, after: songBeatSec(moved, 0) };
          },
        );
        const sec = (n: number) => `${Math.round(n * 1000) / 1000}s`;
        console.log(
          `Beat 0 of ${address} ${variantId}: ${sec(before)} → ${sec(after)}` +
            (at === null ? ", as read" : ""),
        );
        console.log(`\nNext steps:\n  konte probe audio ${variantId}`);
      },
    );

  song
    .command("analyze")
    .description("Read the song's takes now, and wait for the reading")
    .addHelpText(
      "after",
      `
Read the song \`policy.song\` names — its beats, meter, section candidates and sung
stretches — and wait for it. It reads the song's current take (the accepted one, else the
newest) again, and every other take not read yet: a song placed as a file, a reading that
failed, one read against another language. A beat 0 or a line set by hand (\`konte song set\`)
stays where it was set. The first run downloads the beat tracker and the vocal separator.

A generated take is read on its own when it lands; this is the way in for any other.

Examples:
  konte song analyze   Read the song's takes`,
    )
    .action(async () => {
      const videoRoot = requireVideoRoot();
      const direction = await loadDirectionIfPresent(videoRoot);
      const songAddress = songAddressOf(direction);
      if (!direction || !songAddress) {
        throw new KonteError(
          "VALIDATION_FAILED",
          "direction.ts declares no policy.song, so there is no song to read",
        );
      }
      // The reference alone: the song is one of its assets, and a board or video cut to the song
      // cannot load before a take of it is read.
      const reference = await loadReference(videoRoot);
      const targets = await StateManager.withLock(videoRoot, async (manager) => {
        await syncFileAssets({ reference }, manager, { measure: true });
        const state = manager.getState();
        const current = currentSongTake(state, songAddress);
        const unread = unreadSongTakes(videoRoot, direction, state);
        const ids = [
          ...new Set([...(current ? [current] : []), ...unread.map((t) => t.variantId)]),
        ];
        return ids.map((variantId) => ({
          variantId,
          outputHash: state.assets[songAddress]!.variants![variantId]!.outputHash ?? null,
        }));
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
        printSongReading(song);
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
