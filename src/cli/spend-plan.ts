import {
  assertSpendAllowed,
  type SpendItem,
  type SpendRoutes,
} from "../backends/backend-policy.js";
import { resolveComfyUIConfig } from "../comfyui/config.js";
import { ComfyProvisioner } from "../comfyui/provisioner.js";
import { resolveUrlTokens } from "../comfyui/token-resolver.js";
import { comfyModelJobId, type JobManager } from "../core/job-manager.js";
import { formatNotice } from "../core/notice.js";
import { capInline } from "./format-list.js";
import type { VideoRoots } from "../core/roots.js";
import type { UndecidedUpstreamVariant } from "../core/staleness.js";
import type {
  AssetDefinition,
  ComfyModelDeclaration,
  ComfyTarget,
  KonteConfig,
} from "../core/types/index.js";

/**
 * A presence sweep's verdict: which install targets need provisioning, and whether the server was
 * actually observed saying so.
 *
 * The distinction is load-bearing. An unreachable ComfyUI reports EVERY target missing so an
 * offline run still queues the work (the worker re-checks before spending). That fallback is safe
 * for "create a job", and unsafe for "conclude the file is gone" — which is what resetting a
 * completed provisioning record asserts. Only `confirmed` licenses the second.
 */
export type MissingComfyAssets = { ids: Set<string>; confirmed: boolean };

/**
 * The node sweep additionally reports packs that ARE installed on disk but are not loaded into the
 * running ComfyUI. They need no download — only the reboot that registers their node classes.
 *
 * Without this the gap was silent: the missing-check reads ComfyUI-Manager's on-disk state, so a
 * pack that failed to import, or that landed while the server was already up, produced no install
 * job, hence no activation, hence a generation job submitted straight into a server with no such
 * node class.
 */
type MissingComfyNodeAssets = MissingComfyAssets & { unloaded: Set<string> };

// Which of the given comfy models are not yet present in ComfyUI, as a set of `comfyModelJobId`
// keys — one declaration's install target, not its filename, since a directory-shaped model
// carries the same filename (`config.json`) at several savePaths. A best effort: an empty result
// (so no download jobs are created) only when auto-install is on AND ComfyUI confirms every model
// is already there. When auto-install is off, or ComfyUI is unreachable, all are reported missing
// so callers create download jobs (preserving the offline-resilient behaviour).
//
// `confirmed` carries whether that answer was observed or assumed, because the two license
// different actions downstream — see MissingComfyAssets.
async function resolveMissingComfyModels(
  roots: VideoRoots,
  models: readonly ComfyModelDeclaration[],
  autoInstallModels: boolean,
): Promise<MissingComfyAssets> {
  if (!autoInstallModels || models.length === 0) return { ids: new Set(), confirmed: true };
  const config = await resolveComfyUIConfig(roots.workspace);
  const { managerClient } = new ComfyProvisioner(config);
  const { missing, confirmed } = await managerClient.filterMissingModels(models);
  return { ids: new Set(missing.map(comfyModelJobId)), confirmed };
}

// Which declared comfy node-pack cnr_ids are not yet installed in ComfyUI. Same best-effort
// contract as resolveMissingComfyModels: empty only when auto-install is on AND ComfyUI
// confirms every pack is present; otherwise all are reported missing.
async function resolveMissingComfyNodes(
  roots: VideoRoots,
  cnrIds: readonly string[],
  autoInstallNodes: boolean,
): Promise<MissingComfyNodeAssets> {
  if (!autoInstallNodes || cnrIds.length === 0) {
    return { ids: new Set(), confirmed: true, unloaded: new Set() };
  }
  const config = await resolveComfyUIConfig(roots.workspace);
  const { managerClient } = new ComfyProvisioner(config);
  const { missing, confirmed } = await managerClient.filterMissingNodes(cnrIds);
  const ids = new Set(missing);
  // Only the ones already on disk can be merely unloaded; the rest are covered by their install.
  // An unobservable answer yields nothing — a reboot is too destructive to schedule on a guess,
  // and `activateNodes` re-checks before it reboots anyway.
  const installed = cnrIds.filter((id) => !ids.has(id));
  const loaded = await managerClient.filterUnloadedNodes(installed);
  return { ids, confirmed, unloaded: new Set(loaded.kind === "known" ? loaded.unloaded : []) };
}

