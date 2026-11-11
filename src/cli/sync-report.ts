import pkg from "../../package.json" with { type: "json" };

export function updateLines(sync: { updated: string[] }): string[] {
  return sync.updated.length > 0
    ? [`konte: overwrote ${sync.updated.length} managed file(s): ${sync.updated.join(", ")}`]
    : [];
}

export function retirementLines(sync: { removed: string[]; retained: string[] }): string[] {
  const lines: string[] = [];
  if (sync.removed.length > 0) {
    lines.push(
      `konte: removed ${sync.removed.length} file(s) v${pkg.version} no longer ships: ${sync.removed.join(", ")}`,
    );
  }
  if (sync.retained.length > 0) {
    lines.push(
      `konte: kept ${sync.retained.length} file(s) v${pkg.version} no longer ships and no longer updates, still named in the workspace: ${sync.retained.join(", ")}`,
    );
  }
  return lines;
}
