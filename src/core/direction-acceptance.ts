import {
  DIRECTION_NARRATOR_ADDRESS,
  DIRECTION_ROOT_PATH,
  DIRECTION_SECTIONS,
  type DirectionSection,
  directionChildNodePath,
  directionSectionOf,
  formatDirectionCharacterAddress,
  formatDirectionCharacterVoiceAddress,
  formatDirectionLocationAddress,
  formatDirectionPropAddress,
  formatDirectionSequenceAddress,
  formatDirectionSetupAddress,
  formatDirectionShotAddress,
  parseAddress,
} from "./address.js";
import type { Direction, DirectionNode } from "./dsl/direction.js";
import { isAsideShot, isGraphicShot } from "./dsl/direction.js";
import { directionHash, directionPartHashes } from "./direction-hash.js";
import type { DirectionAcceptance } from "./types/index.js";

// Reading the human's verdict on the direction out of state. Acceptance is per PART (one entry per
// address in `directionPartHashes`); this module is where that raw record meets a live direction and
// becomes an answer: is this part signed off, is the whole thing, and what does accepting a section
// write. The spend gate, `status`, `doctor` and the review page all come through here, so there is
// one definition of "accepted" rather than four comparisons that can drift apart.

// A part's standing against the live direction. `stale` and `unaccepted` both block the gate; they
// are told apart because they are different things to say to a person — one is "you never read
// this", the other "what you read has changed".
export type DirectionPartStatus = "accepted" | "stale" | "unaccepted";

// A section's standing: the weakest of its parts, since a box is signed off only when everything in
// it is. A section with no parts at all (an empty roster, a direction with no waivers) has nothing to
// review and reads as accepted — it is not a box the page shows.
export type DirectionSectionStatus = DirectionPartStatus;

// The sections whose sign-off no downstream media re-reads, so they are the ones the spend gate
// keeps demanding for the life of the piece. `brief` is an agreement between people that never
// enters generation; `policy.speech` and `waivers` are inputs to the machine check and appear in no
// frame; `policy.format` is the size and fps, where a mistake is expensive. Everything else — the
// shots, the arc, the rosters — reaches a human as a panel, a shot or a `reference:<id>` image, so
// once the piece has been signed off whole, the reviews of that media are the reading that counts.
const PIECE_WIDE_SECTIONS: ReadonlySet<DirectionSection> = new Set(["brief", "policy", "waivers"]);

// A deleted waiver owes no reader: removing one only puts its finding back in front of the machine
// check, so its orphaned sign-off neither blocks nor is kept.
function orphanOwesReview(address: string): boolean {
  return directionSectionOf(address) !== "waivers";
}

// The sections the spend gate is still waiting on — every one until the direction has been accepted
// whole, then only the piece-wide ones. The review page reads this to say which of its boxes hold a
// generation, since a box that no longer does still accepts and still shows what changed.
export function directionGatingSections(
  acceptance: DirectionAcceptance | null,
): DirectionSection[] {
  if (acceptance?.whole == null) return [...DIRECTION_SECTIONS];
  return DIRECTION_SECTIONS.filter((s) => PIECE_WIDE_SECTIONS.has(s));
}

interface DirectionAcceptanceView {
  // Every live part, keyed by address — the part set, so a caller never re-derives it.
  parts: Map<string, DirectionPartStatus>;
  sections: Map<DirectionSection, DirectionSectionStatus>;
  // True when every live part is accepted at its current hash and no accepted part has since been
  // deleted. This is what the review page and `status` report, NOT what the spend gate asks.
  complete: boolean;
  // Every part short of that, in part-set order — what to name to a person reading the page.
  blocking: { address: string; status: "stale" | "unaccepted" }[];
  // Recorded sign-offs for parts since deleted that still owe a reader (`orphanOwesReview`).
  orphans: string[];
  // The spend gate's question, and the parts holding it shut. Before the direction has been accepted
  // as a whole even once these are `complete`/`blocking` exactly; after that they narrow to
  // `PIECE_WIDE_SECTIONS`.
  gateSatisfied: boolean;
  gateBlocking: { address: string; status: "stale" | "unaccepted" }[];
}

