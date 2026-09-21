---
name: arch-delivery-guide
description: Read when touching export, upscaling or delivery resolution — upscale.video vs upscale.frame, the reserved `#delivery` addresses, and the async export job.
user-invocable: false
---

How a video's optional `export.delivery` turns the working graph into a higher-resolution export — the two upscale modes, the `#delivery` addresses, and the export job. Delivery is an export-time concern, never part of generation/review.

## Delivery declaration

The direction declares the delivery resolution (`direction.policy.format.size.delivery`), which is also the aspect the working canvas is derived from; `video.tsx`'s `export.delivery` supplies only the matching upscale **function** (`{ video?, frame? }`) for one of two modes. An upscaler is required only when the delivery is more than `UPSCALER_REQUIRED_ABOVE` (1.2×) over the canvas (`deliveryNeedsUpscaler`) — below that the difference is the grid step the derived canvas lands off by, closed by the export crop. Each mode's value is a function konte calls with the injected inputs — `({ video, scale, width, height }) => AssetDefinition`, usually built via the `upscale(adapter, inputs)` helper — so the user explicitly wires whichever its upscaler takes (scale-based → `scale`; absolute/preset → `width`/`height`).

## Modes

- **`upscale.video`** (per-layer): each video layer is upscaled, then the composition is re-rendered at delivery resolution (text/overlays stay native — sharp). konte ffprobes each source so the injected `width`/`height` are its real size × `scale` (AR-preserving). For AR-preserving scale-based upscalers.
- **`upscale.frame`** (whole composited shot): each shot's composite is rendered at working size, upscaled as a whole, then the upscaled shots are stitched (text is upscaled with the frame). Works with any upscaler incl. resolution-preset ones; injected `width`/`height` = the delivery size. Cached on the composition's identity (definition + upstream fingerprints), so an unchanged shot is never re-upscaled.

## Export job

`konte export video` is async like `generate`: it registers an `export` job (a leaf render job, no address of its own) and returns. Each upscale runs as a normal generation job at a reserved `#delivery` address — `video:shot.01.motion#delivery` (per-layer) or `video:shot.01#composition#delivery` (frame) — accepted by konte on completion, with its own staleness cache; the export job depends on those and assembles when ready. `#delivery` targets are ordinary visible assets — `status`/`clean`/`prune` see them; a stale source re-upscales only on the next export. The export render runs locally in the worker under the same run lease as other jobs (see the `arch-jobs-guide` skill).

## Manifest

Each render writes `manifest.json` beside its `video.mp4` (`ExportManifestSchema`, `buildManifest` in `render-video.ts`): the variant every address resolved to, which state forgets once one is re-accepted or pruned.

`variants` maps address → `{ variantId, accepted }`. What a variant was made from is read from the project's TypeScript and its `definition.json` sidecar; nothing recoverable from either is copied in, and no paths. `derivedFrom` on a patch variant is the exception, naming `patches/<derivedFrom>.ts`: that lineage lives only in state. It covers every address the three definitions declare, plus the `#delivery` derivatives the graph does not list — a resolution snapshot, not a claim about which bytes reached the MP4. `exportSignature` is the job's, stamped here too so a deliverable outliving its job can still be called out of date; `probe export` `safeParse`s the file, reporting one it cannot read as absent.

The manifest's `id` (`mf-…`, fresh per render — a reclaimed job renders into its own directory) is burned into the MP4's container alongside `konte_version` and the signature, by a final stream-copy pass (`tagDeliverable`). A custom key needs `-movflags use_metadata_tags` — the mov muxer otherwise drops it with no error — and a later concat discards the lot, so the pass runs last, after the stitch and the mux; a failure there is a warning, never the render. `probe export` reads the tags back and says when the manifest beside a file does not describe it.
