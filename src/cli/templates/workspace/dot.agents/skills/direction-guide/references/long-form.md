# Long-form structure — a branch `sequence` node

For a piece long enough to need acts (several minutes up). Under that, keep the root node a leaf (`sequence: { lens, shots }`) — a flat sequence reads as a single arc, acts only add ceremony.

- **Give the root node `sequences[]` instead of `shots[]`** — each child is an act with its own `id`, `role`, `synopsis`, `lens`, `pleasure`, and body. An act's body is again `shots[]` (a leaf act) or, for a very long piece, `sequences[]` (a branch act). A payoff-function act (`climax-act`) states the change it lands in its `synopsis`, like a hinge shot.
- **A branch node's `lens` is a meta-lens over its children** — any lens in the catalog; start with `three-act`, the one budgeted for act scale ([lenses.md](lenses.md)).
- **The same arc checks run at every scale** — each leaf act's lens over its shots, each branch node's lens over its child acts (a missing `climax-act`, acts out of order). Every node carries its own `waivers` that cancel its own arc's findings; the **root** node's `waivers` also owns the piece-wide characters/speech findings.
- **Balance the acts by runtime** — a node's duration derives from its descendant shots; on a share finding, move shots between acts, or waive with a reason.
