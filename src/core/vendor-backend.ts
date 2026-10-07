import type { AssetDefinition, VendorBackendKind } from "./types/index.js";

// The kinds no vendor policy speaks about: `file` carries no backend, and `local` is konte's own
// ffmpeg plumbing (imageResize, videoTrim) rather than a vendor.
export function isVendorBackendAsset(
  kind: AssetDefinition["kind"],
): kind is VendorBackendKind & AssetDefinition["kind"] {
  return kind !== "file" && kind !== "local";
}
