import type { Command } from "commander";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { KonteError } from "../../../core/errors.js";
import { buildDependencyGraph } from "../../../core/graph.js";
import { StateManager } from "../../../core/state/index.js";
import { isReviewLeaf } from "../../../core/variant-lineage.js";
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
  except?: string[];
  yes?: boolean;
  no?: boolean;
  verbose?: boolean;
}

export function registerDismissCommand(program: Command): void {
  program
    .command("dismiss [targets...]")
    .description("Decide against a take without accepting another (--off to lift)")
    .option("--off", "Lift the dismissal instead, returning the take to undecided")
    .option(
      "--except <targets...>",
      "Dismiss every other landed undecided take at each named take's address",
    )
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

--except names the take to keep instead: every other landed, undecided take at its
address is dismissed, stale ones included. It refuses while another take there is
accepted, and a kept take that is dismissed, fileless, or a patch's source.

Dismissing changes what the address resolves to, so consumers built on the old
resolution go stale. That propagation requires confirmation (-y to proceed, --no to
abort).

Examples:
  konte dismiss v-abc123                     Dismiss that take
  konte dismiss video:shot.21.motion         Dismiss whatever the address is showing
  konte dismiss v-abc123 v-def456 -y         Dismiss several at once
  konte dismiss --except v-abc123 -y         Dismiss every other take at its address
  konte dismiss v-abc123 --off               Return it to undecided`,
    )
    .action(async (targets: string[], opts: DismissOptions) => {
      const videoRoot = requireVideoRoot();
      const dismissed = opts.off !== true;
      if (opts.except && (targets.length > 0 || opts.off)) {
        throw new KonteError(
          "INVALID_OPTION",
          "`--except` names the takes to keep — pass no targets and no `--off` with it",
        );
      }
      if (!opts.except && targets.length === 0) {
        throw new KonteError("INVALID_OPTION", "Pass a variant id or address, or --except");
      }

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
      const kept = resolveKept(previewManager, opts.except ?? []);
      for (const item of rivalsOfKept(previewManager, kept)) {
        resolved.set(`${item.address}|${item.variantId}`, item);
      }
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
        const landed = rivalsOfKept(manager, kept).filter(
          ({ address, variantId }) => !resolved.has(`${address}|${variantId}`),
        );
        if (landed.length > 0) {
          throw new KonteError(
            "CONFIRMATION_REQUIRED",
            `State changed since preview: ${landed.map((r) => r.variantId).join(", ")} landed beside the kept take, which was not confirmed. Re-run to review.`,
          );
        }
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
            {
              now: manager.selectVariant(address, { includeStale: true }, cache)?.variantId ?? null,
              undecided: manager.readyUndecidedTakes(address, cache),
            },
          ]),
        );
        return { showing, staleMarked };
      });

      if (items.length === 0) {
        console.log("Nothing to dismiss: no undecided take beside the kept one");
        return;
      }
      const label = dismissed ? "Dismissed" : "Undecided";
      for (const { address, variantId } of items) {
        const { now, undecided } = showing.get(address)!;
        const rivals = undecided.filter((id) => id !== now);
        const still = rivals.length > 0 ? `; still undecided: ${rivals.join(", ")}` : "";
        const suffix = now
          ? `(now showing ${now}${still})`
          : "(nothing resolves now — konte generate rebuilds it)";
        console.log(`${label}: ${address} → ${variantId} ${suffix}`);
      }
      if (staleMarked.length > 0) {
        if (opts.verbose) printAddresses("Stale assets", staleMarked, true);
        else console.log(`${staleMarked.length} asset(s) now stale`);
      }
    });
}

function resolveKept(manager: StateManager, keptArgs: readonly string[]): Map<string, string> {
  const kept = new Map<string, string>();
  for (const arg of keptArgs) {
    const { address, variantId } = resolveVariantArg(manager, arg);
    const other = kept.get(address);
    if (other !== undefined && other !== variantId) {
      throw new KonteError(
        "TARGETS_CONFLICT",
        `--except keeps one take per address: ${other} and ${variantId} are both at "${address}"`,
      );
    }
    kept.set(address, variantId);
  }
  return kept;
}

// The takes `--except` decides against: everything at each kept take's address that could still
// resolve over it.
function rivalsOfKept(
  manager: StateManager,
  kept: ReadonlyMap<string, string>,
): Array<{ address: string; variantId: string }> {
  const rivals: Array<{ address: string; variantId: string }> = [];
  const state = manager.getState();
  for (const [address, keptId] of kept) {
    const variants = state.assets[address]?.variants ?? {};
    const keep = variants[keptId];
    if (!keep) {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `Variant "${keptId}" not found for address "${address}"`,
      );
    }
    if (keep.status === "dismissed") {
      throw new KonteError(
        "VARIANT_NOT_REVIEWABLE",
        `Variant "${keptId}" is dismissed — lift it with \`konte dismiss ${keptId} --off\` first`,
      );
    }
    if (keep.file === null) {
      throw new KonteError(
        "VARIANT_NOT_REVIEWABLE",
        `Variant "${keptId}" has no output to keep — its job is still running, or it failed`,
      );
    }
    if (!isReviewLeaf(state, address, keptId)) {
      throw new KonteError(
        "VARIANT_NOT_REVIEWABLE",
        `Variant "${keptId}" is not a review candidate: a patch was made from it — keep its correction instead`,
      );
    }
    for (const [id, v] of Object.entries(variants)) {
      if (id === keptId) continue;
      if (v.status === "accepted") {
        throw new KonteError(
          "VARIANT_ACCEPTED",
          `Variant "${id}" is accepted at "${address}" — clear it with \`konte accept ${id} --off\` first`,
        );
      }
      if (v.status !== "none" || v.file === null || !isReviewLeaf(state, address, id)) continue;
      rivals.push({ address, variantId: id });
    }
  }
  return rivals;
}
