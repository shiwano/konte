---
name: arch-patch-guide
description: Read when touching patches — the chain a patch script declares and its address axis, the variant lineage and the leaf rule that decides what is reviewable, the two staleness axes of a patch variant, and the lifetime that ties a patch script to its source take.
user-invocable: false
---

How konte corrects a single generated take: the lineage a patch creates, and the invariants every surface reads it through.

## Why the variant, not the address

A local flaw belongs to one roll, not to the definition. The filename is the variant id, which makes "one script per take" a filesystem property.

The patched take is a new variant; the source is never overwritten, so a script can be refined indefinitely against the same image.

**A take a patch produced cannot be patched** (`assertPatchableTarget`) — neither the patched variant nor a step of its chain. A second fix is a step appended to the script that produced the take; a second script keyed to that variant would name a take its own source script replaces on the next apply. Refused by `patch new` and by both load paths, so the lineage is one level deep whatever wrote the file.

## The chain and its address axis

A patch's callback declares steps with the same `asset()` a stage file uses and returns one. **Every** step, the returned one included, is an ordinary generated asset at `<stage>:patch.<sourceVariantId>.<name>` — so a multi-step fix is ordinary graph work (jobs, variants, staleness). Addresses key off the step's NAME, not off which is returned, so appending a step leaves the ones before it and their takes reused.

- **Keyed by the source variant, not its address** — two variants at one address can each carry a patch, and both may name a step `patched`. The stage is the corrected take's, so a step is cleaned, pruned and grouped alongside it. `patch` is a reserved asset name: a reference asset's suffix is a bare name, so otherwise `reference:patch` would name both an asset and the axis.
- **An edit model reaches a stage only through here** — `allowedIn` names the `asset()` sites an adapter takes, and one that omits `shot`/`timeline` is refused in a stage file (`ADAPTER_OUT_OF_SCOPE`).
- **Declaration order is dependency order** — a step can only reference a handle that already exists, so a sequential walk never runs one before what it consumes.
- **A current step is reused, not respent on** — `currentPoolVariant` matches the step's definition hash, so editing one step re-runs only it and what follows. The source's address is judged against the **pinned take's own content**, not against what the address resolves to: otherwise every step would go input-stale the moment the patched take was accepted.
- **Reuse and the in-flight join ask one question: same work?** — a step whose upstream this run rebuilds is rebuilt too, since that address still resolves to the file being replaced until the job lands. A running job is joined on the same definition, and for the returned step the same `patchHash` on its finalize origin — else the chain is fed a version an edit replaced, or the correction lands under the previous script.
- **The returned step runs even when its take is current** — applying again is how another attempt is asked for. Unless its patched variant is missing (a crash, a `clean` that took the variant and left the take): re-deriving costs nothing, re-rolling would spend for a correction already made.
- **A step this run reserved is pinned for its consumers** — unpinned, a regenerated one would be bypassed for an older accepted take.
- **Validity is judged from the output backwards** — the loader walks the refs reachable from the returned step, requires `source` to be consumed in that closure, and rejects any step outside it. Checking that _some_ declaration mentions `source` would let an unrelated generation be recorded as `derivedFrom` that take; not checking reachability would pay for steps nothing consumes. A step consuming the returned one is rejected by name instead, since this check would call it "unconsumed".
- **A patch job's definition is loaded from the script, not from a stage** — `loadPatchStepDefinition` is what the pending-submit path uses. A step's address has no stage entry, so the ordinary lookup would find nothing; every patch job sits at a patch address, so the address alone identifies one. `inspect` resolves it the same way, and reads a step's edges from the chain (`patchStepDependents`) rather than the stage graph, which has no node for it.
- **The patch build carries a `format`** — a comfy step resolves `width`/`height`/`fps` against it, not adapter defaults: `size` is ffprobed off the take the output replaces, `fps`/`duration` the direction's.
- **Not review candidates** — nothing waits on a decision about a step; the next consumes whatever is ready. `status` skips the axis; `inspect` still shows it, and `konte accept` still pins one deliberately.

## The leaf rule

**A variant with a descendant is not a review candidate** — it is the "before" of the one that replaced it. Staleness, `status`, `inspect` and the preview server all read it through `isReviewLeaf`, so no surface re-derives it.

- **A correction is a rival take like any other** — undecided until its own `status` says otherwise. `patchedAwaitingReview` is tracked apart from the newer-take signal for its wording ("did the fix land?" against "is this better?"); it clears when the correction is accepted, dismissed by an accept of the take beside it, or dropped by `konte patch remove` — the reject route `status` names in its "Needs review" detail. Only a **non-stale** correction is review work (`isVariantStale`, both axes, as for any rival), since an accept beside it cannot dismiss a stale take; a stale one belongs to its script, under "Pending patches" — unless that script is gone, when it stays here routed to `prune`.
- **Multiple leaves per source are correct** — editing a script and re-applying yields two attempts at one fix, both candidates on one "before".

## Staleness: two axes

A patched variant **inherits** its source's `definitionHash` and input fingerprints, and carries its own `patchHash`.

- **Inherited definition hash** — an edit to the stage asset stales the whole lineage. Hashing the patch's own there would leave every patched take definition-stale from birth.
- **`patchHash`** — a patch script is the authored definition of what it produced, so editing it ages those out as editing `animatic.tsx` does. It covers **every step**, and hashes the parsed definitions rather than the file bytes, so reformatting triggers no paid re-apply.
- **Self-address fingerprint dropped, source's merged in** — a patch's source is pinned at its own address, so recording it would make the patched take input-stale against itself. Applied at materialization, to the patched variant alone: a step sits at its own address, so its source is an ordinary upstream.

