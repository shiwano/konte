---
name: authoring-guide
description: How to author the definition files — defineReference/defineAnimatic/defineVideo, shot/asset/<Panel>, dependencies between assets, cross-stage (animatic → video) references, and export delivery. Read when adding, editing, or wiring shots and assets in a definition file.
user-invocable: false
---

Declare shots, assets and dependencies in the stage files; done = `konte status` loads and typechecks them. Adapter choice, prompt text and composition contents follow the routing below.

## Routing

- `export.delivery` / upscale modes → [delivery.md](references/delivery.md)
- Which adapter to pass `asset()` → `konte adapter list` (every permitted adapter, its backend, media, required inputs and lean), then `konte adapter show <adapter>` for its schema and guide
- The `prompt` string → `prompt-guide`
- Plates, landmarks and a panel's `blocking` / `camera` → `staging-guide`
- `<Composition>` JSX, audio placement → `composition-guide`
- A type, field or signature (check, don't guess) → the konte LSP (`konte-lsp` plugin) in your editor
- A dependency or staleness reason → `konte inspect <address>`

## The three definition files

Each is a standalone entry file with a default export that konte loads directly; **none is passed into another** — a stage reaches another's assets by `import` + closure.

**Every DSL name is imported from `konte`** — `define*`, `asset`, `panel`, `soundtrack`, the `<Composition>` components; none is ambient.

**A shot's words are keyed by who says them** — `script.cat[0]`, and `script.speaker[0]` / `script.narration[0]` for the two variants that anchor to no roster (a mob's label is prose, never a key). Each is that speaker's lines in shot order: an in-range index is a bare `string`, an out-of-range one and an absent speaker are type errors.

### reference.tsx — defineReference()

Shared building blocks: characters, backgrounds, BGM/SFX, any `file` ref.

```ts
import { defineReference, asset, adapters } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  return { character, bgm }; // exposed to other stages as reference.character / reference.bgm
});
```

- **`defineReference(direction, build)`** — the callback declares assets with `asset()` (both `file` and generative adapters); **returning one exposes it as `reference.<name>`**. Address: `reference:<name>`. The direction is taken for its typesetting and for the size each sheet is derived at.
- **Generated once and shared across every stage** — accepting it once satisfies everyone. A reference asset may depend only on other reference assets, never on an animatic/video asset.
- **Return only what other stages consume** — an asset used solely as an input to another reference asset (e.g. a blank `latent` feeding a generated `key`) is declared but left un-returned. An un-returned one still generates, but is never reviewed. A returned name must be a real `asset()`.
- **Return each character, prop, location and cast voice under its roster id** — `characters: { cat: … }` needs `reference:cat`; other shared assets (`bgm`) are fine. Setups and landmarks are declared on the animatic.
- **Let konte size a generated reference** — `width`/`height` derive off the canvas' long edge: portrait for a character, a 2:1 master at twice it for a location, square for the rest; pass neither.
- **Frame the subject tight** — margin is pixels the shot never uses; ask for it filling the frame.

### animatic.tsx — defineAnimatic()

The board on the direction's clock, required for shots consuming keyframes or spoken lines.

```tsx
import { defineAnimatic, asset, Audio, Composition, Panel } from "konte";
import { imageGen } from "konte/workspace/adapters/comfy/image_gen.js";
import { ttsAdapter } from "konte/workspace/adapters/comfy/tts_adapter.js";
import direction from "./direction";
import reference from "./reference";

export default defineAnimatic(direction, {
  plates: () => ({
    cabinWide: {
      image: asset("cabinWide", imageGen, {
        image1: reference.cabin,
        prompt: "the cabin from a low three-quarter angle, wide, empty",
      }),
      prompt: "a bare cabin, the bunk left, the window at the far end",
    },
  }),
  timeline: ({ shot, plates }) => ({
    shots: shot("01", ({ script }) => {
      const first = asset("first", imageGen, {
        image1: plates.cabinWide.image,
        image2: reference.character,
        prompt: `<Picture 1> is the empty frame: ${plates.cabinWide.prompt}. … the character at the window`,
      });
      return (
        <Composition>
          <Panel
            src={first}
            blocking="She crosses from the doorway to the window and stops, back to the room."
            camera="fixed"
          />
          <Audio src={asset("vo", ttsAdapter, { script: script.character[0] })} start={0.2} />
        </Composition>
      );
    }),
  }),
});
```

