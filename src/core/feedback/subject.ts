import {
  formatAddress,
  formatCompositionAddress,
  formatTimelineStemAddress,
  listShotStems,
  parseShotAddress,
} from "../address.js";
import { timelineStemRefs } from "../composition-resource.js";
import { shotById } from "../shot-index.js";
import type { StageDefinition } from "../types/index.js";

/**
 * What a comment on `address` stands against: every address the reviewer perceived there, read off
 * the definition rather than off whatever the page happened to have in one of its arrays.
 *
 * This is the whole reason the derivation is here and not on the client. The page groups a shot's
 * media by ACCEPT routing — pictures accept with the shot, audio through the stem — and a client
 * that reads a comment's subject off one of those groups silently drops the other, which reads as
 * "nothing changed" rather than as a bug.
 *
 * `null` when the stage knows no such target — the caller's signal that it derived nothing because
 * there is nothing, not because it looked in the wrong place.
 */
export interface CommentSubjectAddresses {
  // Addresses whose displayed TAKE the comment stands against.
  assets: string[];
  // Materialized leaves (composition / stem), whose live DEFINITION it also stands against — they
  // render from the definition and mint no variant until accepted, so a definition edit is
  // invisible to the takes above.
  leaves: string[];
}

export function commentSubjectAddresses(
  def: StageDefinition,
  address: string,
): CommentSubjectAddresses | null {
  if (address === formatTimelineStemAddress(def.stage)) {
    // A stage with no beds has no timeline stem, so there is no such target to stand on.
    if ((def.timelineSoundtracks?.length ?? 0) === 0) return null;
    // What the mix is made of — the beds, and the lines a ducking bed yields to, whose takes move
    // the envelope the reviewer heard. The same set the stem materializes from, so a comment on the
    // soundtrack cannot stand against a take the mix no longer uses.
    //
    // Not the stem's own take: the preview renders it live from the definition, so the accepted
    // variant is not what played.
    return { assets: timelineStemRefs(def), leaves: [address] };
  }

  const shot = parseShotAddress(address);
  if (!shot || shot.stage !== def.stage) return null;
  const shotDef = shotById(def.shots, shot.shotId);
  if (!shotDef) return null;

  // What the composition REFERENCES, not what the shot declares. The two part company both ways: a
  // shot draws another shot's frame, a timeline overlay or a reference sheet — perceived, and absent
  // from its own assets — and it may declare an `asset()` it never places, which is on screen
  // nowhere. `compositionRefs` is the rendered set (audio included, since `stemRefs` partitions out
  // of it); a raw literal carries none, so its declarations stand in.
  // `undefined`, not empty: a builder always sets the field, so `[]` is an authoritative "references
  // nothing" and only a raw literal (tests, fallback shots) leaves it unset for declarations to
  // stand in for. Treating the two alike put an unplaced `asset()` back in the subject.
  const refs = shotDef.compositionRefs;
  const assets =
    refs !== undefined
      ? [...new Set(refs)]
      : Object.keys(shotDef.assets).map((name) => formatAddress(def.stage, shot.shotId, name));

  const leaves: string[] = [];
  if (shotDef.shotFn) leaves.push(formatCompositionAddress(def.stage, shot.shotId));
  for (const stem of listShotStems(def.stage, shotDef)) leaves.push(stem.address);

  return { assets, leaves };
}