type ComfyDownloadNotice = {
  // Each entry keeps the addresses that reference it (a model can be shared across assets).
  // `savePath` disambiguates the entries a directory-shaped model contributes — several of its
  // files share a filename and only the install target tells them apart.
  models: Array<{
    filename: string;
    type: string;
    savePath?: string;
    displayName?: string;
    addresses: string[];
  }>;
  nodes: Array<{ id: string; addresses: string[] }>;
};

// Collect the declared comfy models/nodes flagged missing, deduped by install target/id,
// aggregating the addresses of every asset that declares each one. `missingModels`/
// `missingNodes` come from resolveMissingComfy*: best-effort sets that over-report when
// ComfyUI is unreachable, so the notice is phrased "skipped if already present".
export function collectComfyDownloads(
  entries: Iterable<{ address: string; def: AssetDefinition }>,
  missingModels: ReadonlySet<string>,
  missingNodes: ReadonlySet<string>,
): ComfyDownloadNotice {
  const models = new Map<string, ComfyDownloadNotice["models"][number]>();
  const nodes = new Map<string, ComfyDownloadNotice["nodes"][number]>();

  for (const { address, def } of entries) {
    if (def.kind !== "comfy") continue;
    for (const model of def.models ?? []) {
      const key = comfyModelJobId(model);
      if (!missingModels.has(key)) continue;
      const existing = models.get(key);
      if (existing) {
        if (!existing.addresses.includes(address)) existing.addresses.push(address);
      } else {
        models.set(key, {
          filename: model.filename,
          type: model.type,
          savePath: model.savePath,
          displayName: model.displayName,
          addresses: [address],
        });
      }
    }
    for (const node of def.nodes ?? []) {
      if (!missingNodes.has(node.id)) continue;
      const existing = nodes.get(node.id);
      if (existing) {
        if (!existing.addresses.includes(address)) existing.addresses.push(address);
      } else {
        nodes.set(node.id, { id: node.id, addresses: [address] });
      }
    }
  }

  return { models: [...models.values()], nodes: [...nodes.values()] };
}

type ComfyPreflight = {
  missingModels: MissingComfyAssets;
  missingNodes: MissingComfyNodeAssets;
  downloads: ComfyDownloadNotice;
};

// Which declared comfy models/nodes the given comfy assets need that ComfyUI does not have (one
// ComfyUI/Manager query for the whole list; a present one gets no job, an unreachable ComfyUI
// reports all missing), plus the notice naming each missing one's consumers.
async function preflightComfyAssets(
  roots: VideoRoots,
  entries: ReadonlyArray<{ address: string; def: AssetDefinition }>,
  config: KonteConfig,
): Promise<ComfyPreflight> {
  const declaredModels = new Map<string, ComfyModelDeclaration>();
  const declaredNodeIds = new Set<string>();
  for (const { def } of entries) {
    if (def.kind !== "comfy") continue;
    for (const m of def.models ?? []) declaredModels.set(comfyModelJobId(m), m);
    for (const n of def.nodes ?? []) declaredNodeIds.add(n.id);
  }
  const missingModels = await resolveMissingComfyModels(
    roots,
    [...declaredModels.values()],
    config.comfy?.comfyui?.autoInstallModels ?? true,
  );
  const missingNodes = await resolveMissingComfyNodes(
    roots,
    [...declaredNodeIds],
    config.comfy?.comfyui?.autoInstallNodes ?? true,
  );
  return {
    missingModels,
    missingNodes,
    downloads: collectComfyDownloads(entries, missingModels.ids, missingNodes.ids),
  };
}

/**
 * What one run may spend and on what: the spend gate's routes, and the provisioning each comfy
 * asset on a ComfyUI waits on.
 */
