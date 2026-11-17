# Rosters and voices

## Rosters — `characters`, `props`, `locations`

- All three are anchored rosters — a record keyed by `id` (one shared namespace), each `id` matching an exposed `reference:<id>` asset: generate the subject once there and animate/compose from it.
- `characters` is required, `props` optional; only characters are named speakers.
- An entry of a real product, logo, currency, app screen, landmark, flag, document, person or artwork → find its file on the web, save it to `assets/files/`, name it and its source in `description`; none found → ask the human.
- Choose a drawable, discriminative `promptDepiction` for each character and prop — `chef`, not a story role or invented name; `tabby` for one cat, `girl in a purple hoodie` to distinguish two girls. Write it without adapter notation. A keyframe of a frame whose `props` holds a prop says its `promptDepiction` (`prop-unnamed`).
- `locations` is required — a shot reaches one through its setup.
- A location declares `landmarks`, what only this place has — required and non-empty, keyed by id, each `{ name, promptDepiction, description }`, its `promptDepiction` under a character's rule. A frame with nothing particular to the set comes back as another room. A landmark anchors on its plate, never a `reference:<id>`. Its id shares the one id space — no collision with a character, prop, place or another landmark.

## Casting voices — `voice`, `narrator`

- A script line demands a voice — a `{ character }` line requires `voice` on that roster entry, a `{ narration }` line the top-level `narrator`. `{ speaker }` lines are unchecked.
- `id` is its own `reference:<id>` sample, never the look anchor; `description` is how they sound (sex, age, timbre, pace) — an empty one is a hard error. One voice heard twice (a narrator who is the protagonist, twins) names one `id` twice, each with its own `description`.
- `konte generate animatic` and `konte generate video` are both held until each sample is accepted.
