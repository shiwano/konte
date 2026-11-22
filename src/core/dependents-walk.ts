/**
 * Visits each address downstream of `root` once, breadth first, `root` excluded. `visit` returns
 * whether the walk goes on past that address; `"halt"` ends the whole walk.
 */
export function walkDependents(
  dependents: ReadonlyMap<string, readonly string[]>,
  root: string,
  visit: (address: string) => boolean | "halt",
): void {
  const seen = new Set<string>();
  const queue = [...(dependents.get(root) ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    if (seen.has(p)) continue;
    seen.add(p);
    const next = visit(p);
    if (next === "halt") return;
    if (next) queue.push(...(dependents.get(p) ?? []));
  }
}