export class SpendPlan {
  constructor(
    private readonly routes: SpendRoutes,
    private readonly preflight: ComfyPreflight,
  ) {}

  targetOf(def: AssetDefinition): ComfyTarget | null {
    return this.routes.targetOf(def);
  }

  get missingModels(): ReadonlySet<string> {
    return this.preflight.missingModels.ids;
  }

  get missingNodes(): ReadonlySet<string> {
    return this.preflight.missingNodes.ids;
  }

  get downloads(): ComfyDownloadNotice {
    return this.preflight.downloads;
  }

  /** The provisioning jobs an asset's generation job depends on, created if missing. */
  prereqJobs(def: AssetDefinition, jobManager: JobManager): Promise<string[]> {
    return ensureComfyPrereqJobs(
      def,
      this.targetOf(def),
      jobManager,
      this.preflight.missingModels,
      this.preflight.missingNodes,
    );
  }

  notices(): string[] {
    return [
      formatComfyDownloadNotice(this.downloads),
      formatComfyRouteNotice(this.routes.routed),
    ].filter((notice) => notice !== null);
  }
}

/** The spend gate, then the ComfyUI presence sweep over what it routed to a ComfyUI. */
export async function prepareSpend(
  roots: VideoRoots,
  items: readonly SpendItem[],
  config: KonteConfig,
): Promise<SpendPlan> {
  const routes = await assertSpendAllowed(items, config, roots.workspace);
  const onComfyUI = items
    .filter((item) => item.def.kind === "comfy" && routes.targetOf(item.def) === "comfyui")
    .map((item) => ({ address: item.label, def: item.def }));
  return new SpendPlan(routes, await preflightComfyAssets(roots, onComfyUI, config));
}

export function printSpendNotices(plan: SpendPlan): void {
  for (const notice of plan.notices()) console.log(`\n${notice}`);
}

// A concise English notice listing the comfy downloads/installs a run will trigger,
// or null when nothing is pending. Model-primary (one line per download); shared
// models show the first address plus a "(+N more)" suffix.
export function formatComfyDownloadNotice(notice: ComfyDownloadNotice): string | null {
  if (notice.models.length === 0 && notice.nodes.length === 0) return null;

  const formatAddresses = (addresses: string[]): string => capInline(addresses, { cap: 1 });

  const lines: string[] = [];
  for (const m of notice.models) {
    const label = m.displayName ?? (m.savePath ? `${m.savePath}/${m.filename}` : m.filename);
    lines.push(`download  ${label} (${m.type})  — ${formatAddresses(m.addresses)}`);
  }
  for (const n of notice.nodes) {
    lines.push(`install   ${n.id} (custom node)  — ${formatAddresses(n.addresses)}`);
  }
  return formatNotice("first-time setup before generation (skipped if already present):", lines);
}

/**
 * Where this run's comfy assets go — the spend a reader cannot see from the definitions. Null when
 * nothing is routed off a ComfyUI.
 */
function formatComfyRouteNotice(
  routed: ReadonlyArray<{ label: string; target: ComfyTarget }>,
): string | null {
  if (routed.every((r) => r.target === "comfyui")) return null;
  return formatNotice(
    "where this run's comfy assets go:",
    routed.map((r) => `${r.label} → ${r.target}`),
  );
}

// A pre-flight warning that one or more upstreams carry an undecided take (e.g. from a reroll)
// that this run will NOT use — dependency resolution binds the accepted variant, so the downstream
// builds on the accepted frame until that take is accepted in its place. The take is not
// necessarily newer than the accept, so the wording claims no order. Null when clean.
export function formatUndecidedUpstreamVariantsNotice(
  variants: readonly UndecidedUpstreamVariant[],
): string | null {
  if (variants.length === 0) return null;
  const lines = variants.map(
    (t) =>
      `${t.address}: ${t.undecidedVariantId} undecided — using accepted ${t.acceptedVariantId}`,
  );
  lines.push("Review and accept the undecided take first if this run should build on it instead.");
  return formatNotice(
    "upstream has an undecided take this run will NOT use (it resolves the accepted variant):",
    lines,
  );
}

