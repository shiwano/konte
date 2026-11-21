import { formatPatchAddress, parseAddress, patchSourceVariantIdOf } from "./address.js";
import type { PatchBuild, PatchBuildContext } from "./dsl/patch.js";
import { KonteError } from "./errors.js";
import { extractRefs } from "./graph.js";
import { type AssetDefinition, AssetDefinitionSchema } from "./types/index.js";

export function validatePatchChain(
  filePath: string,
  built: PatchBuild,
  ctx: PatchBuildContext,
): PatchBuild {
  const assets: Record<string, AssetDefinition> = {};
  for (const [name, raw] of Object.entries(built.assets)) {
    const parsed = AssetDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new KonteError(
        "PATCH_INVALID",
        `Patch file "${filePath}" produced an invalid asset definition for "${name}": ${parsed.error.message}`,
      );
    }
    if (parsed.data.kind === "file") {
      throw new KonteError(
        "PATCH_INVALID",
        `Patch file "${filePath}" cannot use a file adapter (asset "${name}")`,
      );
    }
    assets[name] = parsed.data;
  }

  // The returned step is the correction's output. A step consuming it would be spend beyond the
  // take, and is unreachable from the output — which the closure check below would report as
  // "nothing consumes it", the wrong way round for the author who wrote the chain.
  const outputAddress = formatPatchAddress(ctx.stage, ctx.sourceVariantId, built.outputName);
  for (const [name, def] of Object.entries(assets)) {
    if (name === built.outputName) continue;
    if (extractRefs(def).includes(outputAddress)) {
      throw new KonteError(
        "PATCH_INVALID",
        `Patch file "${filePath}" feeds its returned step "${built.outputName}" into "${name}" — nothing else may consume it`,
      );
    }
  }

  // Everything the chain generates must be what the correction is built from, walked back from the
  // returned step. A step outside that closure is spend nothing consumes; and a `source` reference
  // that only such a step makes would let an unrelated generation be recorded as derived from that
  // take, giving the lineage (and so the review UI's "before") a relationship that never existed.
  const reachable = new Set<string>([built.outputName]);
  const queue = [built.outputName];
  while (queue.length > 0) {
    const def = assets[queue.pop()!];
    if (!def) continue;
    for (const ref of extractRefs(def)) {
      const parsed = patchStepNameOf(ref, ctx);
      if (parsed === null || reachable.has(parsed)) continue;
      reachable.add(parsed);
      queue.push(parsed);
    }
  }
  const unreachable = Object.keys(assets).filter((name) => !reachable.has(name));
  if (unreachable.length > 0) {
    throw new KonteError(
      "PATCH_INVALID",
      `Patch file "${filePath}" declares ${unreachable.map((n) => `"${n}"`).join(", ")}, which the returned step "${built.outputName}" never consumes`,
    );
  }

  // A patch that never wires `source` into the chain behind its output is not a correction of that
  // take, however much of `source` its other declarations mention.
  const consumesSource = [...reachable].some((name) => {
    const def = assets[name];
    return def !== undefined && extractRefs(def).includes(ctx.sourceAddress);
  });
  if (!consumesSource) {
    throw new KonteError(
      "PATCH_INVALID",
      `Patch file "${filePath}" never passes \`source\` to an adapter — a patch must consume the variant it patches`,
    );
  }
  return {
    assets,
    outputName: built.outputName,
    ...(built.prompts ? { prompts: built.prompts } : {}),
  };
}

// The step name a ref points at, when it points at a step of this same patch; null otherwise.
function patchStepNameOf(ref: string, ctx: PatchBuildContext): string | null {
  if (patchSourceVariantIdOf(ref) !== ctx.sourceVariantId) return null;
  const parsed = parseAddress(ref);
  return parsed.kind === "patch" && parsed.stage === ctx.stage ? parsed.assetName : null;
}
