import { resolveHeaderTokens } from "../comfyui/token-resolver.js";
import { type AssetStage, type DefinitionLike, getAssetEntry, listAssetPaths } from "./address.js";
import { KonteError } from "./errors.js";
import { isVendorBackendAsset } from "./vendor-backend.js";
import { backendCredential } from "./types/credentials.js";
import { VendorBackendKindSchema } from "./types/job.js";
import type {
  AssetDefinition,
  ComfyTarget,
  KonteConfig,
  VendorBackendKind,
} from "./types/index.js";
import { type DeploymentReadiness, deploymentReadiness } from "../comfy-api/deployment.js";
import {
  COMFY_API_KEY_ENV,
  ComfyRouter,
  comfyApiKey,
  deploymentNameOf,
} from "../comfy-api/routing.js";

export const spendGateHooks: {
  deploymentReadiness: (
    workspaceRoot: string,
    config: KonteConfig,
    name: string,
    router: ComfyRouter,
  ) => Promise<DeploymentReadiness>;
} = {
  deploymentReadiness: (workspaceRoot, config, name, router) =>
    deploymentReadiness({ workspaceRoot, config, apiKey: comfyApiKey() ?? "", router }, name),
};

type UnconfiguredBackendAsset = { address: string; kind: VendorBackendKind };

/**
 * Whether this workspace has what it takes to generate on a vendor backend, which is also what
 * authorizes the spend. For comfy that is any target it could route to — whether one actually takes
 * a given asset is the spend gate's question (`ComfyRouter`).
 *
 * Never a connectivity probe. This answers the same way offline, and a ComfyUI that is merely down
 * is one konte's jobs already wait out (see `unreachableTimeoutMinutes`).
 */
export function isBackendConfigured(kind: VendorBackendKind, config: KonteConfig): boolean {
  if (kind === "comfy") return (config.comfy?.comfyui?.url ?? "") !== "" || comfyApiKey() !== null;
  const credential = backendCredential(kind);
  return credential ? (process.env[credential.key] ?? "") !== "" : true;
}

export function configuredVendorBackends(config: KonteConfig): VendorBackendKind[] {
  return VendorBackendKindSchema.options.filter((kind) => isBackendConfigured(kind, config));
}

/** Where a vendor backend is turned on, for the message that says it is off. */
export function backendSetupHint(kind: VendorBackendKind): string {
  if (kind === "comfy") {
    return (
      'set "comfy.comfyui.url" in konte.config.json (or `konte settings`, Config tab), or ' +
      `${COMFY_API_KEY_ENV} for comfycloud / comfyapi:<name> — ` +
      backendCredential("comfy-api")!.obtainUrl
    );
  }
  const credential = backendCredential(kind);
  return credential
    ? `set ${credential.key} (\`konte settings\`, Credentials tab, or export it) — ${credential.obtainUrl}`
    : `configure ${kind}`;
}

// The stage's assets on a vendor backend this workspace has not configured. Checked at the
// definition level (every declared asset, not just what a run would submit) so the result is
// deterministic.
export function unconfiguredBackendAssets(
  def: DefinitionLike,
  stage: AssetStage,
  config: KonteConfig,
): UnconfiguredBackendAsset[] {
  const out: UnconfiguredBackendAsset[] = [];
  for (const assetPath of listAssetPaths(def, stage)) {
    const kind = getAssetEntry(def, assetPath).kind;
    if (!isVendorBackendAsset(kind)) continue;
    if (!isBackendConfigured(kind, config)) {
      out.push({ address: assetPath, kind });
    }
  }
  return out;
}

/** One line naming every backend a set of unusable assets needs, and how to turn each one on. */
export function backendSetupAdvice(kinds: Iterable<VendorBackendKind>): string {
  return [...new Set(kinds)].map((kind) => `${kind}: ${backendSetupHint(kind)}`).join("; ");
}

/** One asset a run is about to spend on: what to call it in a refusal, and its definition. */
export type SpendItem = { label: string; def: AssetDefinition };

/** Where each comfy asset the gate passed runs. */
export class SpendRoutes {
  private readonly byKey: ReadonlyMap<string, ComfyTarget>;
  /** Every comfy item the gate routed, in the order it was handed them. */
  readonly routed: ReadonlyArray<{ label: string; target: ComfyTarget }>;

  constructor(
    byKey: ReadonlyMap<string, ComfyTarget>,
    routed: ReadonlyArray<{ label: string; target: ComfyTarget }>,
  ) {
    this.byKey = byKey;
    this.routed = routed;
  }

  /** The target a comfy definition the gate saw was routed to; null for any other kind. */
  targetOf(def: AssetDefinition): ComfyTarget | null {
    if (def.kind !== "comfy") return null;
    return this.byKey.get(routeKeyOf(def)) ?? "comfyui";
  }

  /** The deployments this spend runs on. */
  deployments(): string[] {
    const names = new Set<string>();
    for (const { target } of this.routed) {
      const name = deploymentNameOf(target);
      if (name !== null) names.add(name);
    }
    return [...names];
  }
}

