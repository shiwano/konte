# The media → direction cascades

How an animatic/video/reference accept carries its sign-off sideways into the direction.

## Shot cascade

`applyDirectionShotCascade`: `directionShotCascadeTargets` maps each shot id to the parts its arc hangs on — its own `shots.<id>` part, the `setups.<id>` of the frame it is taken from, then every sequence part bracketing it up to the root — and each accepted shot restamps that chain. Callers reach it through `cascadeDirectionShotAccepts` (`accept-cascade.ts`), deriving the shot ids from the addresses they just accepted with `directionCascadeShotIds`; the wired sites are `konte accept` and the animatic/video review submits, each recording the restamped parts on the review's `cascadeAccepted` (`review record show` renders them as `direction:… (via video:shot.03)`).

**R1 — a part with no prior sign-off is stamped only after the direction has been accepted whole** (`acceptance.whole != null`; see the acceptance section of the SKILL). Before that, the reference stage — exempt from the direction gate — can accept a character image before anyone opens `konte preview direction`. After it, a shot added mid-production is settled by the panel and the shot that realize it.

R1 keys on the **address**, konte's identity for a shot, so reusing a cut shot's id inherits that id's sign-off.

The cascade does **not** guard an arc claim hidden inside an unchanged sequence — a rewritten `role` or `lens`, which no frame shows — because those re-shape the findings `assertDirectionGate` reads. Nor does an un-accept revoke a cascaded part.

A cascade write also **sweeps orphans** outside `brief`/`policy` once `whole` stands (a waiver's at any time) — `finalizeAcceptance`'s, shared with the other two writers. So a cascade's write can have an empty `restamped` and still be a change: `cascadeDirection*Accepts` persists on record identity, never on `restamped.length`.

## Reference cascade

`applyDirectionReferenceCascade` is the same move for the rosters, whose media is a reference asset rather than a shot: `directionReferenceCascadeTargets` maps each `reference:<id>` to the parts it anchors — one for a roster entry (the three identity rosters share the id namespace, so at most one; `setups` is absent — a setup anchors to an animatic plate, so its part rides the shot cascade above instead), but a list for a cast voice, which two members may share — and accepting that media restamps all of them. A cast voice sample anchors its **own** part(s) (`characters.<id>.voice`, `narrator`), never the character's look. Callers reach it through `cascadeDirectionReferenceAccepts` / `directionCascadeReferenceIds`; the wired sites are `konte accept` and the reference review submit, recorded on `cascadeAccepted` (`direction:props.paperBag (via reference:paperBag)`). Both cascades share one restamp core, `restampDirectionParts`.

`konte accept` passes the graph-cascaded deps too (`[address, ...cascaded]`), so accepting a downstream asset can restamp a roster entry whose image was accepted as a consumed dep and whose prose was never shown. Don't narrow it: the shot that consumes the reference is where the entry is judged.

The reference card prints the part's name and description beside the media — for a voice sample, the voice brief rather than the character's visual one (`referenceRosterEntries` → `ReferenceAssetInfo.directionRoster` → `RosterCard`) and carries the part's `needsReview`. The accept decision is otherwise keyed on the variant, so prose reworded under an unchanged, already-accepted image would send no decision at all; `reacceptIsMeaningful` (`pages/preview/review/reference-decisions.ts`) adds `needsReview` to that test, read by both the row's Accept affordance and the decision. Only decisions that actually applied reach the cascade (`appliedAccepts`).

Parts outside the arc tree and the rosters (brief, policy, waivers) are piece-wide agreements no single asset's media speaks for, and never cascade.
