---
name: arch-patch-guide
description: Read when touching patches — the chain a patch script declares and its address axis, the variant lineage and the leaf rule that decides what is reviewable, the two staleness axes of a patch variant, and the lifetime that ties a patch script to its source take.
user-invocable: false
---

How konte corrects a single generated take: the lineage a patch creates, and the invariants every surface reads it through.

## Keyed to the variant

- The script is named after one take's variant id — one script per take.
- The patched take is a new variant; the source is never overwritten, so a script can be refined against the same image.
- A take a patch produced cannot be patched (`assertPatchableTarget`) — neither the patched variant nor a step of its chain. Refused by `patch new` and both load paths, so the lineage is one level deep.
- A second fix is a step appended to the script that produced the take — that script replaces the patched take on its next apply.

## The chain and its address axis

A patch's callback declares steps with the same `asset()` a stage file uses and returns one. Every step, the returned one included, is an ordinary generated asset (jobs, variants, staleness) at `<stage>:patch.<sourceVariantId>.<name>`.

- A step's address keys off its name — appending a step reuses the ones before it and their takes.
- Keyed by the source variant — two variants at one address can each carry a patch, both naming a step `patched`.
- The stage is the corrected take's — a step is cleaned, pruned and grouped alongside it.
- `patch` is a reserved asset name — a reference asset's suffix is a bare name, so `reference:patch` would otherwise name both an asset and the axis.
- An edit model reaches a stage only through a patch — `allowedIn` names the `asset()` sites an adapter takes, and one that omits `shot`/`timeline` is refused in a stage file (`ADAPTER_OUT_OF_SCOPE`).
- Declaration order is dependency order — a step can only reference a handle that already exists.
- A current step is reused — `currentPoolVariant` matches the step's definition hash, so editing one step re-runs only it and what follows.
- The source's address is judged against the pinned take's own content, not what it resolves to — else every step would go input-stale once the patched take was accepted.
- Reuse and the in-flight join ask one question: same work? A step whose upstream this run rebuilds is rebuilt too — that address resolves to the file being replaced until the job lands. A running job is joined on the same definition, and for the returned step the same `patchHash` on its finalize origin — else the correction lands under the previous script.
- The returned step runs even when its take is current — applying again asks for another attempt. When its patched variant is missing (a crash, a `clean` that took the variant and left the take), it is re-derived instead of re-rolled.
- `reroll` of a step rolls from there — `rerollStep` marks it rebuilt, so its consumers follow; the script is unchanged, so the corrections share one `patchHash` and stay rivals.
- A step this run reserved is pinned for its consumers — unpinned, a regenerated one would be bypassed for an older accepted take.
- Validity is judged from the output backwards — the loader walks the refs reachable from the returned step, requires `source` in that closure, and rejects any step outside it; else an unrelated generation could be recorded as `derivedFrom` the take, or a step nothing consumes be paid for. A step consuming the returned one is rejected by name.
- A patch job's definition is loaded from the script (`loadPatchStepDefinition`, on the pending-submit path) — a step's address has no stage entry, and the patch address alone identifies a patch job. `inspect` resolves it the same way and reads a step's edges from the chain (`patchStepDependents`).
- The patch build carries a `format` — a comfy step resolves `width`/`height`/`fps` against it, not adapter defaults: `size` is ffprobed off the take the output replaces, `fps`/`duration` the direction's.
- Steps are not review candidates — the next step consumes whatever is ready. `status` skips the axis; `inspect` still shows it, and `konte accept` still pins one.

## The leaf rule

A variant with a descendant is not a review candidate — it is the "before" of the one that replaced it. Staleness, `status`, `inspect` and the preview server all read it through `isReviewLeaf`.

- A correction is a rival take like any other.
- `patchedAwaitingReview` is tracked apart from the newer-take signal for its wording ("did the fix land?" against "is this better?"). It clears when the correction is accepted, dismissed by an accept of the take beside it, or dropped by `konte patch remove` — the reject route `status` names in its "Needs review" detail.
- Only a non-stale correction is review work (`isVariantStale`, both axes) — an accept beside it cannot dismiss a stale take. A stale one is listed under "Pending patches"; when its script is gone it stays under "Needs review", routed to `prune`.
- Multiple leaves per source are correct — editing a script and re-applying yields two attempts at one fix, both candidates on one "before".

## Staleness: two axes

A patched variant inherits its source's `definitionHash` and input fingerprints, and carries its own `patchHash`.

- Inherited definition hash — an edit to the stage asset stales the whole lineage. Hashing the patch's own there would leave every patched take definition-stale from birth.
- `patchHash` — editing a patch script ages out what it produced, as editing `animatic.tsx` does. It covers every step and hashes the parsed definitions, not the file bytes — reformatting triggers no paid re-apply.
- Self-address fingerprint dropped, source's merged in — the source is pinned at the patched take's own address, so recording it would make the take input-stale against itself. Applied at materialization, to the patched variant alone; a step's source is an ordinary upstream.

