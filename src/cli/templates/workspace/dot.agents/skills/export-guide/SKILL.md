---
name: export-guide
description: Render the final video deliverable after every shot is accepted — run konte export, wait out any delivery upscale chain, and report the output. Read when the user wants to export, render, or deliver the finished video.
user-invocable: false
---

Export the accepted cut; done = the render job finishes and `konte probe export` confirms the deliverable. Unaccepted shots return to `generation-loop-guide`.

- **Don't use a delivery export to stand in for the human's review of the shots** — to let them watch the assembled cut you open `konte preview`; your own per-shot checks go through `konte probe`.

## Run the export

- **Run only once `konte status` marks the video line `— ready to export`** (under "Progress"):

```sh
konte export video
```

- **Async like generation** — registers a leaf render job and returns; `konte job wait` is what blocks for the render (`generation-loop-guide` step 4).
- **Output** — `video.mp4` + `manifest.json` into `dist/video/<timestamp>/`. When it completes, run `konte probe export` to read the deliverable's real resolution/duration/fps/audio — report those and the path.
- **Fails by default if any asset is unaccepted.** `--allow-unaccepted` renders ready variants anyway — use **only when the human explicitly asks for a rough-cut file**.

## Delivery (upscale at export time)

- **If `export.delivery` is declared, export first runs the upscale chain at reserved `#delivery` addresses, then assembles at delivery resolution** — `video:shot.<id>.motion#delivery` (per-layer) or `…composition#delivery` (per-frame).
- **Upscale steps are ordinary async generation jobs** — wait for the export job.
- **`#delivery` targets are ordinary visible assets** (`status` / `clean` / `prune` see them), cached on the composition's identity — an unchanged shot is never re-upscaled.
- **To add or change a delivery/upscale config the treatment did not agree, confirm the target resolution with the human first**, then set `size.delivery` on the direction (`direction.policy.format`) and wire the matching `export.delivery.upscale: { video | frame }` in video.tsx per the `authoring-guide` skill.