function partStatus(
  address: string,
  liveHash: string,
  acceptance: DirectionAcceptance | null,
): DirectionPartStatus {
  const accepted = acceptance?.parts[address];
  if (!accepted) return "unaccepted";
  return accepted.partHash === liveHash ? "accepted" : "stale";
}

// The weakest status wins: a box holding one rewritten shot is not a signed-off box.
function weakest(statuses: readonly DirectionPartStatus[]): DirectionSectionStatus {
  if (statuses.includes("unaccepted")) return "unaccepted";
  if (statuses.includes("stale")) return "stale";
  return "accepted";
}

export function directionAcceptanceView(
  direction: Direction,
  acceptance: DirectionAcceptance | null,
): DirectionAcceptanceView {
  const live = directionPartHashes(direction);
  const parts = new Map<string, DirectionPartStatus>();
  const blocking: DirectionAcceptanceView["blocking"] = [];
  for (const [address, liveHash] of live) {
    const status = partStatus(address, liveHash, acceptance);
    parts.set(address, status);
    if (status !== "accepted") blocking.push({ address, status });
  }

  // An accepted part that is no longer in the live set was DELETED since it was signed off — the
  // direction the human accepted is not this one, so the gate must re-block even though nothing in
  // the live set is unaccepted. Dropping a brief field or a character is exactly this case: it
  // removes a key rather than changing one, and comparing only live parts would wave it through.
  const orphanAddresses = Object.keys(acceptance?.parts ?? {}).filter(
    (address) => !live.has(address) && orphanOwesReview(address),
  );
  const orphans = new Set<DirectionSection>(orphanAddresses.map(directionSectionOf));

  const bySection = new Map<DirectionSection, DirectionPartStatus[]>(
    DIRECTION_SECTIONS.map((s) => [s, []]),
  );
  for (const [address, status] of parts) {
    bySection.get(directionSectionOf(address))?.push(status);
  }
  // A section's own orphan counts against IT, not just against the whole. Only the box that owns an
  // orphan can drop it, so a box reading "accepted" while its orphan holds the gate shut is a dead
  // end: the reviewer is told to re-accept and shown nothing to re-accept. This is also what makes
  // a section that lost ALL its live parts (the last character cut) reachable — it is not
  // "accepted", so the page still gives it a box to clear.
  const sections = new Map<DirectionSection, DirectionSectionStatus>(
    [...bySection].map(([section, statuses]) => [
      section,
      weakest(orphans.has(section) ? [...statuses, "stale"] : statuses),
    ]),
  );

  // Before the whole direction has been accepted once, the gate is the full comparison: nothing
  // downstream exists yet to have read any of it, so the first read is the only read.
  const unlocked = acceptance?.whole != null;
  const gateBlocking = unlocked
    ? blocking.filter((b) => PIECE_WIDE_SECTIONS.has(directionSectionOf(b.address)))
    : blocking;
  const gateOrphans = unlocked
    ? [...orphans].filter((s) => PIECE_WIDE_SECTIONS.has(s))
    : [...orphans];

  return {
    parts,
    sections,
    complete: blocking.length === 0 && orphans.size === 0,
    blocking,
    orphans: orphanAddresses,
    gateSatisfied: gateBlocking.length === 0 && gateOrphans.length === 0,
    gateBlocking,
  };
}

// The direction's acceptance, summarized for a reader (`status`, `doctor`). Acceptance is per part,
// so the middle state is not "the direction is stale" but "some of it is settled and some is not" — a
// part rewritten since it was accepted and a part never read both block, and both land in the count.
// `unaccepted` is the distinct case where nothing has been signed off at all, which reads differently
// to a person: they have a review ahead of them, not a correction.
export type DirectionAcceptanceStatus = "accepted" | "partial" | "unaccepted";

export type DirectionAcceptanceSummary = {
  status: DirectionAcceptanceStatus;
  // How many parts still need a human, out of how many the direction has. The count is the point of
  // the per-part gate: "re-accept the direction" hides whether that is one shot or forty.
  blocking: number;
  total: number;
  // How many of those hold the spend gate shut. The two differ once the direction has been accepted
  // whole: a rewritten shot is still worth reporting, but it no longer stops a generation, so a
  // reader is told what changed without being told to go clear it.
  gateBlocking: number;
};

