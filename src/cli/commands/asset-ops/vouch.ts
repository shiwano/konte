import type { Command } from "commander";
import { parseShotAddress } from "../../../core/address.js";
import { findAnimaticSilentTails, type SilentTail } from "../../../core/animatic-overflow.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { KonteError } from "../../../core/errors.js";
import { formatSeconds } from "../../../core/format-duration.js";
import { loadAnimatic } from "../../../core/loader.js";
import { StateManager } from "../../../core/state/index.js";
import type { AnimaticDefinition } from "../../../core/types/index.js";
import { requireVideoRoot } from "../../context.js";

export function registerVouchCommand(program: Command): void {
  program
    .command("vouch <targets...>")
    .description(
      "Vouch for a take or a shot's silent tail past its finding, letting its review open",
    )
    .addHelpText(
      "after",
      `
The variant check runs on each take as it lands and finds one silent, or heard to drop or
change the words it owes. A finding holds its stage's review (\`konte preview <stage>\` refuses)
until the take is dismissed, or vouched for here — a reroll draws another beside it and leaves
the finding standing. Vouch for a take only once the
finding is konte's mistake — \`konte probe audio <variantId>\` shows the line beside what was heard,
and a kanji heard for a kana spelling or a name spelled another way is not a wrong take.

An animatic shot with lines that goes quiet long before its cut (tail-silent) holds the review
the same way. Vouch for it by its address when the picture needs the hold; the vouch lapses
once its duration, its cues, the takes they play or the beds over it change.

Examples:
  konte vouch v-abc123            Let the review show that take
  konte vouch v-abc123 v-def456   Vouch for several at once
  konte vouch animatic:shot.29    Keep shot 29's silent tail as a hold`,
    )
    .action(async (targets: string[]) => {
      const videoRoot = requireVideoRoot();
      const shotTargets = targets.filter((t) => parseShotAddress(t) !== null);
      for (const target of shotTargets) {
        if (parseShotAddress(target)!.stage !== "animatic") {
          throw new KonteError(
            "INVALID_ADDRESS",
            `"${target}" — a silent tail is vouched for on an animatic shot (animatic:shot.<id>)`,
          );
        }
      }
      const animatic =
        shotTargets.length > 0
          ? ((await applyResolutionDefinitions({ videoRoot })).animatic ??
            (await loadAnimatic(videoRoot)))
          : null;

      const lines = await StateManager.withLock(videoRoot, async (manager) => {
        const tails = animatic ? findAnimaticSilentTails(animatic, manager) : [];
        const shots = shotTargets.map((address) => shotTail(animatic!, tails, address));
        const out: string[] = [];
        for (const target of targets) {
          const tail = shots.find((t) => t.address === target);
          if (tail) {
            const moved = manager.setShotVouched(target, tail.tailHash);
            out.push(
              `${moved ? "Vouched" : "Already vouched"}: ${target} — ` +
                `${formatSeconds(tail.tailSec)} silent tail held`,
            );
            continue;
          }
          const address = manager.resolveVariantAddress(target);
          const moved = manager.setVouched(address, target);
          out.push(`${moved ? "Vouched" : "Already vouched"}: ${address} → ${target}`);
        }
        return out;
      });
      for (const line of lines) console.log(line);
    });
}

function shotTail(
  animatic: AnimaticDefinition,
  tails: readonly SilentTail[],
  address: string,
): SilentTail {
  const { shotId } = parseShotAddress(address)!;
  if (!animatic.shots.some((s) => s.id === shotId)) {
    throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" not found`);
  }
  const tail = tails.find((t) => t.address === address);
  if (!tail) {
    throw new KonteError("TAIL_NOT_SILENT", `${address} has no tail-silent finding to vouch for`);
  }
  return tail;
}
