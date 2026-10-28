# Camera setups

- `framing` is the shot size, declared on the setup — of the `action`'s mover: `wide` (geography), `medium` (the readable default), `close` (face/detail, the reaction), `insert` (an object fills frame — plant and payoff). One setup is one size; the same position at two sizes is two setups.
- A setup is realized as `animatic:plate.<id>` — authoring and required coverage → `staging-guide`.
- Name a setup for what it frames — `samuraiClose`, not `shot06`.
- `holds` is what the frame carries of its place, left to right — landmark ids of the setup's own location, required and non-empty on every framing but `insert`.
- `within` names a wider setup of the same location — steps may be skipped; `null` starts a separate camera axis. Declare it wherever a wider frame could contain this one; an `insert` omits it.
- `view` is the way the camera faces — `front` (the way `reference:<location>` faces), `back` (its reverse), `side` (square to it, one side only — a place whose two side walls both show is two locations), `top` (straight down). Every setup without `within: "<id>"` declares it; a window takes its parent's and writes none. An insert faces where the camera points — straight down on a desk top is `top`.
- Left and right are screen sides — a landmark's `description` places it as `reference:<location>` frames it, a setup's as its own frame shows it. `back` mirrors the master's sides; `top` first states which side of the place lies at the frame's bottom, then the sides that follow.
- Every view but `front` that a location's setups face costs that location a view image, reviewed before its plates spend.
