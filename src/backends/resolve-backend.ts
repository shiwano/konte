import { ComfyApiBackend } from "../comfy-api/backend.js";
import { ComfyUIBackend } from "../comfyui/backend.js";
import { resolveComfyUIConfig } from "../comfyui/config.js";
import type { GenerationBackend } from "../core/backend.js";
import type { VideoRoots } from "../core/roots.js";
import type { AssetDefinition, BackendKind, JobRecord } from "../core/types/index.js";
import { FalBackend } from "../fal/backend.js";
import { resolveFalConfig } from "../fal/config.js";
import { LocalBackend } from "../local/backend.js";

export function getBackendKind(assetDef: AssetDefinition): BackendKind | null {
  switch (assetDef.kind) {
    case "comfy":
      return "comfy";
    case "fal":
      return "fal";
    case "local":
      return "local";
    case "file":
      return null;
  }
}

export function getBackendKindFromJob(job: JobRecord): BackendKind {
  return job.backendKind;
}

// Only the comfy backends span both roots: its workflows and adapters are workspace-wide, while
// the files it reads and writes belong to one video. The others take the video root alone, so the
// type stops them from reaching for the workspace later. Given the job, the backend is rebuilt as
// the one it was submitted on, from what its submit recorded.
export async function resolveBackend(
  kind: BackendKind,
  roots: VideoRoots,
  job?: JobRecord,
): Promise<GenerationBackend> {
  switch (kind) {
    case "comfy": {
      const config = await resolveComfyUIConfig(roots.workspace);
      const clientId = job?.metadata.comfyClientId;
      return new ComfyUIBackend(
        { ...config, clientId: typeof clientId === "string" ? clientId : undefined },
        roots,
      );
    }
    case "comfy-api":
      return new ComfyApiBackend(roots);
    case "fal": {
      const config = await resolveFalConfig();
      return new FalBackend(config, roots.video);
    }
    case "local":
      return new LocalBackend(roots.video);
  }
}
