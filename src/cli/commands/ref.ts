import path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../core/errors.js";
import { StateManager } from "../../core/state/index.js";
import { requireVideoRoot } from "../context.js";
import { applyResolutionDefinitions } from "../../core/definition-hashes.js";
import { staleRefreshStep } from "../stale-refresh-step.js";
import type { AnimaticDefinition } from "../../core/types/index.js";

interface Resolved {
  address: string;
  file: string;
  variantId: string;
  isAccepted: boolean;
  /** The notice to print on stderr beside the path, when the take printed is not current. */
  notice?: string;
}

/**
 * The take a named variant id points at. Resolution is skipped on purpose: the caller named the
 * take, so a stale or dismissed one still prints — that is the whole point of naming it (a patch
 * output standing beside the accepted take it corrects, say). Only a fileless variant is unresolved.
 */
function resolveVariantId(manager: StateManager, variantId: string): Resolved | null {
  const address = manager.findVariantAddress(variantId);
  if (!address) return null;
  const variant = manager.tryGetAssetState(address)?.variants?.[variantId];
  if (!variant?.file) return null;
  return {
    address,
    file: path.resolve(manager.videoRoot, variant.file),
    variantId,
    isAccepted: variant.status === "accepted",
  };
}

/**
 * What to say on stderr about the take an address resolved to, or undefined when it is current.
 *
 * Both staleness axes, and an ACCEPTED take is warned about too: an accept protects a take from
 * being replaced, not from the definition moving under it.
 *
 * The step named is `staleRefreshStep`'s — the same one `inspect` prints.
 */
function staleNotice(
  manager: StateManager,
  address: string,
  variantId: string,
  animatic: AnimaticDefinition | undefined,
): string | undefined {
  const cache = manager.stalenessCache();
  const staleness = manager.variantStaleness(address, variantId, cache);
  if (!staleness || (!staleness.inputStale && !staleness.definitionStale)) return undefined;
  const lead = `${address} resolves to a stale take (${variantId})`;
  const step = staleRefreshStep({
    manager,
    address,
    variantId,
    patchHashes: manager.patchHashes(),
    animatic,
    cache,
  });
  switch (step.kind) {
    case "none":
      return undefined;
    case "patch-apply":
      return `${lead} — \`konte patch apply ${step.sourceVariantId}\` to re-apply its correction`;
    case "prune":
      return `${lead} — \`konte prune\` (its patch script is gone)`;
    case "accept":
      return `${lead} — \`konte accept ${step.variantId}\` is already generated and matches the current definition`;
    case "prerequisite":
      return `${lead} — ${step.variantId} matches the current definition; write ${step.missing.join("/")} in ${step.writeIn} before accepting it`;
    case "generate":
      return `${lead} — \`konte generate ${step.stage}\` to re-bake it (a deterministic take has no alternative to pick)`;
    case "review":
      return `${lead} — \`konte preview ${step.stage}\` to re-accept it (materialized by its accept)`;
    case "stands":
      return `${lead} — accepted against an older upstream; the accept stands`;
    case "reroll":
      return `${lead} — \`konte reroll ${address}\` to rebuild it`;
  }
}

export function registerRefCommand(program: Command): void {
  program
    .command("ref <variantOrAddress...>")
    .description("Print the file path for each asset address or variant id")
    .option("--verbose", "Also print the resolved address and variant id to stderr")
    .addHelpText(
      "after",
      `
Prints one path per line, in the order given. Each argument is either a variant id (v-…), which
prints that exact take — stale or undecided included — or an address, resolved to its canonical
variant (accepted, else latest ready non-stale, else the latest stale one). \`:\` is the
discriminator: a variant id never carries one.

A take that no longer matches its definition or its inputs still prints, with a notice on stderr
naming the step back — an accept when a matching take is already generated, else a reroll; an
accepted take whose upstream alone changed is named as standing. It
is what the review surfaces show, so \`ref\` names it too; a spend does not build on it, so read it
as material to judge, never as a result to report. An accepted take gets the notice as well: an
accept protects a take from being replaced, not from the definition moving under it.

Name a variant id to see a take the address does not resolve to — a fresh patch output or reroll
sitting undecided beside the accepted take (\`konte patch apply\` and \`konte inspect <address>\`
both print the id).

If any argument has no file, nothing is printed and the command fails with VARIANT_NOT_FOUND
naming every unresolved one.

Examples:
  konte ref video:shot.01.motion                     Print one asset's path
  konte ref reference:catClerk reference:shopCounter Print both paths, in that order
  konte ref v-a1b2c3d4                               Print that exact take's path`,
    )
    .action(async (variantOrAddresses: string[], opts: { verbose?: boolean }) => {
      const videoRoot = requireVideoRoot();
      const manager = await StateManager.load(videoRoot);
      // Definitions before any resolution; a run naming only variant ids resolves nothing.
      const stages = variantOrAddresses.some((arg) => arg.includes(":"))
        ? await applyResolutionDefinitions({ videoRoot, state: manager.getState() })
        : {};

      const resolved: Resolved[] = [];
      const missing: string[] = [];
      for (const arg of variantOrAddresses) {
        if (arg.includes(":")) {
          const reference = manager.resolveReference(arg, { includeStale: true });
          if (reference) {
            resolved.push({
              address: arg,
              ...reference,
              notice: staleNotice(manager, arg, reference.variantId, stages.animatic ?? undefined),
            });
          } else missing.push(arg);
          continue;
        }
        manager.assertNotAbsent(arg);
        const byVariant = resolveVariantId(manager, arg);
        if (byVariant) resolved.push(byVariant);
        else missing.push(arg);
      }
      if (missing.length > 0) {
        throw new KonteError("VARIANT_NOT_FOUND", `No ready variant for ${missing.join(", ")}`);
      }

      for (const { address, file, variantId, isAccepted, notice } of resolved) {
        if (opts.verbose) {
          console.error(`${address} → ${variantId}${isAccepted ? " (accepted)" : ""}`);
        }
        // Not gated on --verbose: silence here is how an old file gets piped onward, probed, and
        // reported as the fix.
        if (notice) console.error(notice);
        console.log(file);
      }
    });
}
