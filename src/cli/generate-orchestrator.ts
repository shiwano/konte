import * as crypto from "node:crypto";
import { ComfyUIBackend } from "../comfyui/backend.js";
import { resolveComfyUIConfig } from "../comfyui/config.js";
import { resolveUrlTokens } from "../comfyui/token-resolver.js";
import type { GenerationBackend } from "../core/backend.js";
import { computeDefinitionHash } from "../core/definition-hash.js";
import { isTurboTake } from "../core/turbo.js";
import { writeDefinitionSnapshot } from "../core/definition-snapshot.js";
import type { DeliveryTarget } from "../core/delivery.js";
import { KonteError, errorMessage } from "../core/errors.js";
import type { DependencyGraph } from "../core/graph.js";
import { comfyModelJobId, JobManager, RUN_LEASE_TTL_MS } from "../core/job-manager.js";
import type { PatchFinalize } from "../core/patch-output.js";
import { assetResolves } from "../core/pending-jobs.js";
import { startLeaseHeartbeat } from "../backends/lease-heartbeat.js";
import { formatNotice } from "../core/notice.js";
import type { SetupFork } from "../core/stale-refresh.js";
import {
  computeVariantStaleness,
  isVariantStale,
  type UndecidedUpstreamTake,
} from "../core/staleness.js";
import { StateManager } from "../core/state/index.js";
import { submitToBackend } from "../core/submit-generation.js";
import type {
  AssetDefinition,
  BackendKind,
  ComfyModelDeclaration,
  KonteConfig,
} from "../core/types/index.js";
import { variantDir } from "../core/variant-dir.js";
import { getBackendKind, resolveBackend } from "../backends/resolve-backend.js";
import type { VideoRoots } from "../core/roots.js";

/**
 * A presence sweep's verdict: which install targets need provisioning, and whether the server was
 * actually observed saying so.
 *
 * The distinction is load-bearing. An unreachable ComfyUI reports EVERY target missing so an
 * offline run still queues the work (the worker re-checks before spending). That fallback is safe
 * for "create a job", and unsafe for "conclude the file is gone" — which is what resetting a
 * completed provisioning record asserts. Only `confirmed` licenses the second.
 */
type MissingComfyAssets = { ids: Set<string>; confirmed: boolean };

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

export type SkipReason = "active" | "accepted" | "accepted-stale" | "ready";

export type AssetResult = {
  address: string;
  status: "submitted" | "pending" | "skipped" | "synced" | "failed";
  jobs: Array<{ variantId: string; status: string }>;
  error?: string;
  skipReason?: SkipReason;
};

export type LevelResult = {
  level: number;
  assets: AssetResult[];
};

/**
 * Why `generate` leaves this asset alone, or null when it must generate.
 *
 * generate fills holes; replacing a take a human accepted is `reroll`'s job, which drops the
 * accept behind a confirmation. Generating under a standing accept would spend on a variant
 * resolution never picks (the accepted one wins), so an accepted asset is skipped even when
 * stale. One whose upstream alone moved stands as "accepted"; one whose definition moved is
 * "accepted-stale", named with the reroll that replaces it. A deterministic take is the exception: there is nothing else to pick, so re-running the op IS the
 * correction.
 *
 * Everything else turns on readiness, both axes of it: pass the asset's current definition
 * hash so an edited definition ages its variant out here exactly as it does in `status`.
 */
export function assetSkipReason(
  manager: StateManager,
  address: string,
  currentDefinitionHash: string,
  deterministic = false,
): SkipReason | null {
  if (getActiveVariantIds(manager, address).length > 0) return "active";
  const target = manager.tryGetAssetState(address);
  if (!target) return null;
  const state = manager.getState();
  const variants = Object.values(target.variants ?? {});
  // `currentDefinitionHash` answers this address's own axis; the cache answers its inputs', which
  // are judged against what each RESOLVES to. Skipping an asset resolution then finds nothing for is
  // a deadlock: the skip is what would have repaired it.
  const cache = manager.stalenessCache();

  const accepted = variants.find((v) => v.status === "accepted" && v.file);
  if (accepted) {
    const staleness = computeVariantStaleness(
      state,
      address,
      accepted,
      currentDefinitionHash,
      undefined,
      cache,
    );
    if (!staleness.inputStale && !staleness.definitionStale) return "accepted";
    // A patch output sits at the SOURCE address, whose own asset may be deterministic. Its refresh
    // is re-applying the correction (this run's own patch pass), so generating here would spend on a fresh original
    // and orphan the very take the patch names.
    if (accepted.derivedFrom == null && deterministic) return null;
    return staleness.definitionStale ? "accepted-stale" : "accepted";
  }

  // An address left holding only takes the reviewer decided against is generated afresh.
  const hasReady = variants.some(
    (v) =>
      v.file &&
      v.status !== "dismissed" &&
      !isVariantStale(state, address, v, currentDefinitionHash, undefined, cache),
  );
  return hasReady ? "ready" : null;
}