"Pending patch" is one predicate — _no non-stale patched take_ — covering never applied, script edited, and input moved; `PendingPatch.reason` says which, for `status` to word, read off the takes the **current** script produced. **Inherited input-staleness does not count**: a correction is built from its source's file, so applying against a stale source buys another take stale from birth, every `generate`. That axis is the source's. A chain **in flight** counts as realized, asked of the STEP addresses — until the returned step lands, nothing at the source's address shows the apply, and re-running would double-spend.

A patched take has no job of its own, so **the accept cascade follows its file to the step that owns it** (`variantOwningFile`) for the provenance. Without it, an accept signs off on nothing and `clean` may take what the take was built from.

The chain leads back to the corrected take — matched by the root take's `derivedFrom`, never by "some other take here" — so the walk **passes through that take without accepting it** to reach what the correction rests on.

A patch reaches consumers when it becomes the resolved take — at once where nothing is accepted, only on accept where the original is — staling the direct ones for next run.

## Lifetime

A patch script names one take, so it dies with it, and a lineage is deleted as a unit — a dangling `derivedFrom` becomes possible the moment a path can cut one in the middle.

- **`clean`** — removes `patches/<variantId>.ts` with the variant, and keeps a variant whose descendants it is keeping. Protection travels **up** the lineage, deletion **down**.
- **An accepted descendant protects its ancestors** — the source file is still its input.
- **A variant directory holding another variant's file is kept** (`variantsHostedBy`) — the patched take points at the returned step's file, so dropping that step would leave a take (possibly the accepted one) with no bytes. Judged by path, so no field records it; asked of the survivors, so deleting both together still works. `clean` skips and names the take it holds; `prune` likewise for a scope naming one side only.
- **`prune`** — sweeps both orphan directions (script whose source is gone, output whose script is gone), expanding each stranded output through its descendants.
- **Chain steps are found from state, not from the script** — `patchChainTargets` reads them off the addresses, so a broken or deleted script still answers "what did this patch generate". `buildOrphanContext` judges the axis by whether `patches/<id>.ts` exists — **filename, never the module**, or a syntax error would read as "declaration gone" and take real variants with it. Renaming a step therefore strands its old address until `clean` targets it; `<stage>:patch.<variantId>` is a scope.
- **`patch remove`** — deletes the script, the patched variants **and the chain's own takes**, re-derived under the state lock. A step still generating blocks it: that job would otherwise register a patched variant for a patch that no longer exists. It also takes a hand-written `patches/<id>.ts` named after a patched variant.
- **`clean` holds back a take whose patch is applying** — the chain is pinned to it and the finalize reads it back, so cutting it would fail that commit and strand the job.

All three refuse a lineage or chain with an active job, re-checking on a fresh job listing inside the state lock (`patch remove` aborts, the others skip and report). The job list is outside that lock and a job file lands only after the reservation's releases, so a run starting in the same moment can slip through — hence the materialize survives it: a source gone by then is logged and skipped, never failing the step's own commit. `prune` is the recovery.

## Applying

The pipeline is generation's; the addition is the pin. A patch's `source` placeholder is the source variant's own address, so the pin names the take instead of whatever that address resolves to now, carried by every step since any of them may be the consumer. It **bypasses** resolution rather than overriding its result (`resolveJobDeps`), and waits only on its own producer: a pinned step goes input-stale the moment a later take lands at the source address, and stale-unaccepted resolves to nothing. Everything else the patch references resolves normally, as a real upstream.

The patched variant is **materialized**, not generated (`materializePatchOutput`): it points at the returned step's file and carries the lineage. Written by the waiter in the same lock that commits that step's take — separately, there would be a window with the correction on disk and nothing at the corrected address pointing at it — or by `applyPatch` when the take is already current. Idempotent per step take, recognized by its file.

- **Reservation re-checks for a rival under the state lock** — a concurrent `patch apply`/`generate` reserving the same step. The caller's join check ran on an unlocked snapshot; without this both runs would pay for one step. `applyPatch` supplies what counts as one, by the criterion it joined on: what it declined would abort the apply instead of queueing beside it.
- **The rival check narrows, it does not close** — it judges "in flight" from a job listing taken _before_ the lock, while the job file lands _after_ it releases, so two concurrent runs can each spend on one correction. Closing it means making reservation and job creation atomic, a change to the shared generation path. Until then, do not run two on one video.
- **Same spend gates as `generate`** — the direction gate per stage, and the backend gate across **every step** of the chain (checked directly; the stage-walking policy helper has no stage to walk).
- **Comfy prerequisites** — a comfy step resolves its declared `models`/`nodes` and goes pending behind the install jobs, with the pin carried as `pinnedDeps` to submit time. A step also goes pending behind the earlier steps' jobs, by the same mechanism.

`generate` applies pending patches after its dependency levels. The patched take is unaccepted unless the PATCH's own adapter is deterministic. The waiter cannot read that off a stage definition (a step's address has none), so it travels on the job as `patchFinalize`, along with a comfy step's output node and, on the returned step alone, the `output` target that materializes the patched variant. **Both submit paths replace job metadata wholesale**; `submitToBackend` is what carries `patchFinalize` across.

`selectResolvedVariant` ignores the patch axis, as it already ignores definition-staleness — it answers "what is the current take". An edited patch's old output stays what render/`ref` consume until re-applied; `status` is what asks for the re-apply.
