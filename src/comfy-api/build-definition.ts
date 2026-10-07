import { createHash } from "node:crypto";
import { z } from "zod";
import { modelPathSegments } from "../comfyui/model-destination.js";
import { loadAdapterCatalog } from "../core/adapter-catalog.js";
import { KonteError } from "../core/errors.js";
import { API_REQUEST_TIMEOUT_MS, fetchWithRetry } from "../core/http-retry.js";
import { stableStringify } from "../core/stable-stringify.js";
import type {
  ComfyModelDeclaration,
  ComfyNodeDeclaration,
  ComfyTarget,
} from "../core/types/index.js";
import type { DeploymentState } from "./deploy-state.js";
import type { ComfyRouter } from "./routing.js";

const REGISTRY_NODE = "https://api.comfy.org/nodes/";

export type ComfyAdapterDeclarations = {
  workflow: string;
  models: readonly ComfyModelDeclaration[];
  nodes: readonly ComfyNodeDeclaration[];
};

export type BuildModel = { type: string; filename: string; sourceUri: string };

/** What a Build is made of before any version is resolved. */
export type BuildInputs = {
  models: BuildModel[];
  nodeIds: string[];
  comfyVersion: string;
};

export type BuildDefinition = {
  baseComfyVersion: string;
  models: BuildModel[];
  customNodes: Array<{ name: string; id: string; registryVersion: string }>;
};

export type VersionResolvers = {
  registryVersion: (nodeId: string) => Promise<string>;
};

export function hashOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Every comfy adapter in the workspace, with the declarations a Build installs. */
export async function workspaceComfyAdapters(
  workspaceRoot: string,
): Promise<ComfyAdapterDeclarations[]> {
  const { entries } = await loadAdapterCatalog(workspaceRoot);
  return entries
    .filter((e) => e.meta.backend === "comfy" && e.importFrom !== "konte")
    .map((e) => ({ workflow: e.meta.ref, models: e.meta.models ?? [], nodes: e.meta.nodes ?? [] }));
}

/** The adapters whose whole-adapter route lands on `target`. */
export async function adaptersRoutedTo(
  adapters: readonly ComfyAdapterDeclarations[],
  target: ComfyTarget,
  router: ComfyRouter,
): Promise<ComfyAdapterDeclarations[]> {
  const out: ComfyAdapterDeclarations[] = [];
  for (const adapter of adapters) {
    const route = await router.routeAdapter(adapter.workflow, adapter.models);
    if (route.kind === "routed" && route.target === target) out.push(adapter);
  }
  return out;
}

/**
 * One Build's inputs from the adapters routed to it: models by `type` + `filename`, node packs by
 * id, each once. Two adapters naming one model file from different URLs are a configuration error.
 */
export function buildInputs(
  adapters: readonly ComfyAdapterDeclarations[],
  comfyVersion: string,
): BuildInputs {
  const models = new Map<string, BuildModel & { from: string }>();
  const nodeIds = new Set<string>();
  for (const adapter of adapters) {
    for (const model of adapter.models) {
      if (model.url.includes("${")) {
        throw new KonteError(
          "COMFY_API_AUTHENTICATED_MODEL",
          `${adapter.workflow} declares ${model.filename} at a URL carrying a credential, which a ` +
            `Build definition would keep. Route this adapter to comfyui or comfycloud in ` +
            `comfy.adapters.`,
        );
      }
      const [type, ...rest] = modelPathSegments(model);
      const entry = { type: type!, filename: rest.join("/"), sourceUri: model.url };
      const key = `${entry.type}/${entry.filename}`;
      const existing = models.get(key);
      if (existing && existing.sourceUri !== entry.sourceUri) {
        throw new KonteError(
          "VALIDATION_FAILED",
          `${existing.from} and ${adapter.workflow} both declare ${key} but from different URLs ` +
            `(${existing.sourceUri} / ${entry.sourceUri}) — one Build can hold only one.`,
        );
      }
      if (!existing) models.set(key, { ...entry, from: adapter.workflow });
    }
    for (const node of adapter.nodes) nodeIds.add(node.id);
  }
  return {
    models: [...models.values()]
      .map(({ from: _from, ...m }) => m)
      .sort((a, b) => `${a.type}/${a.filename}`.localeCompare(`${b.type}/${b.filename}`)),
    nodeIds: [...nodeIds].sort(),
    comfyVersion,
  };
}

/**
 * The Build definition, with each pack's registry version pinned. A pin is resolved again only when
 * the inputs changed for another reason; otherwise the recorded one stands, so a pack's release
 * upstream never rebuilds a deployment on its own.
 */
export async function resolveBuildDefinition(
  inputs: BuildInputs,
  pinned: Pick<DeploymentState, "inputsHash" | "registryVersions">,
  resolvers: VersionResolvers,
): Promise<{
  definition: BuildDefinition;
  inputsHash: string;
  registryVersions: Record<string, string>;
}> {
  const inputsHash = hashOf(inputs);
  const keep = pinned.inputsHash === inputsHash;
  const registryVersions: Record<string, string> = {};
  for (const id of inputs.nodeIds) {
    const kept = keep ? pinned.registryVersions[id] : undefined;
    registryVersions[id] = kept ?? (await resolvers.registryVersion(id));
  }
  return {
    definition: {
      baseComfyVersion: inputs.comfyVersion,
      models: inputs.models,
      customNodes: inputs.nodeIds.map((id) => ({
        name: id,
        id,
        registryVersion: registryVersions[id]!,
      })),
    },
    inputsHash,
    registryVersions,
  };
}

const RegistryNodeSchema = z
  .object({ latest_version: z.object({ version: z.string() }).passthrough().nullable().optional() })
  .passthrough();

export const DEFAULT_VERSION_RESOLVERS: VersionResolvers = {
  async registryVersion(nodeId) {
    const res = await fetchWithRetry(`${REGISTRY_NODE}${encodeURIComponent(nodeId)}`, undefined, {
      timeoutMs: API_REQUEST_TIMEOUT_MS,
    });
    const parsed = res.ok ? RegistryNodeSchema.safeParse(await res.json()) : null;
    const version = parsed?.success ? parsed.data.latest_version?.version : undefined;
    if (!version) {
      throw new KonteError(
        "COMFY_API_ERROR",
        `Node pack "${nodeId}" has no published version on the Comfy Registry (${res.status}). ` +
          `A Comfy API Build installs registry packs only; route this adapter to comfyui.`,
      );
    }
    return version;
  },
};
