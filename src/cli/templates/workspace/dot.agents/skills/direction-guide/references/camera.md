# Camera setups

- `framing` is the shot size, declared on the setup — of the `action`'s mover: `wide` (geography), `medium` (the readable default), `close` (face/detail, the reaction), `insert` (an object fills frame — plant and payoff). One setup is one size; the same position at two sizes is two setups.
- A setup is realized as `animatic:plate.<id>` — plate authoring and required coverage are in `staging-guide`.
- Name a setup for what it frames, not for the shot that first used it — `samuraiClose`, not `shot06`.
- `holds` is what the frame carries of its place, left to right — landmark ids of the setup's own location, required and non-empty on every framing but `insert`.
- `within` names a wider setup of the same location — steps may be skipped; `null` starts a separate camera axis. Declare it wherever a wider frame could contain this one; an `insert` omits it. Its plate is built from its parent's.
