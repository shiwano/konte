import { shortHash } from "./content-hash.js";
import { directionParts } from "./direction-parts.js";
import type { Direction } from "./dsl/direction.js";

// The content hash of each reviewable part of the direction, keyed by its feedback address: what
// the review page offers an Accept for and what the spend gate demands. A comment and an accept on
// a part both snapshot this hash, so both age out on the same edit.
export function directionPartHashes(direction: Direction): Map<string, string> {
  return new Map(
    [...directionParts(direction)].map(([address, p]) => [address, shortHash(p.hashInput)]),
  );
}

// The whole part set at once: it matches only while no part has moved, been added or been dropped.
export function directionHash(direction: Direction): string {
  return shortHash(Object.fromEntries(directionPartHashes(direction)));
}