export function summarizeDirectionAcceptance(
  direction: Direction,
  acceptance: DirectionAcceptance | null,
): DirectionAcceptanceSummary {
  const view = directionAcceptanceView(direction, acceptance);
  const total = view.parts.size;
  // A deleted part blocks but is not a live part, so it cannot be counted in `blocking` (which is
  // out of `total`). Report it as one thing left to do — the page it sits on is the one the reviewer
  // has to re-read either way.
  const blocking = view.complete ? 0 : Math.max(view.blocking.length, 1);
  const gateBlocking = view.gateSatisfied ? 0 : Math.max(view.gateBlocking.length, 1);
  const anyAccepted = [...view.parts.values()].some((s) => s !== "unaccepted");
  return {
    status: view.complete ? "accepted" : anyAccepted ? "partial" : "unaccepted",
    blocking,
    total,
    gateBlocking,
  };
}

// The spend gate's question, answered without walking the tree when it can be: `whole.hash` is
// stamped only while `parts` covers the live set exactly, and `projectDirection` subsumes every part
// hash, so a matching whole-direction hash means no part has moved since. A mismatch proves nothing
// on its own (any edit changes it, including one to a part already re-accepted), so it falls through
// to the full comparison rather than reporting a verdict.
//
// The parts are the verdict; `whole` only summarizes them. No writer can leave a hash standing on an
// empty `parts` — emptying the record clears `whole` outright — but a hand-edited state can, and
// trusting it would open the gate on a verdict no human gave.
export function isDirectionSpendGateSatisfied(
  direction: Direction,
  acceptance: DirectionAcceptance | null,
): boolean {
  if (!acceptance) return false;
  if (
    acceptance.whole?.hash != null &&
    Object.keys(acceptance.parts).length > 0 &&
    acceptance.whole.hash === directionHash(direction)
  ) {
    return true;
  }
  return directionAcceptanceView(direction, acceptance).gateSatisfied;
}

// A reviewer's verdict on one box: accept it (sign off every part it holds, at its live hash) or
// reject it (revoke them, so the gate re-blocks on that box). A section the reviewer left alone is
// absent — not `false` — since "I did not look at the characters" must not revoke last week's sign-off.
export type DirectionSectionDecisions = Partial<Record<DirectionSection, boolean>>;

// Apply a review's section decisions to the acceptance record. A section's verdict settles that box
// wholesale, so it also drops the box's ORPHANS — an accepted part that no longer exists, e.g. the
// lingering sign-off of a character that was cut. Only the decided box's orphans, though: a deletion
// elsewhere is something a human has yet to read, and clearing its block from a different box's
// button would sign off on their behalf.
//
// `whole` is re-derived through `finalizeAcceptance` like every other writer, so the short-circuit
// cannot outlive the verdict it summarizes.
export function applyDirectionSectionDecisions(
  direction: Direction,
  acceptance: DirectionAcceptance | null,
  decisions: DirectionSectionDecisions,
  now: Date = new Date(),
): DirectionAcceptance {
  const live = directionPartHashes(direction);
  const acceptedAt = now.toISOString();
  const parts: DirectionAcceptance["parts"] = {};
  const decisionFor = (address: string) => decisions[directionSectionOf(address)];

  for (const [address, prior] of Object.entries(acceptance?.parts ?? {})) {
    // Undecided keeps its prior sign-off (orphans included, for `finalizeAcceptance` to rule on);
    // decided is rewritten below, and rejected is simply not carried over.
    if (decisionFor(address) === undefined) parts[address] = prior;
  }
  for (const [address, liveHash] of live) {
    if (decisionFor(address) !== true) continue;
    parts[address] = { partHash: liveHash, acceptedAt };
  }

  return finalizeAcceptance(direction, parts, live, acceptance, acceptedAt).acceptance;
}

// A verdict on one part, keyed by its address: true stamps it at its live hash, false drops its
// record — a live part's sign-off, or an orphan's. An address absent from the map is untouched, the
// same "I did not look at this" the section decisions carry.
type DirectionPartDecisions = ReadonlyMap<string, boolean>;

