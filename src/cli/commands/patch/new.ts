import * as fs from "node:fs/promises";
import type { Command } from "commander";
import { isDeliveryAddress, isMaterializedLeafAddress } from "../../../core/address.js";
import type { MediaKind } from "../../../core/dsl/builders.js";
import { KonteError } from "../../../core/errors.js";
import { inferMediaType } from "../../../core/media-type.js";
import { assertPatchableTarget, patchFilePath, patchesDir } from "../../../core/patch.js";
import { StateManager } from "../../../core/state/index.js";
import { requireVideoRoots } from "../../context.js";
import { resolveVariantArg } from "../asset-ops/resolve-variant-arg.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

// The scaffold names no adapter: which one to reach for is `konte adapter list`/`show`'s job, and
// this workspace may not even be allowed to spend on the one a fixed default would pick. Returning
// `source` unchanged type-checks, so a fresh scaffold never breaks the video it belongs to; it
// fails at apply time instead, saying it was never written. The commented call is the shape an
// author cannot guess — that steps are declared with `asset()` exactly as in a stage file, and
// that the one returned is the correction's output.
function scaffold(mediaKind: MediaKind): string {
  return `import { asset, adapters, definePatch } from "konte";

export default definePatch<"${mediaKind}">(({ source }) => {
  // const patched = asset("patched", <${mediaKind}Edit>, {
  //   <${mediaKind}>: source,
  //   prompt: "the edit, in the shape its guide gives — konte adapter show <adapter>",
  // });
  // return patched;
  return source;
});`;
}

export function registerPatchNewCommand(parent: Command): void {
  parent
    .command("new <variantId...>")
    .description("Scaffold a patch script for each of one or more variants")
    .addHelpText(
      "after",
      `
Writes patches/<variantId>.ts, where you declare the steps to run over that exact take —
typically one image-edit model fixing a local flaw, but as many chained steps as the fix needs.
The filename is the variant id, so a take carries at most one patch script. The scaffold returns
the take unchanged; it fails to apply until you replace that with the adapter to run. Apply it
with \`konte patch apply\`, or just run \`konte generate <stage>\`, which picks up every patch
that has no current output.

Every target is checked before any file is written: one rejected target scaffolds nothing.

A target is a variant id, or an address — which lands on the take that address resolves to now
(accepted, else the newest ready one). To correct an older take, name its id; \`konte inspect
<address>\` lists them.

A take a patch itself produced cannot be patched again — neither its output nor a step of its
chain. Stack the next fix by appending a step to the script that produced it, which reuses the
steps it did not touch instead of re-running them.

Examples:
  konte patch new v-a1b2c3         scaffold a patch for that variant
  konte patch new v-a1b2c3 v-d4e5f6 v-g7h8i9   one per take, in a single call
  konte patch new animatic:shot.08.frame animatic:shot.11.frame   by address, whatever each resolves to`,
    )
    .action(async (variantIdArgs: string[]) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      const manager = await StateManager.load(videoRoot);
      // An address argument resolves to the take the correction is written from.
      await applyResolutionDefinitions({ videoRoot, state: manager.getState() });

      // Resolve and check every target first. A scaffold is cheap to write and impossible to
      // un-write without knowing which of the batch got that far, so the whole call either
      // scaffolds or throws — the typed code names the one target that stopped it.
      const planned: Array<{ variantId: string; address: string; filePath: string; body: string }> =
        [];
      for (const arg of variantIdArgs) {
        const { address, variantId } = resolveVariantArg(manager, arg);

        // Two arguments can name one take (its id, and an address that resolves to it). That is a
        // way of writing the same target twice, not a second target to reject.
        if (planned.some((p) => p.variantId === variantId)) continue;

        if (isDeliveryAddress(address)) {
          throw new KonteError(
            "INVALID_ASSET_TYPE",
            `Cannot patch "${address}": delivery targets are produced by \`konte export\``,
          );
        }
        if (isMaterializedLeafAddress(address)) {
          throw new KonteError(
            "INVALID_ASSET_TYPE",
            `Cannot patch "${address}": composition/stem targets are materialized from their inputs, not generated`,
          );
        }
        assertPatchableTarget(manager.getState(), address, variantId);

        const variant = manager.getState().assets[address]?.variants?.[variantId];
        if (!variant?.file) {
          throw new KonteError(
            "PATCH_SOURCE_NOT_READY",
            `Variant "${variantId}" has no output file yet — there is nothing to patch`,
          );
        }
        // The scaffold pins the source's kind as `definePatch`'s type argument, so the take can be
        // fed straight to a typed adapter input. The file names one variant for life, so the kind
        // read off its output here cannot drift out from under it.
        const mediaKind = inferMediaType(variant.file);
        if (!mediaKind) {
          throw new KonteError(
            "INVALID_ASSET_TYPE",
            `Cannot patch "${variantId}": its output "${variant.file}" is not a known image, video or audio file`,
          );
        }

        const filePath = patchFilePath(videoRoot, variantId);
        try {
          await fs.access(filePath);
          throw new KonteError(
            "PATCH_ALREADY_EXISTS",
            `A patch already exists for "${variantId}": ${filePath}. Edit it, or remove it with \`konte patch remove ${variantId}\`.`,
          );
        } catch (err) {
          if (err instanceof KonteError) throw err;
        }

        planned.push({ variantId, address, filePath, body: scaffold(mediaKind) });
      }

      await fs.mkdir(patchesDir(videoRoot), { recursive: true });
      const created: Array<{ variantId: string; address: string; file: string }> = [];
      for (const p of planned) {
        await fs.writeFile(p.filePath, p.body, "utf-8");
        created.push({
          variantId: p.variantId,
          address: p.address,
          file: p.filePath,
        });
      }

      for (const c of created) {
        console.log(`Created ${c.file}`);
        console.log(`  patches ${c.address} (${c.variantId})`);
      }
      // With one take there is a target worth naming; with several, `konte patch apply` on its
      // own picks up exactly the set just scaffolded once each is written.
      console.log(
        created.length === 1
          ? `\nEdit it, then run: konte patch apply ${created[0]!.variantId}`
          : `\nEdit them, then run: konte patch apply`,
      );
    });
}
