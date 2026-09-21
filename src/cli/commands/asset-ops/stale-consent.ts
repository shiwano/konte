import { KonteError } from "../../../core/errors.js";
import { collectStaleDependents } from "../../../core/staleness.js";
import type { StateManager } from "../../../core/state/index.js";
import type { buildDependencyGraph } from "../../../core/graph.js";
import { confirmAction } from "../../confirm.js";
import { printCapped } from "../../format-list.js";

// The pre-prompt stale heads-up: a bare count by default (the full list is noise for
// an agent), the complete listing only under --verbose.
function announceStale(staleMarked: readonly string[], verbose?: boolean): void {
  if (verbose) {
    console.log("The following assets will become stale:");
    for (const addr of staleMarked) console.log(`  ${addr}`);
  } else {
    console.log(`This will mark ${staleMarked.length} asset(s) stale (--verbose to list).`);
  }
}

// Stale propagation needs consent whatever the output format: a format is not a
// consent. Non-TTY without --yes/--no fails CONFIRMATION_REQUIRED inside confirmAction. Nothing to
// propagate is consent by construction.
export async function consentToStale(
  staleMarked: readonly string[],
  opts: { verbose?: boolean; yes?: boolean; no?: boolean },
): Promise<boolean> {
  if (staleMarked.length === 0) return true;
  announceStale(staleMarked, opts.verbose);
  return confirmAction("Continue?", { yes: opts.yes, no: opts.no });
}

export function printAddresses(title: string, addrs: readonly string[], verbose?: boolean): void {
  console.log(`${title}: ${addrs.length}`);
  printCapped(addrs, (addr) => addr, { verbose });
}

// The assets a set of verdicts restales: dependents of every address one of them moved, read off
// the state those verdicts are already applied to.
export function staleFrom(
  manager: StateManager,
  moved: ReadonlyArray<{ address: string }>,
  dependents: ReturnType<typeof buildDependencyGraph>["dependents"],
): string[] {
  const cache = manager.stalenessCache();
  return [
    ...new Set(
      moved.flatMap(({ address }) =>
        collectStaleDependents(manager.getState(), address, dependents, cache),
      ),
    ),
  ];
}

// The stale addresses a commit produced that the prompt never showed — a concurrent decision landed
// between the preview and the lock. Throwing on these skips `save()`, so nothing is committed.
export function assertConsentedStale(
  staleMarked: readonly string[],
  consented: ReadonlySet<string> | null,
): void {
  if (!consented) return;
  const unconsented = staleMarked.filter((addr) => !consented.has(addr));
  if (unconsented.length === 0) return;
  throw new KonteError(
    "CONFIRMATION_REQUIRED",
    `State changed since preview (a concurrent decision): this now marks ${unconsented.length} additional asset(s) stale, which was not confirmed. Re-run to review.`,
  );
}
