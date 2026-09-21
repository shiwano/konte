import { shortHash } from "./content-hash.js";
import { NON_GENERATIVE_KEYS } from "./types/definition.js";
import type { AssetDefinition } from "./types/index.js";

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
  for (const key of NON_GENERATIVE_KEYS) delete generative[key];
  return shortHash(generative);
}
