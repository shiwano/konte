# Lenses & pleasures

## Built-in catalog

Eight, and these are all of them. The **bold** payoff beat is the climax; `escalation` and the trailing beats (`release` / `after-glow` / `fade` / `call-to-action` / `resolution-act`) are optional.

- `mini-drama` — ordinary → disruption → pressure → **hero** → release
- `comedy` — setup → violation → escalation → **button** (caps the joke)
- `satisfying-process` — before → method → rhythm → **completion** → after-glow
- `mood-piece` — atmosphere → motif → variation → **peak** → fade
- `transformation` — before → process → **reveal** → after-glow
- `product-demo` — problem → solution → demonstration → **result** → call-to-action; the demonstration is usually `graphic` shots (the UI itself) with the presenter as their `cutin`
- `kishotenketsu` — ki → sho → ten → **ketsu** (set up → develop → twist → reconcile); the one shape with no conflict in it, so reach for it when there is no antagonist: the turn comes late and the payoff reframes it rather than winning a fight
- `three-act` — setup-act → confrontation-act → **climax-act** → resolution-act; named and budgeted for acts (a first act past ~40% is front-loaded, a climax under ~15% is rushed), so it is the one to reach for on a long piece's root ([long-form.md](long-form.md))

## Pleasure vocabulary — closed, no custom values

The emotional reward a node aims for — orthogonal to the lens (a `mini-drama` can be `cute` or `scary`). Every node names one, root and child alike; an act that keeps the feeling of the act above it repeats it. Only these ten:

- `cute` — warmth and affection for the subject
- `funny` — laughter
- `cool` — admiration for style and competence
- `beautiful` — pleasure taken in the image itself
- `scary` — fear, and the tension before it
- `satisfying` — the click of something coming together properly
- `surprising` — the jolt of the unexpected
- `emotional` — being moved — tenderness, or tears
- `mysterious` — the pull of what is withheld
- `awe` — smallness in the face of something vast

## Custom lenses — a last resort

- **`defineLens({ name, payoff, beats })`** — in `defineDirection`'s `lenses`, referenced by `name` from any node.
- **Each beat declares its `role` and dramatic `fn`** (`ground` / `turn` / `build` / `payoff` / `settle`; omit for a container role). `payoff` must be a `fn: "payoff"` beat (`payoff-function-mismatch`); an ungrounded payoff trips `unearned-payoff`.
- **Keep them rare and shaped like the built-ins.**
