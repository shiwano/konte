# Camera setups

- **`framing` is the shot size, declared on the setup** — of the `action`'s mover: `wide` (geography), `medium` (the readable default), `close` (face/detail, the reaction), `insert` (an object fills frame — plant and payoff). One setup is one size; the same position at two sizes is two setups.
- **Frames must differ** — two setups with the same `location`/`framing`/`holds` order is `setup-indistinct` (inserts exempt).
- **Name a setup for what it frames, not for the shot that first used it** — `samuraiClose`, not `shot06`.
- **`holds` is what the frame carries of its place, left to right** — landmark ids of the setup's own location, required and non-empty on every framing but `insert`. konte prints it as the `set:` line of `konte inspect --prompts` and flags two frames of one place that disagree about which side something is on (`landmark-flipped`, keyed by whichever id sorts later — an intended reverse angle is the waiver).
