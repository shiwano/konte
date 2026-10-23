import { KonteError } from "../../../core/errors.js";
import { collectStaleDependents } from "../../../core/staleness.js";
import type { StateManager } from "../../../core/state/index.js";
import type { buildDependencyGraph } from "../../../core/graph.js";
import { confirmAction } from "../../confirm.js";
import { printCapped } from "../../format-list.js";

// Stale propagation needs consent whatever the output format.
export async function consentToStale(
  staleMarked: readonly string[],
  opts: { verbose?: boolean; yes?: boolean; no?: boolean },
): Promise<boolean> {
  if (staleMarked.length === 0) return true;
  if (opts.verbose) {
    console.log("The following assets will become stale:");
    for (const addr of staleMarked) console.log(`  ${addr}`);
  }
  const consequence = opts.verbose
    ? `This will mark ${staleMarked.length} asset(s) stale.`
    : `This will mark ${staleMarked.length} asset(s) stale (--verbose to list).`;
  // A flag answers the question; the disclosure still prints.
  if (opts.yes || opts.no) console.log(consequence);
  return confirmAction(consequence, { yes: opts.yes, no: opts.no });
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