const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  active: "active job(s) exist",
  accepted: "accepted",
  "accepted-stale": "accepted but stale — reroll to replace",
  ready: "already ready",
};

export function getActiveVariantIds(manager: StateManager, address: string): string[] {
  const target = manager.tryGetAssetState(address);
  if (!target) return [];
  const variantIds: string[] = [];
  for (const [variantId, v] of Object.entries(target.variants ?? {})) {
    // A variant with no file is only "active" (an in-flight job) when it has no
    // terminal marker. A failed job records metadata.error and a cancelled one
    // metadata.cancelledAt, both leaving no file; treating either as active would make
    // a re-run skip the asset forever with a false "active job(s) exist". Same terminal
    // set as status-sections/suggested-actions/clean.
    if (!v.file && !v.metadata?.error && !v.metadata?.cancelledAt) {
      variantIds.push(variantId);
    }
  }
  return variantIds;
}

async function getCachedBackend(
  kind: BackendKind,
  roots: VideoRoots,
  cache: Map<BackendKind, GenerationBackend>,
): Promise<GenerationBackend> {
  const cached = cache.get(kind);
  if (cached) return cached;
  const backend = await resolveBackend(kind, roots);
  cache.set(kind, backend);
  return backend;
}

// Reserve `variantCount` variant ids for `address`, persisting them to state under
// the state lock before any job file is created. Reserving-then-persisting first is
// the invariant that keeps a completed job from being stranded: the MCP watcher (or
// a crash) must never see a job whose variant is absent from state, because waitForJob
// only fills a variant that already exists. The lock also prevents this from clobbering
// concurrent watcher writes to other variants.
async function reserveVariants(
  videoRoot: string,
  address: string,
  variantCount: number,
  definitionHash: string,
  assetDef: AssetDefinition,
  deliveryTarget: DeliveryTarget | null = null,
  rivalJobVariantIds?: ReadonlySet<string>,
): Promise<string[]> {
  return StateManager.withLock(videoRoot, async (manager) => {
    const target = manager.ensureAssetState(address);
    if (rivalJobVariantIds) {
      // A rival is an attempt at THIS definition of this address that is genuinely still working —
      // a concurrent `patch apply`/`generate` reserving the same chain step. Re-checked here, under
      // the same lock that creates the reservation, because the caller's join check ran on an
      // unlocked snapshot; without it both runs would pay for one step. The caller decides which
      // in-flight variants qualify (it is the one that knows which chain they belong to) and
      // supplies them from the live job list: a reservation whose job never got created (a crash
      // between the two) carries no terminal marker, so going by markers alone would let one
      // stranded row block the step forever.
      const rival = Object.entries(target.variants ?? {}).find(
        ([id, v]) => rivalJobVariantIds.has(id) && v.definitionHash === definitionHash && !v.file,
      );
      if (rival) {
        throw new KonteError(
          "PATCH_ALREADY_APPLYING",
          `A job for this step of "${address}" is already in flight (${rival[0]})`,
        );
      }
    }
    const ids: string[] = [];
    const turbo = isTurboTake(address, assetDef, target);
    for (let i = 0; i < variantCount; i++) {
      const vid = manager.reserveVariantId(address);
      const variant = target.variants![vid]!;
      variant.definitionHash = definitionHash;
      if (deliveryTarget) variant.deliveryTarget = deliveryTarget;
      if (turbo) variant.turbo = true;
      writeDefinitionSnapshot(videoRoot, address, vid, assetDef);
      ids.push(vid);
    }
    return ids;
  });
}

