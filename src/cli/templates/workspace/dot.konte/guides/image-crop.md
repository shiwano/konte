# imageCrop

Cuts a window out of one image and scales it to the working canvas, in one step. Free, deterministic — no take to pick.

**What it is for: the root of a camera axis, and small steps in from it.** The location's reference sheet is the master, drawn from the axis' camera position wide enough to hold the widest frame; a window cut out of it keeps that position, so what two windows overlap is pixel-identical.

**A window falls inside the window of the setup its `within` names**, and konte checks the plates against it (`plate-unnested`). A window is a zoom: the set is enlarged, never seen from nearer. A `close` is a cut from its parent's plate instead (the staging guide's plates reference).

```tsx
// The master is the location's own reference sheet, sized by konte (2048×1024 off a 1024×576 canvas).
// In `plates`, keyed by setups roster id. outWidth/outHeight default to the working canvas.
// glassWide (within: null) ⊃ glassMedium (within: "glassWide") ⊃ glassClose (within: "glassMedium").
asset("glassWide", adapters.imageCrop, {
  image: reference.room,
  x: 128,
  y: 0,
  width: 1792,
  height: 1008,
});
asset("glassMedium", adapters.imageCrop, {
  image: reference.room,
  x: 256,
  y: 96,
  width: 1536,
  height: 864,
});
asset("glassClose", adapters.imageCrop, {
  image: reference.room,
  x: 832,
  y: 352,
  width: 896,
  height: 504,
});
```

`x`/`y`/`width`/`height` are in the master's pixels. `outWidth`/`outHeight` default to the stage canvas and rarely need passing.

Cut every window out of the master, not out of the plate above it — a plate has been resampled to the canvas once already. Cut the parent plate only where that parent is generated rather than cut.

## Where to cut

**Cut every window on something only this place has.** The tighter the window, the more of it is blank surface, and a blank surface reads as a different room.

A location sheet is already sized for this (2:1 at twice the canvas' long edge). Cut a window much tighter than the canvas and texture dissolves: cork becomes plaster.

Decide the windows before the master is prompted, and write the master's prompt from them: where the camera stands, how far it reaches, and what has to fall inside each window.

Try a window before writing it: `konte probe crop <master|plate> --rect x,y,width,height` (repeatable) outlines each window on the master and renders it as `imageCrop` would. Given a plate, its current window is shown beside them.

## When not to use it

A setup that moves the camera — a reverse, an over-the-shoulder from the other side, an overhead — is not a window on this master. It declares `within: null` and is a root of its own: generate its plate from the master with the framing declared new, or give that axis a master of its own. An insert a fixed camera cannot reach is the same case.