- **`defineAnimatic(direction, { plates?, timeline })`** — the animatic derives its working `{ size, fps }` from the direction. `timeline` receives `{ format }`, the injected `shot`/`pendingShot` starters and what `plates` returned, declares shared assets at the top, and returns `{ shots, soundtracks? }`.
- **`plates` returns `{ image, prompt }` by setup id** — addressed `animatic:plate.<id>`, handed to `timeline` unchanged.
- **Shots come from the direction** — the injected `shot(id, …).nextShot(id, …)` is the only way to mint a shot; each `id` is pinned to the direction (a stray id is a type error), and the shot's `duration` and `script` are injected into the build, never written here.
- **`pendingShot(id)` / `.nextPendingShot(id)`** — the undeveloped shot, injected into `timeline` alongside `shot`. It carries nothing of its own (the shot's duration, action and script are the direction's) and declares nothing. Develop it by swapping in `shot(id, …)` / `.nextShot(id, …)`.
- **`asideShot(id)` / `.nextAsideShot(id)`** — the `kind: "aside"` shot (`direction-guide`). The animatic's takes no build; the video's takes one — `asideShot(id, ({ duration, label }) => …)`. Each starter is pinned to its kind.
- **`<Panel>` is a keyframe; `<Image>` is a layer** — only a `<Panel>` gets a part name, a movement and a contact-sheet frame. A developed shot with none fails to load.
- **`<Panel start>` is when it takes over** — omitted, the panels split the shot evenly. Each holds to the next one's start and then cuts; konte never interpolates, so write a dissolve with `<Animate>`.
- **Movement lives per-panel, positionally** — `blocking` / `camera` are optional here and written later from the take, except on a multi-panel shot's landing frame; a continuous seam still owes movement.
- **A shot with `script` must sound it** — an `<Audio>` per line.
- **No `<Video>` here** — the motion belongs in `video.tsx`, behind the accept this board gates.
- **When the delta is a removal, wire the reverse** — `first` derives from `last` (`production-guide`).

### video.tsx — defineVideo()

The final motion video. Same `asset()` / shot chain / closure as animatic.

```tsx
import { defineVideo, asset, soundtrack, Composition, Video } from "konte";
import { videoAdapter } from "konte/workspace/adapters/comfy/video_adapter.js";
import direction from "./direction";
import animatic from "./animatic";
import reference from "./reference";

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    soundtracks: [soundtrack("bed", reference.bgm, { duck: true })], // whole timeline
    shots: shot("01", () => {
      const motion = asset("motion", videoAdapter, {
        startImage: animatic.shot("01").image("first"), // cross-stage, by import
        audio: animatic.shot("01").stem, // audio-driven models only
        prompt: "She crosses from the doorway to the window and stops.",
      });
      return (
        <Composition>
          <Video src={motion} hasAudio />
        </Composition>
      );
    }),
  }),
});
```

- **`defineVideo(direction, { export?, timeline })`** — the video derives its working `{ size, fps }` from the direction's canvas. `export.delivery.upscale` wires the upscaler.
- **A video shot is `shot(id, (ctx) => <Composition>…)`** — the same form the animatic takes. What goes inside is the `composition-guide` skill's.
- **What it takes from the board** — `animatic.shot("01").image("<panel>")` for a keyframe, `.stem` for the mixed-down lines, `.narrationStem` for the narration (`<Audio>` only). Each is checked against what that shot declared, so a typo fails while the definition loads.

## Adapter inputs

- **The canvas and the generation request are independent axes** — `format.size` / `format.fps` are what the composition renders at; an adapter's `width` / `height` / `fps` are what it asks the backend for.
- **Omit them and they auto-fill from the canvas** — an input typed `width`/`height`/`fps`/`frames` resolves from `format` (frames also from the shot's duration). Pass a value only to override; konte does no resampling, so an overridden `fps` ships at that rate.
- **A `seed` input defaults to `seed()`**, re-randomized per variant — pass a fixed number to pin a take. An adapter with no seed input pins nothing.
- **A `"prompt"` input is checked before every spend** — a value naming what to leave out aborts `generate` (`prompt-guide`). Where the negation is how that model is written and its adapter does not exempt it, record it in the stage's own `waivers: { "<key from konte status>": "<why>" }`, alongside `timeline` — one key covers every address a shared phrase reaches.
- **A pinned frame must be one the picture shows** — an input marked `pin:start`/`pin:end` in `konte adapter show` is reproduced pixel for pixel, so it takes the board panel this shot develops, or the seam frame of the segment before it. Pinning a `reference:` sheet or a plate aborts `generate`; waive it in the same `waivers` when the take is meant to open on it.

## Dependencies Between Assets

- **Depend by passing a `MediaAsset` as an input value** — `asset("motion", animate, { image: reference.background, prompt: "zoom into earth" })`.
- **Reach by closure, scoped by how wide the sharing is** — within one shot: a local `const`. Across shots in a stage: a timeline asset declared at the top of `timeline` (`video:timeline.<name>`). Across stages: a reference asset (`reference.<name>`).
- **Across shots, back to any earlier shot** — a build's `shot(id)` reaches any shot the chain has already placed, on both stages: `({ shot }) => shot("01").video(name)` / `.image(name)` / `.audio(name)`. An unknown asset name, a kind mismatch, or a still-undeveloped `pendingShot` target fails while the definition loads.
- **Across stages** — reach animatic assets through the imported module: `startImage: animatic.shot("01").image("first")`. An animatic asset moving to a new take stales dependent video assets.