function routeKeyOf(def: AssetDefinition & { kind: "comfy" }): string {
  return ComfyRouter.subjectKey({
    workflow: def.workflow,
    models: def.models ?? [],
    prunedNodes: def.prunedNodes,
    prunedPassThroughs: def.prunedPassThroughs,
  });
}

/**
 * THE spend gate. Every entry point that can create a generation job — `generate`, `reroll`,
 * `patch apply`, `export`'s delivery upscale — passes its work through here first, and nothing
 * else authorizes a spend.
 *
 * Its questions share one deadline, before a variant id is reserved or a job file written: is this
 * backend configured at all, where does each comfy asset run, and are the credentials it needs
 * resolvable, and is each Comfy API deployment it reaches built and deployed.
 */
export async function assertSpendAllowed(
  items: readonly SpendItem[],
  config: KonteConfig,
  workspaceRoot: string,
): Promise<SpendRoutes> {
  const unconfigured: Array<{ label: string; kind: VendorBackendKind }> = [];
  const comfyItems: Array<{ label: string; def: AssetDefinition & { kind: "comfy" } }> = [];
  for (const item of items) {
    if (item.def.kind === "comfy") {
      comfyItems.push({ label: item.label, def: item.def });
      continue;
    }
    if (!isVendorBackendAsset(item.def.kind)) continue;
    if (isBackendConfigured(item.def.kind, config)) continue;
    unconfigured.push({ label: item.label, kind: item.def.kind });
  }
  if (unconfigured.length > 0) {
    throw new KonteError(
      "BACKEND_NOT_CONFIGURED",
      `${unconfigured.length} asset(s) need a backend this workspace has not configured — ` +
        backendSetupAdvice(unconfigured.map((v) => v.kind)),
      unconfigured.map((v) => `  ${v.label} (${v.kind})`),
    );
  }

  const byKey = new Map<string, ComfyTarget>();
  const routed: Array<{ label: string; target: ComfyTarget }> = [];
  if (comfyItems.length > 0) {
    const router = new ComfyRouter(workspaceRoot, config);
    const unroutable: string[] = [];
    for (const { label, def } of comfyItems) {
      const route = await router.route(def);
      if (route.kind === "unroutable") {
        unroutable.push(`  ${label} (comfy) — ${route.reasons.join("; ")}`);
      } else {
        byKey.set(routeKeyOf(def), route.target);
        routed.push({ label, target: route.target });
        if (deploymentNameOf(route.target) !== null) assertNoAuthenticatedModel(label, def);
      }
    }
    if (unroutable.length > 0) {
      throw new KonteError(
        "BACKEND_NOT_CONFIGURED",
        `${unroutable.length} comfy asset(s) have no target in comfy.adapters that can run them — ` +
          backendSetupHint("comfy"),
        unroutable,
      );
    }
    const routes = new SpendRoutes(byKey, routed);
    const notReady: string[] = [];
    for (const name of routes.deployments()) {
      const readiness = await spendGateHooks.deploymentReadiness(
        workspaceRoot,
        config,
        name,
        router,
      );
      if (readiness.kind === "unbuilt") {
        notReady.push(`  comfyapi:${name} — its Build is missing or older than its adapters`);
      } else if (readiness.kind === "undeployed") {
        notReady.push(`  comfyapi:${name} — no ready deployment of release ${readiness.releaseId}`);
      }
    }
    if (notReady.length > 0) {
      throw new KonteError(
        "COMFY_API_DEPLOYMENT_NOT_READY",
        `${notReady.length} Comfy API deployment(s) this run reaches cannot take jobs. Run ` +
          `\`konte adapter comfy build\`, deploy the Build on the page it opens, and run it again.`,
        notReady,
      );
    }
  }

  // A configured backend may still be missing a credential the config only names.
  if (routed.some((r) => r.target === "comfyui")) {
    resolveHeaderTokens(config.comfy?.comfyui?.headers ?? {});
  }
  return new SpendRoutes(byKey, routed);
}

// A deployment's Build keeps every model URL it is given, so one carrying a credential is refused.
function assertNoAuthenticatedModel(label: string, def: AssetDefinition & { kind: "comfy" }): void {
  const secret = (def.models ?? []).filter((m) => m.url.includes("${"));
  if (secret.length === 0) return;
  throw new KonteError(
    "COMFY_API_AUTHENTICATED_MODEL",
    `${label} routes to a Comfy API deployment, but its model URL carries a credential, which a ` +
      `Build definition would keep: ${secret.map((m) => m.filename).join(", ")}. Route this ` +
      `adapter to comfyui or comfycloud in comfy.adapters.`,
  );
}

/** Everything a stage declares, as spend items — definition-level, so the gate is deterministic. */
export function stageSpendItems(def: DefinitionLike, stage: AssetStage): SpendItem[] {
  return listAssetPaths(def, stage).map((address) => ({
    label: address,
    def: getAssetEntry(def, address),
  }));
}
