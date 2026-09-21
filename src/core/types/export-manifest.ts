import { z } from "zod";

// The manifest an export writes beside its `video.mp4`: the variant every address resolved to at
// render time — the only record of what a deliverable was built from once state moves on.
//
// An entry is an address plus a variant id. What that variant was made from is read from the
// project's own TypeScript and the `definition.json` sidecar beside it, so anything recoverable
// from either is absent.
export const EXPORT_MANIFEST_FILE = "manifest.json";

// Keyed by address in the manifest's `variants` map.
export const ManifestVariantSchema = z.object({
  variantId: z.string(),
  // Whether this variant was accepted at render time. False does not imply a rough cut:
  // `allowUnaccepted` gates only what the render reached for, and the snapshot is wider.
  accepted: z.boolean(),
  // Patch variants only: the variant this one corrects, naming the script that made it —
  // `patches/<derivedFrom>.ts`. That lineage otherwise lives only in state; the patch step's own
  // address is declared in that script, so it is not among the addresses above.
  derivedFrom: z.string().optional(),
});
export type ManifestVariant = z.infer<typeof ManifestVariantSchema>;

export const ManifestShotSchema = z.object({
  shotId: z.string(),
  duration: z.number(),
  warnings: z.array(z.string()),
});
export type ManifestShot = z.infer<typeof ManifestShotSchema>;

export const ExportManifestSchema = z.object({
  // This render's own identity, burned into the deliverable's container metadata as
  // `konte_manifest`. Fresh per render, not per job: a reclaimed export job renders again into its
  // own directory.
  id: z.string(),
  konteVersion: z.string(),
  renderedAt: z.string(),
  // `computeExportSignature` over the definition this render actually read — what `status` and
  // `probe export` compare against to call a deliverable out of date. Null for a `--no-delivery`
  // check render.
  exportSignature: z.string().nullable(),
  allowUnaccepted: z.boolean(),
  fps: z.number(),
  // What was actually rendered — the delivery resolution when a delivery upscale applied.
  size: z.object({ width: z.number(), height: z.number() }),
  // Which delivery path produced the deliverable: per-layer (`video`), whole-frame (`frame`), or
  // none — the working-size render.
  deliveryUpscale: z.enum(["video", "frame"]).nullable(),
  // Every address this render resolved, across all three stages, plus the `#delivery` derivatives
  // it upscaled through — a resolution snapshot, not a claim about which bytes reached the MP4. A
  // per-layer upscale swaps the picture while the mux keeps the source audio, so "consumed" has no
  // single meaning. Sorted by address.
  variants: z.record(z.string(), ManifestVariantSchema),
  shots: z.array(ManifestShotSchema),
  warnings: z.array(z.string()),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
