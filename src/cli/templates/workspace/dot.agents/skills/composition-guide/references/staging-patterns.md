# Staging patterns

## Layers

- A frame, vignette, letterbox or badge over a clip — an `absolute inset-0` element after the `<Video>`.
- An inset or a split screen — `className` on the `<Video>` / `<Image>` sizes and places it.
- A grade — a CSS `filter` in the clip's `style`, one value on every shot it covers; a grade the human did not ask for is named in the handoff, not applied.
- One vignette, grain or letterbox for the whole piece, or none — one some shots carry and others don't reads as a seam.

## Text

- `<Subtitle>` for spoken lines; a plain `<div>` + Tailwind for a title, a lower-third or a caption card.
- One `<Subtitle className>` for the piece, never the default face and size — at most two rows; a line that needs three is broken in the entries.
- Text stays 5% in from every edge — a 9:16 delivery also keeps the bottom sixth and the right edge clear for the platform's controls.
- A title never delays the hook — it rides over the first shot or lands after it.
- A telop lands on a hold — where the frame is still, for as long as it takes to read twice.
- A `<Subtitle>`'s default place already clears those margins; `bottom-[…]` / `right-[…]` moves it, measured from the canvas edge — a box behind the text goes on `lineClassName`.
- A text entrance — tween the element `from` its off state (`opacity`, `yPercent`).

## One layer over every shot: `overlay`

- Text, images and animation laid across the cuts — lyrics, a title held over several shots, credits; an entrance runs on through the cut. One per `timeline`; its `ctx` is on the timeline's clock (`duration`, and `beat` / `lyrics` on a piece cut to a song).

```tsx
timeline: ({ shot }) => ({
  shots: …,
  overlay: (ctx) => (
    <Composition>
      <Subtitle entries={ctx.lyrics} />
      <div id="title" className="absolute top-[8%] w-full text-center text-[3vmax]">Neon</div>
      <Animate script={({ timeline }) => timeline.from("#title", { opacity: 0, duration: 0.6 }, 0)} />
    </Composition>
  ),
}),
```

- No `<Video>` / `<Audio>` — a clip goes in a shot, a sound in `soundtracks`.
- No `asset()` inside it — declare the asset at the top of `timeline` and use it there.

## Transitions

- The cut is the default — a dissolve says time passes or the place changes; between two shots of one action it is a smear. A fade in at the head, a fade out at the tail, and elsewhere only where the direction asks for it (a flash on a hit).
- A `join: "continuous"` boundary takes no transition — anything laid over it puts a cut back.
- A transition hides nothing — a dissolve over a jump cut is a slow jump cut; fix the take or the shot.
- An end card comes after the last image, never instead of it.

## Moves on a clip

Each is an `<Animate>` tween on the clip's `id`.

- Crossfade between two clips in one shot — overlap them with `start`, then tween one's `opacity` down and the other's up across the overlap.
- Ken Burns (slow zoom / pan) — tween `scale` / `xPercent` / `yPercent` with `ease: "none"`; `transformOrigin` steers the zoom anchor. px offsets change with the canvas size.
- Fade in / out — an `opacity` tween at the head and at the tail.
- Flash on a hit — a full-frame white `<div>` at `opacity-0`, `set` visible at the hit and tweened back to 0.
