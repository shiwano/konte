import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { feedbackStaleness, findFeedback } from "../../../core/feedback/index.js";
import { formatTimestamp } from "../../../core/format-timestamp.js";
import { loadFeedbackStaleContext } from "./stale-context.js";
import { requireVideoRoot } from "../../context.js";

export function registerFeedbackShowCommand(program: Command): void {
  program
    .command("show <feedbackId>")
    .description("Show feedback details")
    .action(async (feedbackId: string) => {
      const videoRoot = requireVideoRoot();
      const found = await findFeedback(videoRoot, feedbackId);
      if (!found) {
        throw new KonteError("FEEDBACK_NOT_FOUND", `Feedback "${feedbackId}" not found`);
      }
      const { address, entry } = found;
      const { state, ctx } = await loadFeedbackStaleContext(videoRoot);
      const staleness = feedbackStaleness(entry, address, state, ctx);

      console.log(`Address:     ${address}`);
      console.log(`ID:          ${entry.id}`);
      console.log(`Text:        ${entry.text}`);
      console.log(
        `Stale:       ${staleness === "unknown" ? "unknown" : staleness === "stale" ? "yes" : "no"}`,
      );
      const snapshotEntries = Object.entries(entry.displayedVariants ?? {});
      if (snapshotEntries.length === 0) {
        console.log(`Variants:    -`);
      } else {
        const addrWidth = Math.max(...snapshotEntries.map(([addr]) => addr.length));
        snapshotEntries.forEach(([addr, vid], i) => {
          const label = i === 0 ? "Variants:   " : "            ";
          console.log(`${label} ${addr.padEnd(addrWidth)}  ${vid}`);
        });
      }
      const defHashEntries = Object.entries(entry.displayedDefinitionHashes ?? {});
      if (defHashEntries.length > 0) {
        const addrWidth = Math.max(...defHashEntries.map(([addr]) => addr.length));
        defHashEntries.forEach(([addr, hash], i) => {
          const label = i === 0 ? "Def hashes: " : "            ";
          console.log(`${label} ${addr.padEnd(addrWidth)}  ${hash}`);
        });
      }
      if (entry.annotation) {
        console.log(`Annotation:  ${JSON.stringify(entry.annotation)}`);
      }
      if (entry.time !== undefined) {
        const local =
          entry.shotTime !== undefined ? ` (shot-local: ${entry.shotTime.toFixed(1)}s)` : "";
        console.log(`Time:        ${entry.time}s${local}`);
      }
      console.log(`Created:     ${formatTimestamp(entry.createdAt)}`);
      console.log(`Created by:  ${entry.createdBy}`);
    });
}