// The section `konte accept` never signs off. A waiver is the author overriding a machine finding,
// so it is the one part whose review is the finding sitting next to it — and the one part a blind
// CLI accept must not settle. It stays in `konte preview direction`, where the reviewer sees what
// the waiver silences. Revoking one is safe from anywhere: it only ever re-blocks.
export const CLI_UNACCEPTABLE_SECTION: DirectionSection = "waivers";

// The third writer, and the CLI's: acceptance decided per PART rather than per section, so
// `konte accept direction:<part>` can settle exactly the shot it names. The section writer above is
// the review page's, where a box is the unit a human reads; here the caller has already named the
// address, so there is no box to widen to.
//
// Orphans are not special-cased — an orphan address decided `false` is dropped like any other
// record, which is how the CLI clears one (`konte accept <orphan> --off`). What that costs versus
// the section writer's automatic orphan sweep is that the caller must name them; what it buys is
// that nothing is dropped the caller did not ask for.
//
// `whole` is re-derived through `finalizeAcceptance` like every other writer, so the short-circuit
// cannot outlive the verdict it summarizes.
export function applyDirectionPartDecisions(
  direction: Direction,
  acceptance: DirectionAcceptance | null,
  decisions: DirectionPartDecisions,
  now: Date = new Date(),
): { acceptance: DirectionAcceptance; accepted: string[]; revoked: string[] } {
  const live = directionPartHashes(direction);
  const parts = { ...(acceptance?.parts ?? {}) };
  const acceptedAt = now.toISOString();
  const accepted: string[] = [];
  const revoked: string[] = [];

  for (const [address, decision] of decisions) {
    if (decision) {
      const liveHash = live.get(address);
      // Not a live part (a cut shot, a typo'd address) — an accept resurrects nothing. Already
      // signed off at this exact hash — nothing moved, so it is not reported as a fresh accept.
      if (liveHash === undefined || parts[address]?.partHash === liveHash) continue;
      parts[address] = { partHash: liveHash, acceptedAt };
      accepted.push(address);
    } else {
      if (!(address in parts)) continue;
      delete parts[address];
      revoked.push(address);
    }
  }

  return {
    acceptance: finalizeAcceptance(direction, parts, live, acceptance, acceptedAt).acceptance,
    accepted,
    revoked,
  };
}

// The direction parts a stage review can settle on a shot's behalf, keyed by shot id: the shot's own
// part, the sequence parts bracketing it — its act, its act's act, up to the root — and the `setups`
// part of the frame it is taken from. The arc tree hangs a shot on the first two, and a
// animatic/video accept re-reads them (the reviewer is looking at that shot inside that act); the
// third is here because the shot's size and place live on its setup, so the picture the reviewer
// accepted IS that frame, and the identity rosters' route — a `reference:<id>` accept — does not
// exist for a setup. Without it a setup edit could never be re-signed downstream and `complete` would
// stay out of reach for a finished piece. Everything else — the brief, the policy, the identity
// rosters, the waivers — is a piece-wide agreement or has its own media, so it never appears here. A
// node with no `id` contributes no part (see `directionPartHashes`), so its address is filtered out
// by the live-part lookup rather than special-cased.
export function directionShotCascadeTargets(direction: Direction): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (node: DirectionNode, nodePath: readonly string[], ancestors: readonly string[]) => {
    const chain = [...ancestors, formatDirectionSequenceAddress(nodePath)];
    if (Array.isArray(node.shots)) {
      for (const s of node.shots) {
        // An aside signs off only itself: it names no setup, and it is no item of the arc it sits
        // in, so it carries neither the setup nor the act chain a narrative shot's accept does.
        out.set(
          s.id,
          isAsideShot(s)
            ? [formatDirectionShotAddress(nodePath, s.id)]
            : [
                formatDirectionShotAddress(nodePath, s.id),
                ...(isGraphicShot(s) ? [] : [formatDirectionSetupAddress(s.setup)]),
                ...(s.cutin ? [formatDirectionSetupAddress(s.cutin.setup)] : []),
                ...chain,
              ],
        );
      }
      return;
    }
    for (const c of node.sequences ?? []) {
      walk(c, directionChildNodePath(nodePath, c.id ?? ""), chain);
    }
  };
  walk(direction.sequence, DIRECTION_ROOT_PATH, []);
  return out;
}

