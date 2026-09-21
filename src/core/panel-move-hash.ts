import { shortHash } from "./content-hash.js";
import type { AnimaticDefinition } from "./types/animatic.js";

/**
 * A panel's declared movement — `blocking` + `camera` — hashed.
 *
 * A review axis, never a generation one: it must stay out of `definitionHash`, whose change means
 * "remake this take" and routes to `reroll`.
 *
 * A panel that carries no movement (a landing frame) hashes a constant, so it never goes stale. An
 * address several panels resolve to (a shared timeline/reference asset) hashes all of their
 * movements in panel order.
 */
export function panelMoveHashes(
  animatic: AnimaticDefinition | null | undefined,
): Map<string, string> {
  const moves = new Map<string, Array<{ blocking: string | null; camera: string | null }>>();
  for (const shot of animatic?.shots ?? []) {
    for (const panel of [...(shot.panels ?? []), ...(shot.cutin?.panels ?? [])]) {
      const list = moves.get(panel.assetPath);
      const entry = { blocking: panel.blocking ?? null, camera: panel.camera ?? null };
      if (list) list.push(entry);
      else moves.set(panel.assetPath, [entry]);
    }
  }

  const hashes = new Map<string, string>();
  for (const [address, list] of moves) {
    hashes.set(address, shortHash(list));
  }
  return hashes;
}
