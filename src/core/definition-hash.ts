import { shortHash } from "./content-hash.js";
import { NON_GENERATIVE_KEYS } from "./types/definition.js";
import type { AssetDefinition } from "./types/index.js";

/**
 * Deletes, in place, every field no take's bytes depend on: `NON_GENERATIVE_KEYS`, and a comfy
 * workflow's file name where its graph is hashed as `workflowHash`.
 */
export function stripNonGenerative(def: Record<string, unknown>): void {
  for (const key of NON_GENERATIVE_KEYS) delete def[key];
  if (def.kind === "comfy" && typeof def.workflowHash === "string") delete def.workflow;
}

/**
 * The fingerprint a take is compared against to decide whether its definition moved.
 *
 * `NON_GENERATIVE_KEYS` are excluded: none reaches a backend, so no take's bytes can depend on
 * them. Hashing them would age out every accepted take the moment an adapter's review policy or an
 * input's declared name changed — takes that are byte-identical and cost real money to replace.
 * Every consumer reads them live off the definition (`assetSkipReason`), never
 * off a hash.
 *
 * A denylist, not an allowlist: a generative field left out of an allowlist would read a changed
 * definition as unchanged and hand back a take that no longer matches it. Forgetting one here only
 * costs a spurious re-generation, which is loud.
 */
export function computeDefinitionHash(assetDef: AssetDefinition): string {
  const generative: Record<string, unknown> = { ...assetDef };
  stripNonGenerative(generative);
  return shortHash(generative);
}
