---
name: authoring-guide
description: How to author the definition files — defineReference/defineAnimatic/defineVideo, shot/asset/<Panel>, dependencies between assets, cross-stage (animatic → video) references, and export delivery. Read when adding, editing, or wiring shots and assets in a definition file.
user-invocable: false
---

Declare shots, assets and dependencies in the stage files; done = `konte status` loads and typechecks them.

## Routing

- `export.delivery` / upscale modes → [delivery.md](references/delivery.md)
- Which adapter to pass `asset()` → `konte adapter list` (every permitted adapter, its backend, media, required inputs and lean), then `konte adapter show <adapter>` for its schema and guide
- The `prompt` string → `prompt-guide`
- Plates, landmarks and a panel's `blocking` / `camera` → `staging-guide`
- `<Composition>` JSX, audio placement → `composition-guide`
- A type, field or signature (check, don't guess) → the konte LSP (`konte-lsp` plugin) in your editor
- A dependency or staleness reason → `konte inspect <address>`

## The three definition files

- Each file default-exports its definition; a stage reaches another's assets by `import` + closure, never by passing one into another.
- Every DSL name is imported from `konte` — `define*`, `asset`, `panel`, `soundtrack`, the `<Composition>` components; none is ambient.
- A shot's words are keyed by who says them — `script.cat[0]`, and `script.speaker[0]` / `script.narration[0]` for the two variants that anchor to no roster (a mob's label is prose, never a key). Each is that speaker's lines in shot order.

### reference.tsx — defineReference()

Shared building blocks: characters, backgrounds, BGM/SFX, any `file` ref.

```ts
import { defineReference, asset, adapters } from "konte";
import direction from "./direction";

export default defineReference(direction, {
  references: () => {
    const character = asset("character", adapters.imageFile, {
      path: "assets/files/character.png",
    });
    const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
    return { character, bgm }; // exposed to other stages as reference.character / reference.bgm
  },
});
```

- `defineReference(direction, { references, views? })` — `references` receives `{ format }` and declares assets with `asset()` (both `file` and generative adapters); returning one exposes it as `reference.<name>`. Address: `reference:<name>`.
- `views` receives `{ format, reference }` and returns a location's view images, `{ <locationId>: { back | side | top: asset(…) } }`, each at `reference:view.<locationId>.<view>` and reached as `reference.view.<locationId>.<view>` — authoring → staging-guide.
- A reference asset may depend only on other reference assets, never on an animatic/video asset.
- Return only what other stages consume — an asset used solely as an input to another reference asset (a blank `latent` feeding a generated `key`) is left un-returned; it still generates, but is never reviewed.
- Return each character, prop, location and cast voice under its roster id — a `lineup`'s `cat` needs `reference:cat`; other shared assets (`bgm`) are fine. Setups and landmarks are declared on the animatic.
- Let konte size a generated reference — `width`/`height` derive off the canvas' long edge: portrait for a character, a landscape master at twice it for a location, square for the rest; pass neither. A canvas-shaped overlay takes `...format.size`.
- Frame the subject filling the frame — margin is pixels the shot never uses.

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
    cabinWide: asset("cabinWide", imageGen, {
      image1: reference.cabin,
      prompt:
        "the cabin from a low three-quarter angle, wide, empty, the bunk left, the window at the far end",
    }),
  }),
  timeline: ({ shot, plates }) => ({
    shots: shot("01", ({ script }) => {
      const key = asset("key", imageGen, {
        image1: plates.cabinWide,
        image2: reference.character,
        prompt: "<Picture 1> is the empty frame. … the character at the window, back to the room",
      });
      return (
        <Composition>
          <Panel
            src={key}
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

- `defineAnimatic(direction, { plates?, timeline })` — `{ size, fps }` derive from the direction. `timeline` receives `{ format }`, the injected `shot`/`graphicShot`/`pendingShot`/`asideShot` starters and what `plates` returned, declares shared assets at the top, and returns `{ shots, soundtracks?, overlay? }`.
- `plates` receives `{ format }` and returns one image asset per setup id — addressed `animatic:plate.<id>`, handed to `timeline` unchanged.
- Shots come from the direction — the injected `shot(id, …).nextShot(id, …)` is the only way to mint a shot; the shot's `duration` and `script` are injected into the build, never written here.
- `pendingShot(id)` / `.nextPendingShot(id)` — the undeveloped shot, injected alongside `shot`; it declares nothing. Develop it by swapping in `shot(id, …)` / `.nextShot(id, …)`.
- `asideShot(id)` / `.nextAsideShot(id)` — the `kind: "aside"` shot (`direction-guide`). The animatic's takes no build; the video's takes one — `asideShot(id, ({ duration, label }) => …)`.
- `<Panel>` is a keyframe; `<Image>` is a layer — only a `<Panel>` gets a part name, a movement and a contact-sheet frame.
- `<Panel start>` is when it takes over — omitted, the panels split the shot evenly. Each holds to the next one's start and then cuts; a dissolve is an `<Animate>`.

### video.tsx — defineVideo()

Same `asset()` / shot chain / closure as animatic.

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
        image1: animatic.shot("01").image("key"), // cross-stage, by import
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

- `defineVideo(direction, { export?, timeline })` — `{ size, fps }` derive from the direction. `export.delivery.upscale` wires the upscaler.
- What it takes from the board — `animatic.shot("01").image("<panel>")` for a keyframe, `.stem` for the mixed-down lines, `.narrationStem` for the narration (`<Audio>` only).

## Adapter inputs

- The canvas and the generation request are independent axes — `format.size` / `format.fps` are what the composition renders at; an adapter's `width` / `height` / `fps` are what it asks the backend for.
- Omit them and they auto-fill — an input typed `width`/`height`/`fps`/`frames` resolves from `format` (frames also from the shot's duration). Pass a value only to override; konte does no resampling, so an overridden `fps` ships at that rate.
- A `seed` input defaults to `seed()`, re-randomized per variant — pass a fixed number to pin a take. An adapter with no seed input pins nothing.
- A pinned frame must be one the picture shows — an input marked `pin:start`/`pin:end` in `konte adapter show` is reproduced pixel for pixel, so it takes the board panel this shot develops, or the seam frame of the segment before it.

## Dependencies Between Assets

- Depend by passing a `MediaAsset` as an input value — `asset("motion", animate, { image: reference.background, prompt: "zoom into earth" })`.
- Reach by closure, scoped by how wide the sharing is — within one shot: a local `const`; across shots in a stage: a timeline asset declared at the top of `timeline` (`video:timeline.<name>`); across stages: a reference asset (`reference.<name>`), or the imported `animatic` module.
- Across shots, back to any earlier shot — a build's `shot(id)` reaches any shot the chain has already placed, on both stages: `({ shot }) => shot("01").video(name)` / `.image(name)` / `.audio(name)`.
- Renaming an asset that holds takes — rename it and its consumers, then `konte rename <old> <new>` before the next `generate`, which would leave its takes and accept behind.
