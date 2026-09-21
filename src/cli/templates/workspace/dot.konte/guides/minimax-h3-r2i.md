# MiniMax H3 R2I

One still frame decoded from a short burst.

## Length

- **Write the frame out until nothing in it is left unnamed**, then stop. 150–250 English words covers a shot carrying a full reference set.

## References

- **`<Subject N>` and `<Picture N>` are the only labels** — the adapter takes images alone.

## Task Type

- **`keyframe completion` or `reference generation`**, or both.

## Stills

- **Write the instant** — one shot, and motion words only for the pose the frame is caught in. No camera move and no beat-to-beat action ("then she turns"): one frame survives. **`summary` is that instant too** — a shot's action written there ("pressing the note onto the board and turning back") comes back with both done.
- **A cut is the exception, and it is two shots** — where the camera steps in or out along one `within` axis between shots, pass the previous shot's last panel to a free `imageN` and write `shots[0]` as the frame it holds, `shots[1]` as the frame wanted. `panel-unlinked` asks for it; a second shot's panel is refused. A long take (`join: "continuous"`) is drawn with no previous panel.
- **`shots[0]` is one sentence pointing at that picture.** Everything written goes in `shots[1]`.
- **`shots[1]`'s cut falls before the kept frame** — on the 24fps clock, `at: 0.5` fits `length: 22` with `frameIndex: 20`. A frame before the cut is still in the shot the take cuts away from, and the adapter refuses it.
- **Write `shots[1]` as a step out of `shots[0]`, sized against what is in frame** — "in from the three of them to the mother alone", "her head about a third of the frame's height", "the hand about the size of her own face". An absolute description comes back closer than asked.
- **A plate passed `fully_preserved` locks `shots[1]`'s framing as it does `shots[0]`'s** — a closer view the plate does not hold takes `attribute_transfer`.
- **`fully_preserved` on a face carries the sheet's expression too** — a cast sheet is a calm or cheerful face and comes back that way on a shot written as terror. Keep the bone structure, hair and clothing, and say in the same line that the expression is remade as the description writes it, overriding the sheet's.
- **Strain vocabulary ages a face** — `deep creases`, `tendons standing out` come back as a person twenty years older. Write the expression as movement (brows dragged high, eyes stretched wide, jaw clenched, mouth open) and restate the age in the same sentence.
- **Leave the set to the plate's picture** — `shots[1]` carries the figures and the movement.
- **Settle a panel before cutting the next one out of it** — re-accepting an upstream panel makes every panel cut from it input-stale, one level per regeneration.

## Plates

- **A closer plate is a cut from its parent's plate** — pass the parent plate as `image1`, `shots[0]` pointing at it, `shots[1]` the frame wanted, sized against the set: "the sofa's arm fills the left third of the frame". Mark it `attribute_transfer`, the framing new.
- **Say the light and colour are `<Picture 1>`'s** — a cut left to itself comes back dimmer.
- **Place the camera by the set** — "at the height of the sofa's seat". A creature named in a plate's prompt, even as a measure, is drawn into it.
- **A bare surface gets filled** — a wall with little on it comes back with a figure or a stain. Take several seeds.