export interface VariantReservationRequest {
  address: string;
  variantCount: number;
  definitionHash: string;
  assetDef: AssetDefinition;
  deliveryTarget?: DeliveryTarget | null;
}

/**
 * Reserve every requested address's variants under ONE state-lock cycle — the per-asset
 * `reserveVariants` pays a full state load + rewrite each, which is quadratic in bytes across a
 * level of many assets. Same invariant as `reserveVariants` (persist before any job file exists);
 * no rival check, which only the patch path needs. Returns address → reserved variant ids.
 */
export async function reserveVariantsBatch(
  videoRoot: string,
  requests: readonly VariantReservationRequest[],
): Promise<Map<string, string[]>> {
  if (requests.length === 0) return new Map();
  return StateManager.withLock(videoRoot, async (manager) => {
    const result = new Map<string, string[]>();
    for (const req of requests) {
      const target = manager.ensureAssetState(req.address);
      const ids: string[] = [];
      const turbo = isTurboTake(req.address, req.assetDef, target);
      for (let i = 0; i < req.variantCount; i++) {
        const vid = manager.reserveVariantId(req.address);
        const variant = target.variants![vid]!;
        variant.definitionHash = req.definitionHash;
        if (req.deliveryTarget) variant.deliveryTarget = req.deliveryTarget;
        if (turbo) variant.turbo = true;
        writeDefinitionSnapshot(videoRoot, req.address, vid, req.assetDef);
        ids.push(vid);
      }
      result.set(req.address, ids);
    }
    return result;
  });
}

// Which of the given comfy models are not yet present in ComfyUI, as a set of `comfyModelJobId`
// keys — one declaration's install target, not its filename, since a directory-shaped model
// carries the same filename (`config.json`) at several savePaths. A best effort: an empty result
// (so no download jobs are created) only when auto-install is on AND ComfyUI confirms every model
// is already there. When auto-install is off, or ComfyUI is unreachable, all are reported missing
// so callers create download jobs (preserving the offline-resilient behaviour).
//
// `confirmed` carries whether that answer was observed or assumed, because the two license
// different actions downstream — see MissingComfyAssets.
export async function resolveMissingComfyModels(
  roots: VideoRoots,
  models: readonly ComfyModelDeclaration[],
  autoInstallModels: boolean,
): Promise<MissingComfyAssets> {
  if (!autoInstallModels || models.length === 0) return { ids: new Set(), confirmed: true };
  const config = await resolveComfyUIConfig(roots.workspace);
  const backend = new ComfyUIBackend(config, roots);
  const { missing, confirmed } = await backend.managerClient.filterMissingModels(models);
  return { ids: new Set(missing.map(comfyModelJobId)), confirmed };
}

// Which declared comfy node-pack cnr_ids are not yet installed in ComfyUI. Same best-effort
// contract as resolveMissingComfyModels: empty only when auto-install is on AND ComfyUI
// confirms every pack is present; otherwise all are reported missing.
export async function resolveMissingComfyNodes(
  roots: VideoRoots,
  cnrIds: readonly string[],
  autoInstallNodes: boolean,
): Promise<MissingComfyNodeAssets> {
  if (!autoInstallNodes || cnrIds.length === 0) {
    return { ids: new Set(), confirmed: true, unloaded: new Set() };
  }
  const config = await resolveComfyUIConfig(roots.workspace);
  const backend = new ComfyUIBackend(config, roots);
  const { missing, confirmed } = await backend.managerClient.filterMissingNodes(cnrIds);
  const ids = new Set(missing);
  // Only the ones already on disk can be merely unloaded; the rest are covered by their install.
  // An unobservable answer yields nothing — a reboot is too destructive to schedule on a guess,
  // and `activateNodes` re-checks before it reboots anyway.
  const installed = cnrIds.filter((id) => !ids.has(id));
  const loaded = await backend.managerClient.filterUnloadedNodes(installed);
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

// Which declared comfy models/nodes the given comfy assets need that ComfyUI does not have (one
// ComfyUI/Manager query for the whole list; a present one gets no job, an unreachable ComfyUI
// reports all missing), plus the notice naming each missing one's consumers.
export async function preflightComfyAssets(
  roots: VideoRoots,
  entries: ReadonlyArray<{ address: string; def: AssetDefinition }>,
  config: KonteConfig,
): Promise<{
  missingModels: MissingComfyAssets;
  missingNodes: MissingComfyNodeAssets;
  comfyDownloads: ComfyDownloadNotice;
}> {
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
    config.comfyui?.autoInstallModels ?? true,
  );
  const missingNodes = await resolveMissingComfyNodes(
    roots,
    [...declaredNodeIds],
    config.comfyui?.autoInstallNodes ?? true,
  );
  return {
    missingModels,
    missingNodes,
    comfyDownloads: collectComfyDownloads(entries, missingModels.ids, missingNodes.ids),
  };
}

