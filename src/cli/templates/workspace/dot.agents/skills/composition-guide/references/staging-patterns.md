# Staging patterns

A `<Composition>` is a web page on the shot's clock: any HTML element, Tailwind class, inline `style`, CSS `filter`, inline SVG and GSAP tween works in it.

## Layers

- **A frame, vignette, letterbox or badge over a clip** — an `absolute inset-0` element after the `<Video>`.
- **An inset or a split screen** — `className` on the `<Video>` / `<Image>` sizes and places it.
- **A grade** — a CSS `filter` in the clip's `style`.

## Text

- **`<Subtitle>` for spoken lines; a plain `<div>` + Tailwind for a title, a lower-third or a caption card.**
- **Move a `<Subtitle>` up with `style={{ paddingBottom: "12%" }}`** — each entry is a full-frame box aligned to its bottom; `bottom-*` / `top-*` do nothing.
- **A text entrance** — give the element an `id` and tween it `from` its off state (`opacity`, `yPercent`).

## One layer over every shot: `overlay`

- **Text, images and animation laid across the cuts** — lyrics, a title held over several shots, credits; an entrance runs on through the cut. One per `timeline`; its `ctx` is on the timeline's clock (`duration`, and `beat` / `lyrics` on a piece cut to a song).

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

- **No `<Video>` / `<Audio>`** — a clip goes in a shot, a sound in `soundtracks`.
- **No `asset()` inside it** — declare the asset at the top of `timeline` and use it there.

## Moves on a clip

Each is an `<Animate>` tween on the clip's `id`.

- **Crossfade between two clips in one shot** — overlap them with `start`, then tween one's `opacity` down and the other's up across the overlap.
- **Ken Burns (slow zoom / pan)** — tween `scale` / `xPercent` / `yPercent` with `ease: "none"`; `transformOrigin` steers the zoom anchor. px offsets change with the canvas size.
- **Fade in / out** — an `opacity` tween at the head and at the tail.
- **Flash on a hit** — a full-frame white `<div>` at `opacity-0`, `set` visible at the hit and tweened back to 0. A `fromTo`/`from` holds its start values from the shot's head until it plays, so a `fromTo` flash covers the frame until its hit.
