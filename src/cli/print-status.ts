import * as path from "node:path";
import { formatReferenceAddress } from "../core/address.js";
import { formatRelativeTime } from "../core/format-timestamp.js";
import { capList, moreLine } from "./format-list.js";
import { type SuggestedAction, formatSuggestedActions } from "../core/suggested-actions.js";
import { formatStaleWaiverLine, type StaleWaiverLine } from "../core/checks.js";
import { type Finding, formatFindingBlocks, groupByFixIn } from "../core/finding.js";

import type { StatusReport } from "../core/status-report.js";
import type { DirectionAcceptanceSummary } from "../core/direction-acceptance.js";

export type { DirectionAcceptanceSummary };

// The direction is the one project-wide, variant-less accept, and it gates every animatic/video
// spend — so it heads the progress block, above the per-stage asset ratios it precedes.
function directionAcceptanceLine(summary: DirectionAcceptanceSummary, empty: boolean): string {
  const label = "direction";
  if (empty) return `  ${label}: not written yet`;
  switch (summary.status) {
    case "accepted":
      return `  ${label}: accepted`;
    case "partial":
      // Only parts that still hold a spend get the imperative; a shot rewritten after the piece was
      // accepted whole is named without one.
      return summary.gateBlocking > 0
        ? `  ${label}: ${summary.gateBlocking} of ${summary.total} parts need review — re-accept`
        : `  ${label}: accepted — ${formatDirectionRemainder(summary)}, none blocking`;
    case "unaccepted":
      return `  ${label}: not accepted`;
  }
}

// The parts short of accepted, by what happened to them: `46 of 81 parts not accepted (shots), 6
// changed since (characters)`.
export function formatDirectionRemainder(
  summary: DirectionAcceptanceSummary,
  { sections = true }: { sections?: boolean } = {},
): string {
  return (
    [
      ["not accepted", summary.unaccepted],
      ["changed since", summary.changed],
    ] as const
  )
    .filter(([, t]) => t.parts > 0)
    .map(([label, t], i) => {
      const count = i === 0 ? `${t.parts} of ${summary.total} parts` : `${t.parts}`;
      const named = sections && t.sections.length > 0 ? ` (${t.sections.join(", ")})` : "";
      return `${count} ${label}${named}`;
    })
    .join(", ");
}

// A finding under its code's remedy is one short line.
const FINDING_BLOCK_CAP = 30;