// A concise English notice listing the comfy downloads/installs a run will trigger,
// or null when nothing is pending. Model-primary (one line per download); shared
// models show the first address plus a "(+N more)" suffix.
export function formatComfyDownloadNotice(notice: ComfyDownloadNotice): string | null {
  if (notice.models.length === 0 && notice.nodes.length === 0) return null;

  const formatAddresses = (addresses: string[]): string => {
    const [first, ...rest] = addresses;
    const suffix = rest.length > 0 ? ` (+${rest.length} more)` : "";
    return `${first}${suffix}`;
  };

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

// A pre-flight warning that one or more upstreams carry an undecided take (e.g. from a reroll)
// that this run will NOT use — dependency resolution binds the accepted variant, so the downstream
// builds on the accepted frame until that take is accepted in its place. The take is not
// necessarily newer than the accept, so the wording claims no order. Null when clean.
export function formatUndecidedUpstreamTakesNotice(
  takes: readonly UndecidedUpstreamTake[],
): string | null {
  if (takes.length === 0) return null;
  const lines = takes.map(
    (t) =>
      `${t.address}: ${t.undecidedVariantId} undecided — using accepted ${t.acceptedVariantId}`,
  );
  lines.push("Review and accept the undecided take first if this run should build on it instead.");
  return formatNotice(
    "upstream has an undecided take this run will NOT use (it resolves the accepted variant):",
    lines,
  );
}

export type AcceptedStaleAsset = {
  address: string;
  cause: string;
  /** What replaces this take. */
  command: string;
  /** Set only for a plate two or more shots stand on. */
  fork?: SetupFork;
};

// The assets this run skipped because their accepted take is stale — the one skip a user is
// liable to read as a silent no-op ("I edited the prompt and nothing happened"), so it names
// each address with its stale cause and the command that settles it. A plate carries a second
// door: the edit is charged to every shot on that setup. Null when clean.
export function formatAcceptedStaleNotice(assets: readonly AcceptedStaleAsset[]): string | null {
  if (assets.length === 0) return null;
  const lines: string[] = [];
  for (const a of assets) {
    const shared = a.fork ? ` — shared frame for shots ${a.fork.shotIds.join(", ")}` : "";
    lines.push(a.cause ? `${a.address}: ${a.cause}${shared}` : `${a.address}${shared}`);
    if (a.fork) {
      lines.push(
        "  for one shot: fork the setup — add one to `setups` in direction.ts, point that shot's `setup` at it, declare its plate in `plates` in animatic.tsx",
      );
      lines.push(`  for all ${a.fork.shotIds.length}: ${a.command}`);
    } else {
      lines.push(`  ${a.command}`);
    }
  }
  return formatNotice(
    "accepted but stale — generate never replaces an accepted take, so these were skipped:",
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
export async function ensureComfyNodeJobs(
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

export async function createPendingJobs(
  address: string,
  assetDef: AssetDefinition,
  deps: readonly string[],
  variantCount: number,
  videoRoot: string,
  jobManager: JobManager,
  dependsOnJobs: readonly string[] = [],
  // Asset-path → variant-id of an upstream this job must consume specifically (not via the
  // newest-ready/accepted heuristic). Set by `reroll --with-dependents` so a cascaded
  // dependent builds on the freshly rerolled upstream variant even when an older one is
  // still accepted. Resolved to the variant's file at submit time (see trySubmitJob).
  pinnedDeps: Record<string, string> = {},
  patchFinalize: PatchFinalize | null = null,
  rivalVariantIds: ReadonlySet<string> | null = null,
  // Variants already reserved by a reserveVariantsBatch pass — skips the per-asset lock cycle.
  reservedVariantIds: readonly string[] | null = null,
): Promise<AssetResult> {
  const backendKind = getBackendKind(assetDef);
  if (!backendKind) {
    return {
      address,
      status: "failed",
      jobs: [],
      error: `Asset kind "${assetDef.kind}" has no generation backend`,
    };
  }

  const definitionHash = computeDefinitionHash(assetDef);
  const variantIds =
    reservedVariantIds ??
    (await reserveVariants(
      videoRoot,
      address,
      variantCount,
      definitionHash,
      assetDef,
      null,
      rivalVariantIds ?? undefined,
    ));
  const jobs: Array<{ variantId: string; status: string }> = [];
  const hasPins = Object.keys(pinnedDeps).length > 0;

  for (const vid of variantIds) {
    try {
      await jobManager.createJob({
        address,
        variantId: vid,
        resolvedDeps: {},
        backendKind,
        dependsOnAssets: [...deps],
        dependsOnJobs: [...dependsOnJobs],
        metadata: {
          definitionHash,
          ...(hasPins ? { pinnedDeps } : {}),
          ...(patchFinalize ? { patchFinalize } : {}),
        },
      });
    } catch (err) {
      await StateManager.withLock(videoRoot, async (manager) => {
        manager.removeVariant(address, vid);
      });
      throw err;
    }
    jobs.push({ variantId: vid, status: "pending" });
  }

  return { address, status: "pending", jobs };
}

export async function submitAssetJobs(
  address: string,
  assetDef: AssetDefinition,
  variantCount: number,
  roots: VideoRoots,
  jobManager: JobManager,
  backendCache: Map<BackendKind, GenerationBackend>,
  resolvedDeps?: Record<string, string>,
  compositionCacheKeys?: Record<string, string>,
  deliveryTarget?: DeliveryTarget | null,
  patchFinalize?: PatchFinalize | null,
  rivalVariantIds: ReadonlySet<string> | null = null,
  // Variants already reserved by a reserveVariantsBatch pass — skips the per-asset lock cycle.
  reservedVariantIds: readonly string[] | null = null,
): Promise<AssetResult> {
  const videoRoot = roots.video;
  const backendKind = getBackendKind(assetDef);
  if (!backendKind) {
    return {
      address,
      status: "failed",
      jobs: [],
      error: `Asset kind "${assetDef.kind}" has no generation backend`,
    };
  }

  const deps = resolvedDeps ?? {};

  const definitionHash = computeDefinitionHash(assetDef);
  const variantIds =
    reservedVariantIds ??
    (await reserveVariants(
      videoRoot,
      address,
      variantCount,
      definitionHash,
      assetDef,
      deliveryTarget ?? null,
      rivalVariantIds ?? undefined,
    ));

  const backend = await getCachedBackend(backendKind, roots, backendCache);

  const jobs: Array<{ variantId: string; status: string }> = [];
  let hasFailure = false;

  for (const vid of variantIds) {
    try {
      await jobManager.createJob({
        address,
        variantId: vid,
        resolvedDeps: deps,
        backendKind,
        compositionCacheKeys,
        // A patch step's address has no stage entry, so the waiter cannot look its definition up
        // the usual way — it would find nothing and finalize by neither determinism nor output
        // node. Carry the finalization facts on the job itself.
        ...(patchFinalize ? { metadata: { patchFinalize } } : {}),
      });
    } catch (err) {
      await StateManager.withLock(videoRoot, async (manager) => {
        manager.removeVariant(address, vid);
      });
      throw err;
    }

    // Hold a submit lease across the slow backend.submit() so a crash mid-submit strands a
    // reclaimable "running" job instead of a lease-less orphan — the same discipline the
    // pending-worker path uses (see claimForSubmission / startLeaseHeartbeat). A concurrent
    // watcher cascade may claim this fresh job first; if so our claim returns null and we
    // hand it off rather than double-submit.
    const workerId = `w-${crypto.randomBytes(8).toString("hex")}`;
    const claimed = await jobManager.claimForSubmission(vid, workerId, RUN_LEASE_TTL_MS);
    if (!claimed || claimed.kind !== "generation") {
      jobs.push({ variantId: vid, status: "running" });
      continue;
    }

    const stopHeartbeat = startLeaseHeartbeat(jobManager, vid, workerId);
    try {
      const outputDir = variantDir(videoRoot, address, vid);
      const request = {
        address,
        assetDefinition: assetDef,
        variantId: vid,
        outputDir,
        resolvedDependencies: deps,
      };

      const { backendJobId, metadata } = await submitToBackend(
        jobManager,
        backend,
        claimed,
        request,
      );

      // Commit the backendJobId and release the lease only if we still own it: a submit that
      // outran the lease was reclaimed by another worker, so we must not clobber its state.
      const committed = await jobManager.finishIfOwner(vid, workerId, {
        status: "running",
        backendJobId,
        lease: null,
        // This REPLACES the job's metadata. `submitToBackend` is what carries `patchFinalize`
        // across, so both submit paths keep it without either one remembering to.
        metadata,
      });
      if (!committed) {
        jobManager.appendLog(
          vid,
          `Submit lease lost before committing backendJobId ${backendJobId}; reclaimed by another worker`,
        );
      }

      jobs.push({ variantId: vid, status: "running" });
    } catch (err) {
      const errorMsg = errorMessage(err);
      const recorded = await jobManager.finishIfOwner(vid, workerId, {
        status: "failed",
        error: errorMsg,
        lease: null,
        completedAt: new Date().toISOString(),
      });

      if (recorded) {
        await StateManager.withLock(videoRoot, async (manager) => {
          const variant = manager.tryGetAssetState(address)?.variants?.[vid];
          if (variant) {
            variant.metadata = { error: errorMsg };
          }
        });
        jobs.push({ variantId: vid, status: "failed" });
        hasFailure = true;
      } else {
        jobs.push({ variantId: vid, status: "running" });
      }
    } finally {
      stopHeartbeat();
    }
  }

  return {
    address,
    status: hasFailure ? "failed" : "submitted",
    jobs,
  };
}

type PlanAction = "start" | "wait" | "skip" | "synced";

export type PlanEntry = {
  address: string;
  action: PlanAction;
  reason?: string;
  /** The skip's code — `reason` is its prose form. */
  skipReason?: SkipReason;
  backendKind: BackendKind | null;
  variantCount: number;
  deps: string[];
};

export type GeneratePlan = {
  levels: Array<{ level: number; entries: PlanEntry[] }>;
  summary: { start: number; wait: number; skip: number; synced: number };
};

// Dry-run counterpart to the generate loop: replicate the same per-asset
// decisions (file / skip / deps) with no side effects, so `--plan`
// can show what a real run would submit. Submit-time failure cascades are
// intentionally omitted — nothing actually fails during a dry run.
export function buildGeneratePlan(params: {
  levels: readonly (readonly string[])[];
  graph: DependencyGraph;
  manager: StateManager;
  stageAssetPaths: ReadonlySet<string>;
  variantCount: number;
  getAssetDef: (assetPath: string) => AssetDefinition;
  missingModels?: ReadonlySet<string>;
  missingNodes?: ReadonlySet<string>;
}): GeneratePlan {
  const {
    levels,
    graph,
    manager,
    stageAssetPaths,
    variantCount,
    getAssetDef,
    missingModels = new Set<string>(),
    missingNodes = new Set<string>(),
  } = params;

  const planLevels: GeneratePlan["levels"] = [];
  const summary = { start: 0, wait: 0, skip: 0, synced: 0 };
  const state = manager.getState();
  // Whether a dep will still lack a usable file when this level's job registers — the question
  // describePendingJob answers for the real run to decide queued vs waiting. Its three
  // predicates, in the plan's terms: an upstream this plan builds; one an earlier run has in
  // flight (which blocks even when an older take left a file behind, so the dependent consumes
  // the fresh one); one with no file at all. File assets need no case of their own — the caller
  // syncs them into `state` before planning, so an absent one has no variant to find.
  const notYetBuilt = new Set<string>();
  // One memo for the whole plan — it writes nothing to state.
  const planCache = manager.stalenessCache();
  const depBlocks = (dep: string) =>
    notYetBuilt.has(dep) ||
    getActiveVariantIds(manager, dep).length > 0 ||
    !assetResolves(state, dep, planCache);

  // Number the levels shown to the user sequentially — the cross-stage graph
  // leaves per-stage gaps that would otherwise skip displayed level numbers.
  const stageLevels = levels
    .map((paths) => paths.filter((a) => stageAssetPaths.has(a)))
    .filter((paths) => paths.length > 0);

  for (let levelIdx = 0; levelIdx < stageLevels.length; levelIdx++) {
    const assetPaths = stageLevels[levelIdx]!;

    const entries: PlanEntry[] = [];
    for (const assetPath of assetPaths) {
      const assetDef = getAssetDef(assetPath);
      // Address and asset path are the same string form.
      const address = assetPath;
      const deps = [...(graph.dependencies.get(assetPath) ?? [])];
      const backendKind = getBackendKind(assetDef) ?? null;

      let action: PlanAction;
      let reason: string | undefined;
      let skipReason: SkipReason | undefined;
      if (assetDef.kind === "file") {
        // Mirror the real loop: file assets are synced in both stages.
        action = "synced";
      } else {
        // Readiness first, the gate second: an asset already accepted, ready, or in flight is one
        // generate would leave alone anyway, so its own reason is the honest one. The gate only ever
        // explains an asset that WOULD have been generated — which is what makes the notice's shot
        // count mean "held back", not "not due yet".
        const skip = assetSkipReason(
          manager,
          address,
          computeDefinitionHash(assetDef),
          assetDef.deterministic === true,
        );
        if (skip) {
          action = "skip";
          skipReason = skip;
          reason =
            skip === "active"
              ? `${getActiveVariantIds(manager, address).length} active job(s) exist`
              : SKIP_REASON_TEXT[skip];
        } else if (
          deps.some(depBlocks) ||
          (assetDef.kind === "comfy" &&
            ((assetDef.models?.some((m) => missingModels.has(comfyModelJobId(m))) ?? false) ||
              (assetDef.nodes?.some((n) => missingNodes.has(n.id)) ?? false)))
        ) {
          // An upstream still to build, or comfy models/nodes still to install → the job is
          // registered blocked and submits once those land.
          action = "wait";
        } else {
          // Either no deps (submitted outright) or deps already generated, which the watcher
          // submits the moment the job file appears. Both are under way — see generate.ts.
          action = "start";
        }
        if (action === "start" || action === "wait") notYetBuilt.add(address);
      }

      summary[action]++;
      entries.push({ address, action, reason, skipReason, backendKind, variantCount, deps });
    }
    planLevels.push({ level: levelIdx, entries });
  }

  return { levels: planLevels, summary };
}

function formatPlanEntry(e: PlanEntry): string {
  if (e.action === "synced") return "synced (file)";
  if (e.action === "skip") return `skip (${e.reason})`;

  const detail: string[] = [];
  if (e.backendKind) detail.push(e.backendKind);
  let line = detail.length > 0 ? `${e.action} (${detail.join(", ")})` : e.action;
  if (e.deps.length > 0) line += ` [deps: ${e.deps.join(", ")}]`;
  return line;
}

// Human-readable plan.
export function formatGeneratePlan(plan: GeneratePlan): string {
  const lines: string[] = [];
  if (plan.levels.length === 0) {
    lines.push("Nothing to generate.");
    return lines.join("\n");
  }

  for (const lvl of plan.levels) {
    lines.push(`\nLevel ${lvl.level + 1}: ${lvl.entries.length} asset(s)`);
    for (const e of lvl.entries) {
      lines.push(`  ${e.address}: ${formatPlanEntry(e)}`);
    }
  }

  const { start, wait, skip, synced } = plan.summary;
  lines.push(`\nPlan: ${start} to start, ${wait} waiting, ${skip} skipped, ${synced} synced`);
  lines.push("\nRun without --plan to start these jobs.");
  return lines.join("\n");
}