"Pending patch" is one predicate: no non-stale patched take.

- It covers never applied, script edited, and input moved; `PendingPatch.reason` says which, for `status` to word, read off the takes the current script produced.
- Inherited input-staleness does not count — applying against a stale source buys another take stale from birth, every `generate`. That axis is the source's.
- A chain in flight counts as realized, asked of the step addresses — until the returned step lands nothing at the source's address shows the apply, and re-running would double-spend.

Accept and resolution:

- The accept cascade follows a patched take's file to the step that owns it (`variantOwningFile`) for provenance — a patched take has no job of its own; without it an accept signs off on nothing and `clean` may take what the take was built from.
- The walk passes through the corrected take without accepting it, to reach what the correction rests on — matched by the root take's `derivedFrom`, never by "some other take here".
- A patch reaches consumers when it becomes the resolved take — at once where nothing is accepted, only on accept where the original is — staling the direct ones for next run.

## Lifetime

A patch script names one take and dies with it; a lineage is deleted as a unit — a path that cuts one in the middle leaves a dangling `derivedFrom`.

- `clean` removes `patches/<variantId>.ts` with the variant, and keeps a variant whose descendants it is keeping. Protection travels up the lineage, deletion down.
- An accepted descendant protects its ancestors — the source file is still its input.
- A variant directory holding another variant's file is kept (`variantsHostedBy`) — the patched take points at the returned step's file. Judged by path, so no field records it; asked of the survivors, so deleting both together still works. `clean` skips and names the take it holds; `prune` likewise for a scope naming one side only.
- `prune` sweeps both orphan directions (script whose source is gone, output whose script is gone), expanding each stranded output through its descendants.
- Chain steps are found from state (`patchChainTargets` reads the addresses) — a broken or deleted script still answers what the patch generated.
- `buildOrphanContext` judges the axis by whether `patches/<id>.ts` exists, never by loading the module — a syntax error would read as "declaration gone" and take real variants with it.
- A renamed step strands its old address until `clean` targets it; `<stage>:patch.<variantId>` is a scope.
- `patch remove` deletes the script, the patched variants and the chain's own takes, re-derived under the state lock. A step still generating blocks it. It also takes a hand-written `patches/<id>.ts` named after a patched variant.
- `clean` holds back a take whose patch is applying — the chain is pinned to it and the finalize reads it back.
- `clean`, `prune` and `patch remove` refuse a lineage or chain with an active job, re-checking on a fresh job listing inside the state lock (`patch remove` aborts, the others skip and report).
- A run starting in the same moment can slip through — the job list is outside that lock and a job file lands only after the reservation's releases. The materialize tolerates it: a source gone by then is logged and skipped, never failing the step's own commit. `prune` is the recovery.

## Applying

The pipeline is generation's, plus the pin.

- A patch's `source` placeholder is the source variant's own address; the pin names the take instead of what that address resolves to now, carried by every step since any may be the consumer.
- The pin bypasses resolution instead of overriding its result (`resolveJobDeps`) and waits only on its own producer — a pinned step goes input-stale the moment a later take lands at the source address, and stale-unaccepted resolves to nothing.
- Everything else the patch references resolves normally, as a real upstream.
- The patched variant is materialized, not generated (`materializePatchOutput`): it points at the returned step's file and carries the lineage. Written by the waiter in the same lock that commits that step's take — else the correction sits on disk with nothing at the corrected address pointing at it — or by `applyPatch` when the take is already current. Idempotent per step take, recognized by its file.
- Reservation re-checks for a rival under the state lock (a concurrent `patch apply`/`generate` reserving the same step) — the caller's join check ran on an unlocked snapshot. `applyPatch` supplies what counts as a rival, by the criterion it joined on: what it declined would abort the apply instead of queueing beside it.
- The rival check narrows the race above without closing it — two concurrent runs can each spend on one correction. Closing it needs reservation and job creation made atomic in the shared generation path; until then, do not run two on one video.
- Same spend gates as `generate` — the direction gate per stage, and the backend gate across every step of the chain (checked directly; the stage-walking policy helper has no stage to walk).
- Comfy prerequisites — a comfy step resolves its declared `models`/`nodes` and goes pending behind the install jobs, with the pin carried as `pinnedDeps` to submit time. A step also goes pending behind the earlier steps' jobs, by the same mechanism.
- `generate` applies pending patches after its dependency levels.
- The patched take is unaccepted unless the patch's own adapter is deterministic. A step's address has no stage definition, so the waiter reads that off `patchFinalize` on the job, along with a comfy step's output node and, on the returned step alone, the `output` target that materializes the patched variant. The submit replaces job metadata wholesale; `submitToBackend` carries `patchFinalize` across.
- `selectResolvedVariant` ignores the patch axis, as it ignores definition-staleness. An edited patch's old output stays what render/`path` consume until re-applied; `status` asks for the re-apply.
