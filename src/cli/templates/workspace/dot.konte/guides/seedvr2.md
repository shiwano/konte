# SeedVR2

A restoration upscaler with no prompt and no negative prompt — every control is an input.

## Model Choice

`ditModel` names the DiT weights. konte downloads only what the adapter's `models` block lists, so switching builds means editing that entry's `filename`/`url` too, not overriding `ditModel` alone.

## VRAM

The nodes manage VRAM themselves; ComfyUI does not offload them to host memory.

`blocksToSwap` keeps only the active transformer blocks on the GPU and parks the rest on the host, paying a transfer each pass. `0` (default) turns it off.

- Range 0–32.
- Raising it needs `ditOffloadDevice: "cpu"`; at `"none"` there is nowhere to park them.
- Unavailable on macOS.

At a 1080p or larger target, the VAE's encode and decode, not the DiT, are the peak.

- `encodeTiled` / `decodeTiled` (both default `true`) process frames in square tiles of `encodeTileSize` / `decodeTileSize` px (default 1024). A frame within one tile is processed whole. A larger tile raises the peak.
- A tile size of the target's shorter edge rounded up to a multiple of 8 fits that edge in one tile — 1088 for 1080p.
- `vaeOffloadDevice: "cpu"` parks the VAE on the host while the DiT runs.

### Tuning by card

`konte doctor --backends` prints the ComfyUI GPU and its VRAM. Start from its row; if the job fails, move one row down.

| VRAM  | Settings over the defaults                                               |
| ----- | ------------------------------------------------------------------------ |
| 32GB+ | `encodeTileSize` / `decodeTileSize` at the shorter-edge size above       |
| 24GB  | none                                                                     |
| 16GB  | `vaeOffloadDevice: "cpu"`                                                |
| 12GB  | the above, `ditOffloadDevice: "cpu"`, `blocksToSwap: 16`, tile sizes 768 |
| 8GB   | the above, `blocksToSwap: 32`, tile sizes 512                            |

## Sizing

`width`/`height` size the frames fed into the model through ImageScale, which center-crops when `crop: "center"` and the aspect ratios differ. For delivery, pass the injected dimensions and set `resolution: Math.min(width, height)`.

The workflow's temporal batch is fixed at 5 frames and is not exposed as an input. It governs temporal consistency and follows a 4n+1 rule (1, 5, 9, …), so raising it is an adapter edit, not a call-site one.