// The shots a set of just-accepted asset addresses signs off. A `reference:` asset belongs to no
// shot, and a timeline asset spans them all, so only a stage's shot-scoped address counts.
export function directionCascadeShotIds(addresses: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const address of addresses) {
    try {
      const parsed = parseAddress(address);
      if (parsed.kind !== "shot") continue;
      if (parsed.stage !== "animatic" && parsed.stage !== "video") continue;
      out.add(parsed.shotId);
    } catch {
      // Not a parseable asset address (a bare feedback target, say) — it accepts nothing.
    }
  }
  return out;
}

// The direction parts each reference asset id anchors: `reference:<id>` is the media a
// `characters`/`props`/`locations` entry — or a cast voice — is reviewed against, so accepting it
// re-reads those parts' prose. A roster id anchors exactly one part (the three rosters share the
// namespace, and a collision is a structural error), but a cast voice id may be shared — one sample
// for a narrator who is the protagonist, or for twins — so an id maps to a LIST. A voice anchors its
// own part, never the character's look: accepting a voice sample says nothing about the image.
function directionReferenceCascadeTargets(direction: Direction): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, address: string) => {
    const existing = out.get(id);
    if (existing) existing.push(address);
    else out.set(id, [address]);
  };
  for (const [id, c] of Object.entries(direction.characters ?? {})) {
    add(id, formatDirectionCharacterAddress(id));
    if (c.voice) add(c.voice.id, formatDirectionCharacterVoiceAddress(id));
  }
  if (direction.narrator) add(direction.narrator.id, DIRECTION_NARRATOR_ADDRESS);
  for (const id of Object.keys(direction.props ?? {})) add(id, formatDirectionPropAddress(id));
  for (const id of Object.keys(direction.locations ?? {})) {
    add(id, formatDirectionLocationAddress(id));
  }
  return out;
}

// The reference asset ids a set of just-accepted asset addresses signs off — the mirror of
// `directionCascadeShotIds` for the reference stage. Only a `reference:<name>` address counts; a
// stage shot/timeline asset anchors no roster entry.
export function directionCascadeReferenceIds(addresses: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const address of addresses) {
    try {
      const parsed = parseAddress(address);
      if (parsed.kind === "reference") out.add(parsed.assetName);
    } catch {
      // Not a parseable asset address — it accepts nothing.
    }
  }
  return out;
}

// Carry a stage review's sign-off back to the direction. A shot's `action`, `script`, `duration` and
// the size/place its `setup` carries are the words the animatic/video review renders as pictures and sound,
// so a human accepting that media has judged them more directly than they could on the direction
// page — re-reading the same shot there to un-block the spend gate is a loop with no reviewer in it.
//
// Which parts it may sign off turns on R1 (`restampDirectionParts`). What the machine check keeps
// for itself either way are the arc claims hidden inside a sequence — a rewritten `role` or `lens` —
// since those re-shape the findings `assertDirectionGate` reads.
//
// Returns the input record untouched when nothing moved, so a caller can skip the write.
export function applyDirectionShotCascade(
  direction: Direction,
  acceptance: DirectionAcceptance | null,
  shotIds: Iterable<string>,
  now: Date = new Date(),
): { acceptance: DirectionAcceptance | null; restamped: string[] } {
  if (!acceptance) return { acceptance, restamped: [] };
  const targets = directionShotCascadeTargets(direction);
  const addresses: string[] = [];
  for (const shotId of shotIds) {
    for (const address of targets.get(shotId) ?? []) addresses.push(address);
  }
  return restampDirectionParts(direction, acceptance, addresses, now);
}

