import type { HeardTake, LineMarks } from "../../../core/line-marks.js";

/**
 * Where the reel is heard to say each line, by its number in the shot's script, from the takes it
 * shows: at each address the one `shown` names, else the one the address resolves to. A line two
 * clips say is read off the one heard saying it.
 */
export function shownLineMarks(
  takes: readonly HeardTake[],
  shown: Readonly<Record<string, string>>,
): LineMarks[] {
  const out = new Map<number, LineMarks>();
  const heard = (m: LineMarks) => m.timeAt.some((t) => t !== null);
  for (const take of takes) {
    const picked = shown[take.address];
    const showing = picked ? take.variantId === picked : take.resolved;
    if (!showing) continue;
    for (const line of take.lines) {
      const held = out.get(line.line);
      if (!held || (!heard(held) && heard(line))) out.set(line.line, line);
    }
  }
  return [...out.values()].sort((x, y) => x.line - y.line);
}
