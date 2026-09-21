# Rosters and voices

## Rosters — `characters`, `props`, `locations`

- **All three are anchored rosters** — a record keyed by `id` (one shared namespace), each `id` matching an exposed `reference:<id>` asset: generate the subject once there and animate/compose from it.
- **Name characters and props by exact roster `name` in the actions that use them** — choose a distinctive phrase ("the black cat"); konte matches literal substrings. `characters` is required, `props` optional; only characters are named speakers.
- **Choose a drawable, discriminative `promptDepiction`** — `chef`, not a story role or invented name; `tabby` for one cat, `girl in a purple hoodie` to distinguish two girls. Use the model's language, without adapter notation. No character or landmark depiction may contain another (`prompt-depiction-conflict`); the scan matches substrings.
- **`locations` is required** — a shot reaches one through its setup.
- **A location declares `landmarks`, what only this place has** — required and non-empty, keyed by id, each `{ name, promptDepiction, description }` — its `promptDepiction` under the same rule as a character's, in the same one depiction space. A frame with nothing particular to the set comes back as another room. A landmark anchors on no `reference:<id>`; the plate is its anchor. Its id shares the direction's one id space, so it may not collide with a character, a prop, a place, or a landmark elsewhere.

## Casting voices — `voice`, `narrator`

- **A script line demands a voice** — a `{ character }` line requires `voice` on that roster entry, a `{ narration }` line the top-level `narrator`. `{ speaker }` lines are unchecked.
- **`id` is its own `reference:<id>` sample**, never the look anchor; `description` is how they sound (sex, age, timbre, pace) — an empty one is a hard error. One voice heard twice (a narrator who is the protagonist, twins) names one `id` twice, each with its own `description`.
- **Text on screen is `telop`**, which asks for no voice. `konte generate animatic` and `konte generate video` both abort with `VOICE_ACCEPTANCE_REQUIRED` until each sample is accepted.
