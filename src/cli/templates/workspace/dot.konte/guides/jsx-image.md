# jsxImage

Text and exact geometry, rendered instead of generated. A model cannot be relied on to spell a word or land an edge; a browser does both exactly, every time.

**Material that carries text or a shape that has to be right — a card, a label, a plate, a framing guide — is worth building here rather than prompting for.** Its own edges need not be beautiful: when the still is a conditioning image, the generation downstream paints the piece's look over it. What survives is what only this can guarantee — the letters and the geometry.

The axis is where the text ends up. Text **delivered on screen** belongs in the shot's own `<Composition>` JSX. Text **fed into a generation** is what this is for.

## What it renders

The same document a shot's composition renders into: `<Composition>`'s head, Tailwind, and the stage's declared Google Fonts over the direction's `lang`.

The canvas is the stage's, unless `width`/`height` say otherwise. The `build` callback receives the resolved size, so lay out against it:

```tsx
const card = asset("titleCard", adapters.jsxImage, {
  build: ({ height }) => (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <h1 style={{ fontSize: height * 0.12 }}>Title</h1>
      <p style={{ fontSize: height * 0.04 }}>Sub title</p>
    </div>
  ),
});
```

## Fonts

Declared on the direction, never here: `policy.fonts`, by Google Fonts family names, over `policy.lang`. Every stage typesets from that one pair. `composition-guide` has the rules.

Declaring none leaves text on Tailwind's `ui-sans-serif, system-ui, sans-serif` — whatever faces the rendering machine has installed, which the definition hash does not cover. A `lang` in a script no default face carries raises `fonts-undeclared` before any spend.

## Composing other assets in

`<Image src={…}>` inside the tree becomes a dependency edge:

```tsx
const plate = asset("plate", adapters.jsxImage, {
  build: () => (
    <>
      <Image src={reference.background} fill />
      <Image src={reference.logo} className="absolute bottom-16 right-16 w-1/5" />
    </>
  ),
});
```

`fill` is `position: absolute` at 100% × 100% with `object-fit: cover`, so it fills the nearest **positioned** ancestor — `#stage` (the whole canvas) at the top level, and a box of your own only when that box is positioned. Inside a plain static `<div>` it escapes to the canvas and covers everything painted before it.

Being positioned, it also paints over anything in normal flow, so put text and layout over a `fill` background in positioned elements too.

Where neither is what you want, size a plain `<Image>` yourself — `className` and `style` pass straight through to the `<img>`, `objectFit` included:

```tsx
<Image src={reference.logo} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
```

Stills only. A `<Video>` or `<Audio>` fails the load — one frame has no clock, so the first comes out black and the second is never heard. An `<Animate>` loads, and its timeline never runs.

## Background

Defaults to opaque `#000000`. Pass `background: "transparent"` for an alpha PNG — a lower third or a logo bug layered over a shot:

```tsx
const lowerThird = asset("nameplate", adapters.jsxImage, {
  background: "transparent",
  build: ({ width }) => (
    <div
      className="absolute bottom-24 left-24 bg-black/60 px-8 py-4"
      style={{ width: width * 0.4 }}
    >
      <span className="text-white text-5xl">John</span>
    </div>
  ),
});
```

## Pinning a generation's output size

Many generators take their output size from an input image rather than from a size parameter. Omit `build` and the image is `background` alone at the resolved canvas size — a solid plate for exactly that.

- **A ComfyUI workflow with no width/height knob** — wire one in as its sized latent/canvas input. To pin from an existing picture instead, resize that picture with `imageResize`.
- **An image-edit model with no size parameter** — pass the plate as the first reference and the real subject as a second, and say which is which in the prompt:

  ```
  image 1 is a blank canvas that only sets output size; use only the subject in image 2
  ```

## Composited references

A part this composites is placed, not cropped — size it for its slot in the layout, not by `authoring-guide`'s square-and-tight rule. The composite itself does follow that rule when a model conditions on it; canvas-shaped when a composition shows it.

## Iterating

`konte probe jsx <address>` renders the current definition and prints the still's path — no job, no variant, no spend. Close a layout there before generating.

## Determinism

Editing the `build` stales the take and `generate` re-renders it. There is one outcome, so `reroll` and `dismiss` refuse.

It is still review work: it surfaces under `konte status`'s Needs review and takes a `konte accept <variantId>` like any other take. Editing the `build` after that ages the accept out.
