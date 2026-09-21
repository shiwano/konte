/**
 * Map index over a definition's shots, keyed weakly on the shots array itself: a definition
 * reload builds a new array, so entries invalidate naturally, and ad-hoc arrays are collected
 * with their index. Replaces the `shots.find(s => s.id === …)` linear scan, which turns any
 * per-address loop quadratic in shot count. The length guard rebuilds after an in-place
 * append; shots arrays are otherwise treated as immutable after load.
 */
const indexes = new WeakMap<object, { length: number; byId: Map<string, unknown> }>();

export function shotById<S extends { id: string }>(shots: readonly S[], id: string): S | undefined {
  let index = indexes.get(shots);
  if (!index || index.length !== shots.length) {
    index = { length: shots.length, byId: new Map(shots.map((s) => [s.id, s])) };
    indexes.set(shots, index);
  }
  return index.byId.get(id) as S | undefined;
}

// The same index for render-plan shots, which carry `shotId` instead of `id`.
const planIndexes = new WeakMap<object, { length: number; byId: Map<string, unknown> }>();

export function planShotById<S extends { shotId: string }>(
  shots: readonly S[],
  shotId: string,
): S | undefined {
  let index = planIndexes.get(shots);
  if (!index || index.length !== shots.length) {
    index = { length: shots.length, byId: new Map(shots.map((s) => [s.shotId, s])) };
    planIndexes.set(shots, index);
  }
  return index.byId.get(shotId) as S | undefined;
}