export function printStatusReport(
  report: StatusReport,
  suggestedActions: SuggestedAction[],
  options?: {
    videoRoot?: string;
    verbose?: boolean;
    directionAcceptance?: DirectionAcceptanceSummary | null;
    directionEmpty?: boolean;
    findings?: readonly Finding[];
    staleWaivers?: readonly StaleWaiverLine[];
  },
): void {
  const { sections, readiness, lastExports } = report;
  const formatted = formatSuggestedActions(suggestedActions);

  if (readiness.length > 0 || options?.directionAcceptance) {
    // "Ready to export" only fits a fully-accepted profile; with anything still
    // pending the heading would contradict the count below it. Keep the heading
    // neutral and mark export-readiness per profile instead.
    console.log("Progress:");
    if (options?.directionAcceptance) {
      console.log(
        directionAcceptanceLine(options.directionAcceptance, options.directionEmpty ?? false),
      );
    }
    const fileWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
    for (const r of readiness) {
      // Only the video stage has a deliverable — `konte export` refuses reference (an upstream
      // pool) and animatic (a working stage), so only the video line claims export-readiness.
      const exportable = r.label === "video";

      // An undeveloped shot carries no address, so it is absent from the ratio below — without this
      // an animatic of three placeholders and one real panel would read "all 1 accepted". The DSL
      // form goes unsaid — it is `pendingShot` in either stage, so naming it here would only
      // translate the label already on the line.
      const undeveloped = r.pendingShots;

      // Qualifies the accept count in either shape: an accepted take whose definition or inputs have
      // moved since, and whose accept does not stand, is counted as accepted and isn't finished work. Left off the count, a partly
      // accepted stage reads as plain progress and the aged accepts are invisible until `inspect`.
      // Not a problem to fix — export uses the accepted output as-is. Next steps picks the refresh
      // and names the addresses with it — the accept once a fresh take has landed, the definition
      // restore for a human accept, the reroll otherwise — so repeating them here would say it twice.
      const staleCount = r.staleAwaitingAccept.length + r.staleAwaitingReroll.length;
      const staleSuffix = staleCount > 0 ? ` (${staleCount} stale)` : "";

      // A composition stage counts what its reel review signs off — shots, the soundtrack, the
      // overlay — so the number matches the page's; the generate ratio stays per asset, the unit
      // `generate` acts on.
      const reel = r.reel;
      const unit = reel ? (reel.shots === 1 ? " shot" : " shots") : "";
      const acceptTotal = reel ? reel.shots : r.total;
      const acceptedCount = reel ? reel.acceptedShots : r.accepted;
      const parts: string[] = [];
      if (acceptTotal > 0) {
        if (acceptedCount !== acceptTotal) {
          let clause = `${acceptedCount}/${acceptTotal}${unit} accepted${staleSuffix}`;
          // Pair the accept ratio with a generate ratio so a not-fully-accepted profile
          // reads unambiguously: what's never been generated (run `generate`) vs what's
          // generated and only awaiting review (see "Needs review").
          if (r.total > 0)
            clause += ` · ${r.generated}/${r.total}${reel ? " assets" : ""} generated`;
          // Counts, not addresses: `generate` is stage-scoped, so it acts on every one of these
          // whether or not this line names them — and an in-flight one is already handled. Naming
          // them would only restate the stage this line already leads with.
          const notes: string[] = [];
          if (r.inFlight > 0) notes.push(`${r.inFlight} in flight`);
          if (r.notGenerated.length > 0) {
            notes.push(`${r.notGenerated.length} not generated`);
          }
          if (notes.length > 0) clause += ` (${notes.join("; ")})`;
          parts.push(clause);
        } else {
          // A fully-accepted stage is still not exportable while an undeveloped shot remains
          // (surfaced below), while a timeline asset, the soundtrack or the overlay awaits its
          // accept, or while a composition or stem awaits its accept ("Needs review").
          const ready =
            exportable &&
            undeveloped === 0 &&
            r.accepted === r.total &&
            !reel?.soundtrackUnsigned &&
            !reel?.overlayUnsigned &&
            !reel?.thumbnailUnsigned &&
            !r.leavesUnsigned &&
            r.refsUnaccepted === 0 &&
            !r.deliveryUpscalerMissing;
          parts.push(
            `all ${acceptTotal}${unit} accepted${ready ? " — ready to export" : ""}${staleSuffix}`,
          );
        }
      }
      if (reel?.soundtrackUnsigned) parts.push("soundtrack not accepted");
      if (reel?.overlayUnsigned) parts.push("overlay not accepted");
      if (reel?.thumbnailUnsigned) parts.push("thumbnail not accepted");
      if (r.refsUnaccepted > 0) {
        parts.push(`${r.refsUnaccepted} upstream asset(s) it composites not accepted`);
      }
      if (undeveloped > 0) {
        parts.push(`${undeveloped} shot${undeveloped === 1 ? "" : "s"} undeveloped`);
      }
      // A count, like every other list on this line: Next steps' "add file" note names each missing
      // file by the path to put it at.
      if (r.filesMissing.length > 0) {
        parts.push(`${fileWord(r.filesMissing.length)} missing`);
      }
      if (r.unacceptedCast.length > 0) {
        parts.push(`cast not accepted: ${r.unacceptedCast.map(formatReferenceAddress).join(", ")}`);
      }
      if (r.deliveryUpscalerMissing) parts.push("no delivery upscaler");
      console.log(`  ${r.label}: ${parts.join(", ")}`);
    }
  }

  // Above the sections, not below them: every list is capped but the caps stack, and a piped read
  // (`konte status | head -20`) loses a trailing block. Progress is one bounded line per stage.
  if (formatted) console.log(`\n${formatted}`);

  // Printed whenever there is one: every finding is on the path of the command that reads status,
  // whether it holds anything or not. Grouped by the file each is fixed in.
  const findings = options?.findings ?? [];
  const staleWaivers = options?.staleWaivers ?? [];
  if (findings.length > 0 || staleWaivers.length > 0) {
    console.log();
    console.log(`Findings: ${findings.length + staleWaivers.length}`);
    const groups = groupByFixIn(findings);
    if (staleWaivers.length > 0 && !groups.some((g) => g.file === "direction.ts")) {
      groups.unshift({ file: "direction.ts", findings: [] });
    }
    for (const { file, findings: group } of groups) {
      console.log(`  ${file}`);
      for (const block of formatFindingBlocks(group)) {
        console.log(`    ${block.head}`);
        const { shown, hidden } = capList(block.items, {
          verbose: options?.verbose,
          cap: FINDING_BLOCK_CAP,
        });
        for (const line of [...shown, ...(hidden > 0 ? [moreLine(hidden)] : [])]) {
          console.log(`      ${line}`);
        }
      }
      if (file === "direction.ts") {
        const { shown, hidden } = capList(staleWaivers.map(formatStaleWaiverLine), {
          verbose: options?.verbose,
        });
        for (const line of [...shown, ...(hidden > 0 ? [moreLine(hidden)] : [])]) {
          console.log(`    ${line}`);
        }
      }
    }
  }

  if (lastExports.length > 0) {
    console.log();
    console.log("Last export:");
    const labelWidth = lastExports.reduce((max, e) => Math.max(max, e.label.length), 0);
    for (const e of lastExports) {
      // Relative, as every other list in the CLI reports a time (`konte job list`). The exact
      // instant is not lost: the output dir is stamped with it.
      const when = e.completedAt ? formatRelativeTime(e.completedAt) : "";
      const stale = e.outOfDate ? "  — out of date" : "";
      const file = options?.videoRoot
        ? path.relative(process.cwd(), path.join(options.videoRoot, e.outputFile))
        : e.outputFile;
      console.log(
        `  ${e.label.padEnd(labelWidth)}  [${e.noDelivery ? "working size" : "delivery"}]  ${file}${when ? `  (${when})` : ""}${stale}`,
      );
    }
  }

  // `-v` only. status is read in a loop, and every state a section reports is one Next steps names
  // a command or an edit for — down to the orphan job, the failed model download and the broken
  // patch script.
  if (options?.verbose) {
    for (const section of sections) {
      console.log();
      console.log(`${section.title}: ${section.items.length}`);
      for (const item of section.items) {
        // The take the item is about, when it has one — an address with several variants gives the
        // An item with nothing to add beyond its address (the plain case the section title already
        // describes) prints bare rather than trailing the separator into empty space.
        const trailer = [item.variantId, item.detail].filter(Boolean).join("  ");
        console.log(trailer ? `  ${item.address}  ${trailer}` : `  ${item.address}`);
      }
    }
  }

  // Unused assets are deliberately absent: nothing consumes them, so they gate neither review nor
  // export and there is no step to take now. `konte doctor`'s "unused assets" check owns them.
}
