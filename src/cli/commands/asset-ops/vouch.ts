import type { Command } from "commander";
import { StateManager } from "../../../core/state/index.js";
import { requireVideoRoot } from "../../context.js";

export function registerVouchCommand(program: Command): void {
  program
    .command("vouch <variantIds...>")
    .description("Vouch for a take past a variant finding, letting its stage's review open")
    .addHelpText(
      "after",
      `
The variant check runs on each take as it lands and finds one silent, or heard to drop or
change the words it owes. A finding holds its stage's review (\`konte preview <stage>\` refuses)
until the take is dismissed, or vouched for here — a reroll draws another beside it and leaves
the finding standing. Vouch for a take only once the
finding is konte's mistake — \`konte probe audio <variantId>\` shows the line beside what was heard,
and a kanji heard for a kana spelling or a name spelled another way is not a wrong take.

Examples:
  konte vouch v-abc123            Let the review show that take
  konte vouch v-abc123 v-def456   Vouch for several at once`,
    )
    .action(async (variantIds: string[]) => {
      const videoRoot = requireVideoRoot();
      const vouched = await StateManager.withLock(videoRoot, async (manager) =>
        variantIds.map((variantId) => {
          const address = manager.resolveVariantAddress(variantId);
          return { address, variantId, moved: manager.setVouched(address, variantId) };
        }),
      );
      for (const { address, variantId, moved } of vouched) {
        console.log(`${moved ? "Vouched" : "Already vouched"}: ${address} → ${variantId}`);
      }
    });
}
