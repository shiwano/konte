import { resolveHeaderTokens } from "../comfyui/token-resolver.js";
import { type AssetStage, type DefinitionLike, getAssetEntry, listAssetPaths } from "./address.js";
import { KonteError } from "./errors.js";
import { backendCredential } from "./types/credentials.js";
import { VendorBackendKindSchema } from "./types/job.js";
import type { AssetDefinition, KonteConfig, VendorBackendKind } from "./types/index.js";

type UnconfiguredBackendAsset = { address: string; kind: VendorBackendKind };

// The kinds no vendor policy speaks about: `file` carries no backend, and `local` is konte's own
// ffmpeg plumbing (imageResize, videoTrim) rather than a vendor.
export function isVendorBackendAsset(
  kind: AssetDefinition["kind"],
): kind is VendorBackendKind & AssetDefinition["kind"] {
  return kind !== "file" && kind !== "local";
}

/**
 * Whether this workspace has what it takes to generate on a vendor backend, which is also what
 * authorizes the spend.
 *
 * Never a connectivity probe. This answers the same way offline, and a ComfyUI that is merely down
 * is one konte's jobs already wait out (see `unreachableTimeoutMinutes`).
 */
export function isBackendConfigured(kind: VendorBackendKind, config: KonteConfig): boolean {
  if (kind === "comfy") return (config.comfyui?.url ?? "") !== "";
  const credential = backendCredential(kind);
  return credential ? (process.env[credential.key] ?? "") !== "" : true;
}

export function configuredVendorBackends(config: KonteConfig): VendorBackendKind[] {
  return VendorBackendKindSchema.options.filter((kind) => isBackendConfigured(kind, config));
}

/** Where a vendor backend is turned on, for the message that says it is off. */
export function backendSetupHint(kind: VendorBackendKind): string {
  if (kind === "comfy") {
    return 'set "comfyui.url" in konte.config.json (or `konte settings`, Config tab)';
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

/** One asset a run is about to spend on: what to call it in a refusal, and what it runs on. */
export type SpendItem = { label: string; kind: AssetDefinition["kind"] };

/**
 * THE spend gate. Every entry point that can create a generation job — `generate`, `reroll`,
 * `patch apply`, `export`'s delivery upscale — passes its work through here first, and nothing
 * else authorizes a spend.
 *
 * Both questions it answers share one deadline, before a variant id is reserved or a job file
 * written: is this backend configured at all, and are the credentials it needs resolvable.
 */
export function assertSpendAllowed(items: readonly SpendItem[], config: KonteConfig): void {
  const unconfigured: Array<{ label: string; kind: VendorBackendKind }> = [];
  for (const item of items) {
    if (!isVendorBackendAsset(item.kind)) continue;
    if (isBackendConfigured(item.kind, config)) continue;
    unconfigured.push({ label: item.label, kind: item.kind });
  }
  if (unconfigured.length > 0) {
    const list = unconfigured.map((v) => `  ${v.label} (${v.kind})`).join("\n");
    throw new KonteError(
      "BACKEND_NOT_CONFIGURED",
      `These need a backend this workspace has not configured:\n${list}\n\n` +
        backendSetupAdvice(unconfigured.map((v) => v.kind)),
    );
  }

  // A configured backend may still be missing a credential the config only names.
  if (items.some((item) => item.kind === "comfy")) {
    resolveHeaderTokens(config.comfyui?.headers ?? {});
  }
}

/** Everything a stage declares, as spend items — definition-level, so the gate is deterministic. */
export function stageSpendItems(def: DefinitionLike, stage: AssetStage): SpendItem[] {
  return listAssetPaths(def, stage).map((address) => ({
    label: address,
    kind: getAssetEntry(def, address).kind,
  }));
}
