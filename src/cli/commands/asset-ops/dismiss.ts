import type { Command } from "commander";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { buildDependencyGraph } from "../../../core/graph.js";
import { StateManager } from "../../../core/state/index.js";
import { printAborted } from "../../confirm.js";
import { requireVideoRoot } from "../../context.js";
import { loadStageDefinitions } from "../../load-definition.js";
import { resolveVariantArg } from "./resolve-variant-arg.js";
import { assertDismissable } from "./reviewable.js";
import {
  assertConsentedStale,
  consentToStale,
  printAddresses,
  staleFrom,
} from "./stale-consent.js";

interface DismissOptions {
  off?: boolean;
  yes?: boolean;
  no?: boolean;
  verbose?: boolean;
}

export function registerDismissCommand(program: Command): void {
  program
    .command("dismiss <targets...>")
    .description("Decide against a take without accepting another (--off to lift)")
    .option("--off", "Lift the dismissal instead, returning the take to undecided")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--no", "Abort without prompting (treat confirmation as 'no')")
    .option("-v, --verbose", "List the assets this makes stale instead of counting them")
    .addHelpText(
      "after",
      `
Record a verdict against a take without signing off another one. A dismissed take
never resolves, so the address falls back to the take before it — how a reroll
that came out worse is undone while the take it displaced stays undecided. Nothing
is deleted: the file stays, the review gallery keeps showing it, and accepting it
later revives it. An address left holding only dismissed takes is generated afresh.

Each target is a variant id, or an address — which lands on the take that address
resolves to now, so naming the address means "throw out what is showing". Only a
landed take of a reviewable asset can be decided against: never a deterministic one
(konte's own take, re-baked by \`konte generate\`), not the accepted one (clear the
accept first),
not a take a patch was made from (it is its correction's "before" rather than one of
the choices), and not one whose job has yet to produce a file. Dismissing a take that
already carries the verdict changes nothing, timestamp included.

Dismissing changes what the address resolves to, so consumers built on the old
resolution go stale. That propagation requires confirmation (-y to proceed, --no to
abort).

Examples:
  konte dismiss v-abc123                     Dismiss that take
  konte dismiss video:shot.21.motion         Dismiss whatever the address is showing
  konte dismiss v-abc123 v-def456 -y         Dismiss several at once
  konte dismiss v-abc123 --off               Return it to undecided`,
    )
    .action(async (targets: string[], opts: DismissOptions) => {
      const videoRoot = requireVideoRoot();
      const dismissed = opts.off !== true;

      // Registered before anything resolves an address — without them resolution is blind to the
      // definition axis.
      const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
      await applyResolutionDefinitions({
        videoRoot,
        definitions: { video, animatic, reference },
      });
      const graph = buildDependencyGraph(video, animatic, reference);

      const previewManager = await StateManager.load(videoRoot);
      // Resolved before anything is applied, so a malformed or unknown target fails with nothing
      // half-decided. Two targets naming the same take (an id and the address showing it) are one
      // decision.
      const resolved = new Map<string, { address: string; variantId: string }>();
      for (const target of targets) {
        const hit = resolveVariantArg(previewManager, target);
        resolved.set(`${hit.address}|${hit.variantId}`, hit);
      }
      const items = [...resolved.values()];
      // A dismissal picks between takes, and a deterministic asset offers only one — without this
      // `setDismissed`'s "clear the accept first" would name a command that refuses.
      for (const { address } of items) {
        assertDismissable({ video, animatic, reference }, address);
      }

      // Applied to the in-memory copy first: `setDismissed` throws on a take that cannot carry this
      // verdict. A target already carrying it changes nothing, so it is no root of its own — its
      // dependents' staleness predates this run.
      const moved = items.filter(
        ({ address, variantId }) =>
          previewManager.setDismissed(address, variantId, dismissed) === true,
      );
      // The memo is taken AFTER the flips — this reports what changed because of them.
      const previewStale = staleFrom(previewManager, moved, graph.dependents);

      if (!(await consentToStale(previewStale, opts))) {
        printAborted();
        return;
      }

      // Exactly which assets the user consented to restale: the set the prompt above showed them.
      // `--yes` is blanket consent, so it needs no set.
      const consentedStale = opts.yes ? null : new Set(previewStale);

      const { showing, staleMarked } = await StateManager.withLock(videoRoot, async (manager) => {
        const committed = items.filter(
          ({ address, variantId }) => manager.setDismissed(address, variantId, dismissed) === true,
        );
        // Re-derived from inside the lock, so what is reported is what the committed state says.
        const staleMarked = staleFrom(manager, committed, graph.dependents);
        assertConsentedStale(staleMarked, consentedStale);
        // What each address names now the verdicts are in, read from the committed state.
        const cache = manager.stalenessCache();
        const showing = new Map(
          items.map(({ address }) => [
            address,
            manager.selectVariant(address, { includeStale: true }, cache)?.variantId ?? null,
          ]),
        );
        return { showing, staleMarked };
      });

      const label = dismissed ? "Dismissed" : "Undecided";
      for (const { address, variantId } of items) {
        const now = showing.get(address) ?? null;
        const suffix = now
          ? `(now showing ${now})`
          : "(nothing resolves now — konte generate rebuilds it)";
        console.log(`${label}: ${address} → ${variantId} ${suffix}`);
      }
      if (staleMarked.length > 0) {
        if (opts.verbose) printAddresses("Stale assets", staleMarked, true);
        else console.log(`${staleMarked.length} asset(s) now stale`);
      }
    });
}
