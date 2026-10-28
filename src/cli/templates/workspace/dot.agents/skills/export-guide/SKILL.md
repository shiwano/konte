---
name: export-guide
description: Render the accepted cut's deliverable — konte export, its delivery upscale chain, the report. Read when the user wants to export, render, or deliver the finished video.
user-invocable: false
---

Export the accepted cut; done = the render job finishes and `konte probe export` confirms the deliverable. Unaccepted shots return to `generation-loop-guide`.

- An export never stands in for the human's review — they watch the assembled cut in `konte preview`; your own per-shot checks are `konte probe`.

## Run the export

- Run only once `konte status` marks the video line `— ready to export` (under "Progress"):

```sh
konte export video
```

- Async — registers a render job and returns; `konte job wait` blocks for it.
- Output — `video.mp4` + `manifest.json` into `dist/video/<timestamp>/`. When it completes, run `konte probe export` to read the deliverable's real resolution/duration/fps/audio — report those and the path.
- Then offer `konte clean` and `konte prune`. Add `--delete-unaccepted` only once the human calls the video finished — a deleted take is lost spend.
- `--allow-unaccepted` renders unaccepted variants — only when the human explicitly asks for a rough-cut file.

## Delivery (upscale at export time)

- If `export.delivery` is declared, export first runs the upscale chain at reserved `#delivery` addresses, then assembles at delivery resolution — `video:shot.<id>.motion#delivery` (per-layer) or `video:shot.<id>#composition#delivery` (per-frame).
- `#delivery` targets are ordinary visible assets, cached on the composition's identity — an unchanged shot is never re-upscaled.
- A delivery/upscale config the treatment did not agree → confirm the target resolution with the human first, then set `direction.policy.format.size.delivery` and wire `export.delivery.upscale` per `authoring-guide`.
