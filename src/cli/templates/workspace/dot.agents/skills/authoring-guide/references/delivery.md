# Delivery & upscale

Shipping the final video above the canvas you generate and review at. The delivery **size** lives on the direction; `video.tsx` wires only **how** to reach it (`export.delivery.upscale`).

- **Purely an export-time concern.**
- **Raise `size.megapixels` to the delivery instead** when native high-res generation looks better — upscaling is not free quality. A canvas that already meets the delivery owes no upscaler.
- **A delivery well above the canvas demands an upscaler** — wiring none is an error.

```tsx
// direction.ts:
//   policy: {
//     format: {
//       fps: 24,
//       size: {
//         megapixels: 0.9,                          // budget → derives 1248×704, where you review
//         delivery: { width: 1920, height: 1080 },  // shipped resolution, and the only aspect
//       },
//     },
//     speech: "free",
//   }

// video.tsx
import { defineVideo, upscale } from "konte";
import { videoSeedvr2Upscale } from "konte/workspace/adapters/comfy/video_seedvr2_upscale.js";
import direction from "./direction";

defineVideo(direction, {
  export: {
    delivery: {
      upscale: {
        video: ({ video, width, height }) =>
          upscale(videoSeedvr2Upscale, {
            video,
            width,
            height,
            resolution: Math.min(width, height),
          }),
      },
    },
  },
  timeline: ({ format, shot }) => {
    // …
  },
});
```

- **`size.delivery`** (on `direction.policy.format`) — the resolution `konte export` ships at; it sets the aspect used to derive the working canvas and takes no 32-pixel grid.
- **`export.delivery.upscale`** — pick **exactly one** mode:
  - **`video`** (per-layer): each video layer is upscaled, then the composition is re-rendered at delivery size — subtitles/overlays stay native-sharp. Use for AR-preserving upscalers.
  - **`frame`** (whole composited shot): each shot's composite is upscaled as one image (text upscaled with it), then stitched. Use for any upscaler, including resolution-preset ones.
- **Each mode is a function** konte calls with injected inputs `({ video, scale, width, height })` — pass only what your upscaler takes through the `upscale(adapter, inputs)` helper: scale-based upscalers → `scale`; absolute/preset upscalers (e.g. SeedVR2) → `width`/`height` (konte injects these as the source's real size × scale, AR-preserving).
