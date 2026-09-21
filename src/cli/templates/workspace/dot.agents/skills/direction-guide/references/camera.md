# Camera setups

- **`framing` is the shot size, declared on the setup** — of the `action`'s mover: `wide` (geography), `medium` (the readable default), `close` (face/detail, the reaction), `insert` (an object fills frame — plant and payoff). One setup is one size; the same position at two sizes is two setups.
- **A setup is realized as `animatic:plate.<id>`** — plate authoring and required coverage are in `staging-guide`.
- **Frames must differ, and a place lived in needs one it returns to** — two setups with the same `location`/`framing`/`holds` order is `setup-indistinct` (inserts exempt); a location with 8+ shots, fewer than half on a shared frame, is `setup-atomized`.
- **Name a setup for what it frames, not for the shot that first used it** — `samuraiClose`, not `shot06`. Shots move; the frame is what other shots come back to.
- **`holds` is what the frame carries of its place, left to right** — landmark ids of the setup's own location, required and non-empty on every framing but `insert`. konte prints it as the `set:` line of `konte inspect --prompts` and flags two frames of one place that disagree about which side something is on (`landmark-flipped`, keyed by whichever id sorts later — an intended reverse angle is the waiver).
- **`within` names a wider setup of the same location** — steps may be skipped; `null` starts a separate camera axis. Declare it wherever a wider frame could contain this one (`within-undeclared`); an `insert` omits it. Its plate is built from its parent's (`plate-unnested`).
