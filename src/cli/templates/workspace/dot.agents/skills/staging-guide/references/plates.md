# Plates

- Generate every plate from its view's image — `views.<location>.<view>` in `plates`, `front` being the `location` master itself (`plate-unviewed`, `plate-unanchored`). A view image is the room at full distance: cut a closer frame out of it (`imageCrop`) or in from a plate on it, and cut an insert or a night frame in from a plate of the same view. A root setup (`within: null`) declares its framing new. Carry the master's setting and light onto each camera axis.
- Generate a child plate from its `within` setup's plate (`plate-unnested`) — pass the parent plate as is, beside the master, to a model that reads a previous frame (`cut` in `konte adapter show`), and write a cut in from that frame. Match its framing, camera height and perspective — the parent alone is enlarged to a blur.
- A plate fixes how much of the set is in frame, and is passed at canvas size — a plate larger than the canvas reads as a picture inside the frame, its edges drawn as a window. Include the setup's `holds`, each asked for by its `promptDepiction` in the prompt the plate is generated with (`plate-unnamed`). Where the shot needs a frame the plate does not hold, generate another setup's plate; never crop the plate inside the keyframe (`plate-recropped`).
- A setup two or more generated shots share owes a plate (`setup-unrealized`) — declared under `plates` in animatic.tsx and keyed by the roster id (`animatic:plate.<setupId>`). Feed `plates.<id>` as the keyframe's first image input; a setup one shot uses needs none, unless the piece cuts between it and the other exposed size of its `within` axis (`axis-unrealized`). An asset declared here and not returned is an intermediate — never review work, and its name may not be a setup id.
- Every shot stands on the place — its setup's plate, else `reference:<location>` (`setup-unconsumed`, satisfied by any one of its keyframes); a place held by prose alone changes every take. Where there is no plate, the keyframe prompt asks for each `holds` landmark by its `promptDepiction` (`landmark-unnamed`). Exempt: a shot with no generative step, and a plate handed over whole as a file.
- Empty a plate of figures — a pose baked into it is inherited by every shot on that setup. Keep the set the framing reaches — a bare wall or gradient fixes neither place nor look.
- A plate is the image `plates.<id>` returns — the keyframe names it as the empty frame in the adapter's notation and leaves what it holds to the picture.

## View images

A setup facing anything but `front` costs its location a view image (`view-unrealized`) — returned from `views` in reference.tsx, filed at `reference:view.<location>.<view>` whatever the asset is named, and accepted per view before its plates spend.

```tsx
views: ({ reference }) => {
  const roomTop = asset("roomTop", imageMinimaxH3R2i, { image1: reference.room, prompt: { … } });
  return { room: { top: roomTop } };
},
```

- One image per view, made from the master (`view-unanchored`); the adapter's craft guide has the prompt.
- Write the camera position, and what is in frame near to far with its share of the frame, in things the master shows. Never restate the room wall by wall — layout written against the master moves furniture.
- Write the build of what the master does not show (a desk's legs, a chair's back) — left out, it is invented per view.
- Draw the room at full distance — no close, insert or change of light; those are plates.
- Rework a broken view alone, by changing its text.
