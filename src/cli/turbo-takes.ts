import { StateManager } from "../core/state/index.js";

// Rerolling a turbo take for its finish spends it before the human saw it.
export const TURBO_TAKE_NOTE =
  "the address's first take, on its model's turbo setting — send it to review as it is; a coarse finish is the setting, not the prompt, and the next take there is on the full setting";

export async function turboTakes<T extends { address: string; variantId: string }>(
  videoRoot: string,
  takes: readonly T[],
): Promise<T[]> {
  if (takes.length === 0) return [];
  const state = (await StateManager.load(videoRoot)).getState();
  return takes.filter((t) => state.assets[t.address]?.variants?.[t.variantId]?.turbo === true);
}
