# Cut idioms

Ways to stage a key action across cuts — reach for them on the beats that carry the piece (a turn, a payoff, a peak); a connective beat staged plainly is fine. Each is ordinary shots: `action`/`setup`/`duration` chosen together.

- **Decompose the key action — anticipation, cut, result.** A `close`/`insert` of the body finding the action, the motion itself elided IN the cut, the result already landed. The skipped middle is the impact — the viewer supplies a faster, cleaner motion than any take — and the generation-safe form: each side is a near-still a model holds. Keep the anticipation short; let the result hold.

  ```ts
  { id: "11a", role: "pressure", action: "The samurai's hand closes on the hilt.",
    setup: "hiltInsert", duration: 0.5, lineup: ["samurai"] },
  { id: "11b", role: "pressure", action: "The blade is already out, held still at eye level.",
    setup: "samuraiClose", duration: 2, lineup: ["samurai"] },
  ```

- **Reveal by the witness — the face before the deed.** Cut to who watches while the event happens off frame; their read tells the viewer what happened, and the next frame shows only the aftermath. Buys dread over spectacle, and spares staging the event at all.
- **Axial punch-in — same axis, tighter, to land a turn.** Both sizes are their own `setups` entries, the tighter one `within` the wider. This is the adjacent pair with a job — the punch is the cut.
- **Compress a repetition — one continuing action as 2–3 cuts, each further along.** Same subject, same action, the time between elided in each cut; shrink the `duration`s into the peak.
- **Flash insert — a 0.5–1s `insert` as punctuation.** An object detail dropped into a run right before the peak. It breaks a background-matching pair for free.

## Pitfalls

- **A chain shares one `role`** — decomposition multiplies shots, never roles.
- **Don't decompose everything** — a piece of nothing but chains spends the contrast the pacing rules manage.