// The reference-stage twin of the shot cascade: accepting a `reference:<id>` image re-reads the
// roster entry it anchors (`direction:characters/props/locations.<id>`), so its prose is signed off
// where the reviewer actually looks at it. R1 matters most here — the reference stage is exempt from
// the direction gate, so a fresh project can generate and accept a character image before anyone has
// opened `konte preview direction`, and without the guard that first read would arrive already
// stamped.
export function applyDirectionReferenceCascade(
  direction: Direction,
  acceptance: DirectionAcceptance | null,
  referenceIds: Iterable<string>,
  now: Date = new Date(),
): { acceptance: DirectionAcceptance | null; restamped: string[] } {
  if (!acceptance) return { acceptance, restamped: [] };
  const targets = directionReferenceCascadeTargets(direction);
  const addresses: string[] = [];
  for (const id of referenceIds) {
    addresses.push(...(targets.get(id) ?? []));
  }
  return restampDirectionParts(direction, acceptance, addresses, now);
}

// The shared restamp both cascades run: sign off each named part at its live hash. An address not in
// the live set (a cut shot) is skipped, so a cascade never resurrects; an unchanged part is skipped
// because nothing was re-decided.
//
// R1 is the guard on a part with NO prior sign-off, and it holds only until the direction has been
// accepted whole. Until then nothing downstream has been reviewed, so a first read is the human's
// alone and no accept can stand in for it. After it, the reviews of the media ARE the reading, so a
// never-read part is stamped like any other.
//
// The guard keys on the ADDRESS, konte's identity for a shot, so a cut shot's id reused by a new one
// inherits that id's sign-off — a human accepted the media that now plays there.
function restampDirectionParts(
  direction: Direction,
  acceptance: DirectionAcceptance,
  addresses: Iterable<string>,
  now: Date,
): { acceptance: DirectionAcceptance | null; restamped: string[] } {
  const live = directionPartHashes(direction);
  const parts = { ...acceptance.parts };
  const acceptedAt = now.toISOString();
  const restamped: string[] = [];
  const mayStampUnread = acceptance.whole != null;

  for (const address of addresses) {
    const liveHash = live.get(address);
    if (liveHash === undefined) continue;
    const prior = parts[address];
    if (prior ? prior.partHash === liveHash : !mayStampUnread) continue;
    parts[address] = { partHash: liveHash, acceptedAt };
    restamped.push(address);
  }

  const finalized = finalizeAcceptance(direction, parts, live, acceptance, acceptedAt);
  if (restamped.length === 0 && finalized.swept.length === 0) {
    return { acceptance, restamped: [] };
  }
  return { acceptance: finalized.acceptance, restamped };
}

// The step every writer ends on: sweep what the record should no longer hold, then re-derive the
// whole-direction verdict from what is left.
//
// The sweep drops ORPHANS — records for parts that no longer exist — in the sections the gate has
// stopped reading, since leaving one would keep `complete` false forever and a finished piece could
// never show a clean direction page. The gated sections keep theirs, where losing a brief field or a
// policy rule is a change a human still has to sign. A waiver's orphan is swept always
// (`orphanOwesReview`).
function finalizeAcceptance(
  direction: Direction,
  parts: DirectionAcceptance["parts"],
  live: ReadonlyMap<string, string>,
  prior: DirectionAcceptance | null,
  acceptedAt: string,
): { acceptance: DirectionAcceptance; swept: string[] } {
  const swept: string[] = [];
  for (const address of Object.keys(parts)) {
    if (live.has(address)) continue;
    const keep =
      orphanOwesReview(address) &&
      (prior?.whole == null || PIECE_WIDE_SECTIONS.has(directionSectionOf(address)));
    if (keep) continue;
    delete parts[address];
    swept.push(address);
  }

  // Emptying the record is the one way back to "never accepted": every sign-off a human made is
  // gone, so the whole-direction verdict standing on them cannot survive either.
  if (Object.keys(parts).length === 0) return { acceptance: { parts, whole: null }, swept };

  const covers =
    [...live].every(([address, liveHash]) => parts[address]?.partHash === liveHash) &&
    Object.keys(parts).every((address) => live.has(address));
  const whole = covers
    ? { hash: directionHash(direction), acceptedAt: prior?.whole?.acceptedAt ?? acceptedAt }
    : prior?.whole
      ? { hash: null, acceptedAt: prior.whole.acceptedAt }
      : null;

  return { acceptance: { parts, whole }, swept };
}
