# MiniMax H3 R2I

One still frame decoded from a short burst.

## Length

- 150–250 English words covers a shot carrying a full reference set.

## References

- `<Subject N>` and `<Picture N>` are the only labels — the adapter takes images alone.

## Task Type

- `keyframe completion` or `reference generation`, or both.

## Stills

- Write the instant — one shot, and motion words only for the pose the frame is caught in. No camera move and no beat-to-beat action ("then she turns"): one frame survives. `summary` is that instant too — a shot's action written there ("pressing the note onto the board and turning back") comes back with both done.
- A frame comes back as written — a height, an angle, a near plane and a far one that the text names are in the frame; what it leaves out comes back flat.
- A reroll of unchanged text returns the same composition — change the text to change the frame.
- A cut is the exception, and it is two shots — where the camera steps in or out along one `within` axis between shots, pass the previous shot's last panel to a free `imageN` and write `shots[0]` as the frame it holds, `shots[1]` as the frame wanted. `panel-unlinked` asks for it; a second shot's panel is refused. A long take (`join: "continuous"`) is drawn with no previous panel.
- `shots[0]` is one sentence pointing at that picture. Everything written goes in `shots[1]`.
- `shots[1]` is its text alone — the adapter sets the cut time.
- Write `shots[1]` as a step out of `shots[0]`, sized against what is in frame — "in from the three of them to the mother alone", "her head about a third of the frame's height", "the hand about the size of her own face". An absolute description comes back closer than asked.
- Strain vocabulary ages a face — `deep creases`, `tendons standing out` come back as a person twenty years older. Write the expression as movement (brows dragged high, eyes stretched wide, jaw clenched, mouth open) and restate the age in the same sentence.
- Leave the set to the plate's picture — `shots[1]` carries the figures, where each sits and faces in the frame, and the movement.

## Plates

- A closer plate is a cut from its parent's plate — pass the parent plate as `image1`, `shots[0]` pointing at it, `shots[1]` the frame wanted, sized against the set: "the sofa's arm fills the left third of the frame". Mark it `attribute_transfer`.
- Say the light and colour are `<Picture 1>`'s — a cut left to itself comes back dimmer.
- Place the camera by the set — "at the height of the sofa's seat". A creature named in a plate's prompt, even as a measure, is drawn into it.
- A bare surface gets filled — a wall with little on it comes back with a figure or a stain. Take several seeds.

## Views

- A view image (`views` in reference.tsx) is the master from a new camera position — pass `reference.<location>` as `image1`, mark it `attribute_transfer` with "the camera position is new".
- `summary` is that picture's instant — "the room seen from straight above the desk", never "from a new camera position".
- Write the camera's height, then near to far what is in frame by its share of the frame — "the desk top fills the lower half; the chair's seat the upper left quarter".
- The reverse of a room shows the wall behind the master's camera — name what is on it, or it comes back as the master walked around.
