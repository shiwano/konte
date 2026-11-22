import type React from "react";
import { createContext, useContext } from "react";

import type { DirectionPartInfo } from "../../../../core/types/review-state.js";

// What sets a part apart on a direction some of which is signed off: reworded since, or never read.
type PartMark = "changed" | "new";

export const PartMarksContext = createContext<ReadonlyMap<string, PartMark>>(new Map());

// On a direction nothing of which was ever signed off, every part is unread and none is marked.
export function partMarks(parts: readonly DirectionPartInfo[]): Map<string, PartMark> {
  const out = new Map<string, PartMark>();
  const signed = parts.filter((p) => p.status !== "unsigned");
  if (signed.every((p) => p.status === "unaccepted")) return out;
  for (const p of signed) {
    if (p.status !== "accepted") out.set(p.address, p.status === "stale" ? "changed" : "new");
  }
  return out;
}

// One mark for a row that also answers for parts read inside it: its own, else "changed" when one of those is marked.
export function rowMark(
  marks: ReadonlyMap<string, PartMark>,
  address: string,
  inner: readonly string[],
): PartMark | undefined {
  return marks.get(address) ?? (inner.some((a) => marks.has(a)) ? "changed" : undefined);
}

export function PartMarkTag({
  address,
  inner = [],
}: {
  address: string;
  inner?: readonly string[];
}): React.ReactElement | null {
  const mark = rowMark(useContext(PartMarksContext), address, inner);
  return mark ? <span className={`dir-mark dir-mark--${mark}`}>{mark}</span> : null;
}
