import { KonteError } from "./errors.js";
import type { StateManager } from "./state/index.js";

export function resolveRefs(
  addresses: readonly string[],
  manager: StateManager,
  options: { strict?: boolean } = {},
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const state = manager.getState();
  // The manager's view, so a spend resolves its inputs by the definitions the command registered.
  const view = manager.stalenessView();

  // A dependency path IS its upstream address, so it resolves directly.
  for (const depPath of addresses) {
    const selected = view.resolve(depPath, { requireAccepted: options.strict });
    const file = selected ? state.assets[depPath]?.variants?.[selected.variantId]?.file : undefined;
    if (file) {
      resolved[depPath] = file;
      continue;
    }

    throw new KonteError("DEPENDENCY_NOT_RESOLVED", `Dependency "${depPath}" has no ready asset`);
  }

  return resolved;
}