// Ensure a comfy-model-download job exists for each declared model that is still
// missing, returning their job ids so the generation job can depend on them.
// Models already present in ComfyUI get no job (the generation job submits without
// waiting); see resolveMissingComfyModels for how `missing` is determined.
export async function ensureComfyModelJobs(
  assetDef: AssetDefinition,
  jobManager: JobManager,
  missing: MissingComfyAssets,
): Promise<string[]> {
  if (assetDef.kind !== "comfy" || !assetDef.models || assetDef.models.length === 0) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const model of assetDef.models) {
    const key = comfyModelJobId(model);
    if (seen.has(key) || !missing.ids.has(key)) continue;
    seen.add(key);
    // Validate the URL's ${VAR} tokens resolve now (fail fast with MISSING_TOKEN),
    // but store only the unresolved declaration — the worker re-resolves at
    // download time so secrets never land in the job file.
    resolveUrlTokens(model.url);
    // Only a CONFIRMED absence may retire a completed record. An unreachable ComfyUI reports
    // everything missing, and resetting on that would churn every provisioning job in the project
    // back to pending on any offline run.
    const { id } = await jobManager.ensureComfyModelDownloadJob(model, {
      resetCompleted: missing.confirmed,
    });
    ids.push(id);
  }
  return ids;
}

// Ensure an install job exists for each declared custom node pack that is still missing, then
// ensure the one comfy-node-activate job depending on those installs (it reboots ComfyUI once so
// the new nodes load). Returns the activate job id(s) so the generation job depends on it —
// nothing generates until the nodes are live. Returns [] when nothing is missing. Called per
// asset, but every asset of a run is missing the same packs, so they all converge on one
// activate job (see comfyNodeActivateJobId).
async function ensureComfyNodeJobs(
  assetDef: AssetDefinition,
  jobManager: JobManager,
  missing: MissingComfyNodeAssets,
): Promise<string[]> {
  if (assetDef.kind !== "comfy" || !assetDef.nodes || assetDef.nodes.length === 0) return [];

  const installIds: string[] = [];
  const activateCnrIds: string[] = [];
  const seen = new Set<string>();
  for (const node of assetDef.nodes) {
    if (seen.has(node.id) || !missing.ids.has(node.id)) continue;
    seen.add(node.id);
    // See ensureComfyModelJobs: an unconfirmed miss may create work, never retire a record.
    const { id } = await jobManager.ensureComfyNodeInstallJob(node, {
      resetCompleted: missing.confirmed,
    });
    installIds.push(id);
    activateCnrIds.push(node.id);
  }
  // Installed but not loaded: no download to wait on, just the reboot that registers the classes.
  for (const node of assetDef.nodes) {
    if (seen.has(node.id) || !missing.unloaded.has(node.id)) continue;
    seen.add(node.id);
    activateCnrIds.push(node.id);
  }
  if (activateCnrIds.length === 0) return [];

  // Whether the activation is still valid is decided from its dependencies' live state, not from
  // whether THIS process was the one that reset an install: with two processes racing, only one
  // sees the transition, and the other would happily reuse an activation that no longer holds.
  const { id } = await jobManager.ensureComfyNodeActivateJob({
    dependsOnJobs: installIds,
    cnrIds: activateCnrIds,
  });
  return [id];
}

/**
 * The jobs a comfy asset waits on before it can submit: model and node provisioning on a ComfyUI,
 * nothing off one. Empty for every other kind.
 */
async function ensureComfyPrereqJobs(
  assetDef: AssetDefinition,
  target: ComfyTarget | null,
  jobManager: JobManager,
  missingModels: MissingComfyAssets,
  missingNodes: MissingComfyNodeAssets,
): Promise<string[]> {
  if (assetDef.kind !== "comfy") return [];
  if (target !== null && target !== "comfyui") return [];
  return [
    ...(await ensureComfyModelJobs(assetDef, jobManager, missingModels)),
    ...(await ensureComfyNodeJobs(assetDef, jobManager, missingNodes)),
  ];
}
