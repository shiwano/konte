import type { AssetDefinition } from "./types/index.js";

// Metadata field on a generation job recording which adapter produced it,
// stamped at submit time so job-duration stats can group by adapterKey
// using the adapter as it was at run time (the definition may change later).
export const ADAPTER_KEY_METADATA_KEY = "adapterKey";

// A human-readable, stable adapter identity derived from an asset definition.
// fal exposes the endpoint string; local the operation; comfy the
// workflow filename. `file` assets carry no generation, so they have no key.
export function adapterKeyFor(def: AssetDefinition): string {
  switch (def.kind) {
    case "fal":
      return def.endpointId;
    case "local":
      return def.operation;
    case "comfy":
      return def.workflow;
    case "file":
      return "";
  }
}
