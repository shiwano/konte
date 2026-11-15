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
- A cut is two shots, written only where `panel-unlinked` or `return-unlinked` asks for the panel before it — pass that panel to a free `imageN` and write `shots[0]` as the frame it holds, `shots[1]` as the frame wanted. A second shot's panel is refused.
- `shots[0]` is one sentence pointing at that picture. Everything written goes in `shots[1]`.
- Write `shots[1]` as a step out of `shots[0]`, sized against what is in frame — "in from the three of them to the mother alone", "her head about a third of the frame's height", "the hand about the size of her own face". An absolute description comes back closer than asked.
- Strain vocabulary ages a face — `deep creases`, `tendons standing out` come back as a person twenty years older. Write the expression as movement (brows dragged high, eyes stretched wide, jaw clenched, mouth open) and restate the age in the same sentence.
- `shots[1]` carries the figures, where each sits and faces in the frame, and the movement.
