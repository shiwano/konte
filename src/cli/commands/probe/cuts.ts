import * as path from "node:path";
import type { Command } from "commander";
import { isDraftTakeAddress, tryParseAddress } from "../../../core/address.js";
import { readDraftCuts } from "../../../core/draft-cuts.js";
import { KonteError } from "../../../core/errors.js";
import { ensureFfmpeg } from "../../../core/ffmpeg.js";
import { ffprobeBin } from "../../../core/ffmpeg-binary.js";
import { loadMotionWaveform, renderMotionStrip } from "../../../core/motion-inspect.js";
import { detectSceneChanges, frameInterval } from "../../../core/thumbnail.js";
import { parseNumberOption } from "../../parse-option.js";
import { openProbeTargets } from "./resolve-arg.js";
import { formatSeconds } from "../../../core/format-duration.js";

const MAX_SHEET_FRAMES = 64;

export function registerProbeCutsCommand(program: Command): void {
  program
    .command("cuts <variantOrScope...>")
    .description("Read where a draft take cuts, beside the direction's cut times")
    .option("--threshold <n>", "Scene detection threshold (0.0-1.0)", "0.25")
    .option("--step <sec>", "Seconds between the sheet's frames", "0.25")
    .addHelpText(
      "after",
      `
Takes a draft take's address (animatic:draft.<name>), its variant id (v-…), or the scope
animatic:draft for every draft. For each shot the take covers it prints the second the
direction's clock cuts into it and the detected cut read as that one, then the detections
left over, then the path of a contact sheet with the time burned into every frame.

A take cuts up to half a second either side of the stated time, and a large move inside a
shot is detected as a cut, so the numbers are candidates: read the sheet, then write the
\`at\` of each frame("<id>", …) in animatic.tsx. A shot may open with nobody in frame — pick
the frame the panel is to be drawn from, not the cut.

Examples:
  konte probe cuts animatic:draft.opening   One draft take's cuts and its sheet
  konte probe cuts animatic:draft           Every draft take
  konte probe cuts v-iuQeCrR2 --step 0.5    A coarser sheet of one take`,
    )
    .action(async (targets: string[], opts: { threshold: string; step: string }) => {
      const threshold = parseNumberOption("--threshold", opts.threshold, { min: 0, max: 1 })!;
      const step = parseNumberOption("--step", opts.step, { min: 0.01 })!;
      const opened = await openProbeTargets(targets, { mediaKinds: ["video"], definitions: true });
      const { videoRoot, manager } = opened;
      const animatic = opened.definitions?.animatic ?? null;

      await ensureFfmpeg();
      await ffprobeBin();

      // A scope sweeps in the cut of the take before, which is no take to read cuts off. A target
      // named outright is refused below instead.
      const swept = new Set(opened.resolved.filter((t) => t.scope).map((t) => t.variantId));
      const takes = opened.variantIds
        .map((variantId) => ({ variantId, address: manager.resolveVariantAddress(variantId) }))
        .filter((take) => !swept.has(take.variantId) || isDraftTakeAddress(take.address));

      for (const [i, { variantId, address }] of takes.entries()) {
        const name = tryParseAddress(address)?.assetName ?? "";
        const shotIds = isDraftTakeAddress(address) ? animatic?.draftShots?.[name] : undefined;
        if (!animatic || !shotIds) {
          throw new KonteError(
            "INVALID_ADDRESS",
            `"${address}" is not a draft take animatic.tsx declares — probe cuts reads ` +
              `animatic:draft.<name>`,
          );
        }
        const shots = shotIds.map((id) => ({
          id,
          duration: animatic.shots.find((s) => s.id === id)?.duration ?? 0,
        }));

        const waveform = await loadMotionWaveform({ manager, videoRoot, variantId });
        const file = path.resolve(videoRoot, waveform.file);
        const duration = waveform.durationSec ?? 0;
        const detections = await detectSceneChanges(
          file,
          threshold,
          frameInterval(waveform.nativeFps),
        );
        const { cuts, unmatched } = readDraftCuts(shots, detections);
        const strip = await renderMotionStrip({
          videoRoot,
          waveform,
          spec: {
            full: true,
            frames: Math.min(MAX_SHEET_FRAMES, Math.max(2, Math.ceil(duration / step) + 1)),
          },
        });

        if (i > 0) console.log("");
        console.log(`${address}   ${variantId}   ${formatSeconds(duration, 2)}`);
        console.log("  shot  direction  detected");
        for (const cut of cuts) {
          const detected =
            cut.expected === 0 && cut.detected === null
              ? "(take head)"
              : cut.detected === null
                ? "— none near it"
                : `${formatSeconds(cut.detected, 2)} (${cut.detected >= cut.expected ? "+" : ""}${formatSeconds(
                    cut.detected - cut.expected,
                    2,
                  )})`;
          console.log(
            `  ${cut.shotId.padEnd(4)}  ${formatSeconds(cut.expected, 2).padEnd(9)}  ${detected}`,
          );
        }
        if (unmatched.length > 0) {
          console.log(
            `  other detections: ${unmatched.map((t) => formatSeconds(t, 2)).join(", ")} — a large ` +
              `move inside a shot reads as a cut`,
          );
        }
        console.log(`  sheet  ${strip.path}`);
      }

      console.log("\nNext steps:");
      console.log(
        '  Read each sheet, then write `at` in every frame("<id>", …) drawn from that take — the ' +
          "detected times are candidates, and `konte generate animatic` cuts the frames",
      );
    });
}
