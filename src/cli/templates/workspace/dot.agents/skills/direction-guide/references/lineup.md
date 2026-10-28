# Lineup and boundaries

- `lineup` lists a narrative frame's characters left to right — include a sleeve or shoulder visible at the edge; use `[]` for an empty frame or prop insert.
- A prop is never lined up — write where it is relative to whoever holds it or set it down, in the prompt.
- Write the frame, not the roster — a push-in onto one person lists that person; konte accumulates "a is left of b" per location itself.
- `lineupTo` is the frame the shot LEAVES, in full — declare it wherever the frame changes inside the shot: a move, an entrance, an exit, or a change meant to land on the next cut. List everyone the closing frame holds; whoever you leave out has walked out, their place unknown until a later frame holds them.
- `passing` names characters that enter and exit during the shot — an unordered set on a narrative frame or `cutin`, absent from both endpoint lineups. Write the entrance/exit edges and where they cross in `action`.
- A camera coming round reverses everyone, so list everyone — half a frame re-declared reads as the rest walking out of shot, and nothing will catch it.
- `join` is what the boundary INTO this shot is — leave it out for an ordinary cut with story time running on; `"jump-back"` enters a flashback, `"jump-forward"` skips ahead (a jump cut, a gap) or leaves one — both empty the accumulated order everywhere. `"continuous"` is no cut at all: this shot and the one before are one unbroken take.
- Where the shot before is on the same `setup`, `join` is required; `"continuous"` is refused anywhere else — a different setup, an aside or graphic shot before it, or the opening shot.
- A long take is one camera position — a hold whose camera moves is one shot with two `<Panel>`s. Two `"continuous"` shots agree on the frame between them: the first one's `lineupTo` (or `lineup`) is the second one's `lineup`, and the video pins that one frame.
- `cutin` is a second camera frame over the shot — `{ setup, lineup, lineupTo?, passing?, join? }` on a narrative or graphic shot (the presenter wiped in over a screen). It is one more shot on that setup: every lineup, plate and keyframe rule applies, findings keyed `<shotId>.cutin`. `cutin.join` is the wipe's own boundary, on the same terms against the cutin over the shot before. Placement is the composition's; an inset no camera takes (a phone screen) needs no `cutin`.
