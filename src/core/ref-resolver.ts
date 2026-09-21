import { KonteError } from "./errors.js";
import { selectResolvedVariant } from "./staleness.js";
import type { StateManager } from "./state/index.js";

export function resolveRefs(
  assetPaths: readonly string[],
  manager: StateManager,
  options: { strict?: boolean } = {},
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const state = manager.getState();
  // The manager's cache, so a spend resolves its inputs by the definitions the command registered.
  const cache = manager.stalenessCache();

  // A dependency path IS its upstream address (address ≡ asset path), so it resolves directly.
  for (const depPath of assetPaths) {
    const selected = selectResolvedVariant(
      state,
      depPath,
      { requireAccepted: options.strict },
      cache,
    );
    const file = selected ? state.assets[depPath]?.variants?.[selected.variantId]?.file : undefined;
    if (file) {
      resolved[depPath] = file;
      continue;
    }

    throw new KonteError("DEPENDENCY_NOT_RESOLVED", `Dependency "${depPath}" has no ready asset`);
  }

  return resolved;
}
