# The media → direction cascades

How an animatic/video/reference accept carries its sign-off sideways into the direction.

## Shot cascade

`applyDirectionShotCascade`: `directionShotCascadeTargets` maps each shot id to the parts its arc hangs on — its `shots.<id>` part, the `setups.<id>` of its frame, every sequence part bracketing it up to the root, the roster entries it declares (`shotRosterTargets`), then its waivers (`directionShotWaivers`, shown in the reel) — and each accepted shot restamps that chain. Callers go through `cascadeDirectionShotAccepts` (`accept-cascade.ts`), deriving the shot ids from the addresses just accepted with `directionCascadeShotIds`; the wired sites are `konte accept` and the animatic/video review submits, each recording the restamped parts on the review's `cascadeAccepted` (`review record show` renders `direction:… (via video:shot.03)`).

`shotRosterTargets` reads the direction alone, never the graph: the `locations` entry of each frame's setup (`shotFrames`, so a cutin's too), the `characters` a `lineup` / `lineupTo` holds, `characters.<id>.voice` for a `{ character }` line's speaker, `narrator` for a `{ narration }` line, and a `props` entry whose `name` is a literal substring of the `action` (the `unused-prop` rule). A roster entry reworded under an already-accepted image makes nothing stale, so the next accept of a shot declaring it re-signs it; one no later accept reaches stays `stale` and holds no spend.

- R1 — a part with no prior sign-off is stamped only once `acceptance.whole != null`. Before that, the reference stage (exempt from the direction gate) can accept a character image before anyone opens `konte preview direction`; after, a shot added mid-production is settled by the panel and the shot that realize it.
- R1 keys on the address, so reusing a cut shot's id inherits that id's sign-off.
- Unguarded: an arc claim hidden inside an unchanged sequence — a rewritten `role` or `lens`, which no frame shows — since those re-shape the findings the spend gate reads. An un-accept revokes no cascaded part.
- A cascade write also sweeps orphans outside the piece-wide sections once `whole` stands (a waiver's at any time) — `finalizeAcceptance`'s, shared with the other writers. So a write with an empty `restamped` can still be a change: `cascadeDirection*Accepts` persists on record identity, never on `restamped.length`.

## Reference cascade

`applyDirectionReferenceCascade` is the same move for the rosters, whose media is a reference asset: `directionReferenceCascadeTargets` maps each `reference:<id>` to the parts it anchors — at most one roster entry (the three identity rosters share the id namespace; `setups` is absent), but a list for a cast voice two members may share — and accepting that media restamps all of them. A voice sample anchors its own part(s) (`characters.<id>.voice`, `narrator`), never the character's look. Callers go through `cascadeDirectionReferenceAccepts` / `directionCascadeReferenceIds`; the wired sites are `konte accept` and the reference review submit, recorded on `cascadeAccepted` (`direction:props.paperBag (via reference:paperBag)`). Both cascades share one restamp core, `restampDirectionParts`.

`konte accept` passes the graph-cascaded deps too (`[address, ...cascaded]`), so accepting a downstream asset can restamp a roster entry whose image was accepted as a consumed dep and whose prose was never shown. Don't narrow it: the shot consuming the reference is where the entry is judged.

The reference card prints the part's name and description beside the media — for a voice sample, the voice brief, not the visual one (`referenceRosterEntries` → `ReferenceAssetInfo.directionRoster` → `RosterCard`) — and carries the part's `needsReview`. The accept decision is otherwise keyed on the variant, so prose reworded under an unchanged, already-accepted image would send no decision; `reacceptIsMeaningful` (`pages/preview/review/reference-decisions.ts`) adds `needsReview` to that test, read by both the row's Accept affordance and the decision. Only decisions that applied reach the cascade (`appliedAccepts`).

Brief, policy, lyrics and a waiver on no shot never cascade.
