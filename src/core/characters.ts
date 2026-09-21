import { formatReferenceAddress } from "./address.js";
import type { Direction } from "./dsl/direction.js";
import { loadDirectionDefinition, loadIfPresent } from "./loader.js";
import { stageEntryPath } from "./roots.js";

// Every `reference:<id>` the cast is anchored to: a character's look (the roster key equals the
// exposed asset name) and every cast voice sample — each character's, and the narrator's. Both are
// human calls, so both are held out of the accept cascades; a voice belongs here as much as a look
// does, and the sample is audio, which a stem-rooted walk would otherwise sign off sideways.
export function castReferenceAddresses(direction: Direction): string[] {
  const out: string[] = [];
  for (const [id, character] of Object.entries(direction.characters ?? {})) {
    out.push(formatReferenceAddress(id));
    if (character.voice) out.push(formatReferenceAddress(character.voice.id));
  }
  if (direction.narrator) out.push(formatReferenceAddress(direction.narrator.id));
  return out;
}

// The cast reference addresses declared by `direction.ts`, or an empty set when the project has no
// direction. Loads the direction fresh so callers with only a project root (e.g. the accept cascade)
// can enforce the rule without threading the definition through every call site.
export async function loadCastReferenceAddresses(videoRoot: string): Promise<Set<string>> {
  const direction = await loadIfPresent(
    stageEntryPath(videoRoot, "direction"),
    loadDirectionDefinition,
  );
  return new Set(direction ? castReferenceAddresses(direction) : []);
}
