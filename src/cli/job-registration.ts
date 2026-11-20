import * as fs from "node:fs/promises";
import { getBackendKind } from "../backends/resolve-backend.js";
import { computeDefinitionHash } from "../core/definition-hash.js";
import { writeDefinitionSnapshot } from "../core/definition-snapshot.js";
import type { DeliveryTarget } from "../core/delivery.js";
import { KonteError } from "../core/errors.js";
import { type SkipReason, inFlightVariantIds } from "../core/generation-selection.js";
import { isActiveGeneration } from "../core/job-index.js";
import type { JobManager } from "../core/job-manager.js";
import type { PatchFinalize } from "../core/patch-output.js";
import { StateManager } from "../core/state/index.js";
import type { AssetDefinition, BackendKind, ComfyTarget, JobRecord } from "../core/types/index.js";
import { variantDir } from "../core/variant-dir.js";
import { variantLifecycle } from "../core/variant-lifecycle.js";

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

// The backend a job runs on: a comfy asset routed off a ComfyUI runs on `comfy-api`.
export function jobBackendKind(
  assetDef: AssetDefinition,
  target: ComfyTarget | null,
): BackendKind | null {
  if (assetDef.kind === "comfy" && target !== null && target !== "comfyui") return "comfy-api";
  return getBackendKind(assetDef);
}

/** One address's jobs, registered by `registerJobsBatch`. */
export interface JobRequest {
  address: string;
  assetDef: AssetDefinition;
  variantCount: number;
  // Upstream addresses resolved when the worker submits.
  deps?: readonly string[];
  dependsOnJobs?: readonly string[];
  // Creates the shared jobs this one also depends on, once the address is not skipped.
  prereqJobs?: () => Promise<string[]>;
  // Address → variant-id of an upstream this job must consume specifically (not via the
  // newest-ready/accepted heuristic). Set by `reroll --with-dependents` so a cascaded
  // dependent builds on the freshly rerolled upstream variant even when an older one is
  // still accepted. Resolved to the variant's file at submit time (see trySubmitJob).
  pinnedDeps?: Record<string, string>;
  // Dependencies already resolved to files, for an input no address resolves (a delivery
  // upscale's rendered composite).
  resolvedDeps?: Record<string, string>;
  // Places files the job reads once its variant id exists, returning them as resolved deps.
  placeSources?: (variantId: string) => Promise<Record<string, string>>;
  compositionCacheKeys?: Record<string, string>;
  deliveryTarget?: DeliveryTarget | null;
  patchFinalize?: PatchFinalize | null;
  // The in-flight variants, picked from the job listing read under the state lock, that are
  // attempts at this same definition (a concurrent `patch apply` or `generate` reserving one chain
  // step): one at this definition hash refuses the registration.
  rivals?: (jobs: readonly JobRecord[]) => ReadonlySet<string>;
  // Judged under the state lock against the state as it stands there: a reason skips the address.
  skip?: SkipJudge;
  // Where the spend gate routed a comfy asset (`SpendRoutes.targetOf`).
  comfyTarget?: ComfyTarget | null;
}

export type SkipJudge = (
  manager: StateManager,
  liveJobs: ReadonlySet<string>,
  address: string,
) => SkipReason | null;

export const skipWhileActive: SkipJudge = (manager, liveJobs, address) =>
  inFlightVariantIds(manager.getState(), address, liveJobs).length > 0 ? "active" : null;

interface JobRegistration extends JobRequest {
  videoRoot: string;
  jobManager: JobManager;
}

const INTERRUPTED_REGISTRATION = "Its registration was interrupted before a job was created";

/**
 * Reserve each request's variants and create their jobs in ONE state-lock hold, the state saved
 * before any job exists so the worker never reads a job whose variant is absent. A variant with no
 * file, no terminal marker and no job is therefore always a dead registration here, and is marked
 * failed rather than read as in flight. Results are in request order.
 */
export async function registerJobsBatch(
  videoRoot: string,
  jobManager: JobManager,
  requests: readonly JobRequest[],
): Promise<AssetResult[]> {
  const results: AssetResult[] = requests.map((req) => ({
    address: req.address,
    status: "pending",
    jobs: [],
  }));
  const planned = requests.map((req, slot) => ({
    slot,
    req,
    backendKind: jobBackendKind(req.assetDef, req.comfyTarget ?? null),
    definitionHash: computeDefinitionHash(req.assetDef),
  }));
  if (planned.length === 0) return results;

  await StateManager.withLock(videoRoot, async (manager) => {
    const liveJobs = new Set<string>();
    for (const address of new Set(planned.map((p) => p.req.address))) {
      for (const [id, v] of Object.entries(manager.tryGetAssetState(address)?.variants ?? {})) {
        if (variantLifecycle(v) !== "reserved") continue;
        if (!jobManager.hasJob(id)) {
          manager.markVariantFailed(address, id, INTERRUPTED_REGISTRATION);
        } else if (isActiveGeneration(jobManager.tryGetJob(id))) {
          liveJobs.add(id);
        }
      }
    }

    const jobs = planned.some((p) => p.req.rivals) ? await jobManager.listJobs() : [];
    for (const { req, definitionHash } of planned) {
      if (!req.rivals) continue;
      const rivalIds = req.rivals(jobs);
      const rival = Object.entries(manager.tryGetAssetState(req.address)?.variants ?? {}).find(
        ([id, v]) => rivalIds.has(id) && v.definitionHash === definitionHash && !v.file,
      );
      if (rival) {
        throw new KonteError(
          "PATCH_ALREADY_APPLYING",
          `A job for this step of "${req.address}" is already in flight (${rival[0]})`,
        );
      }
    }

    const admitted: Array<
      (typeof planned)[number] & { backendKind: BackendKind; dependsOnJobs: string[] }
    > = [];
    for (const p of planned) {
      const { req, backendKind } = p;
      const skipReason = req.skip?.(manager, liveJobs, req.address) ?? null;
      if (skipReason) {
        results[p.slot] = { address: req.address, status: "skipped", skipReason, jobs: [] };
        continue;
      }
      if (!backendKind) {
        results[p.slot] = {
          address: req.address,
          status: "failed",
          jobs: [],
          error: `Asset kind "${req.assetDef.kind}" has no generation backend`,
        };
        continue;
      }
      admitted.push({ ...p, backendKind, dependsOnJobs: [] });
    }
    // Every prerequisite exists before the first reservation.
    for (const a of admitted) {
      a.dependsOnJobs = [...(a.req.dependsOnJobs ?? []), ...((await a.req.prereqJobs?.()) ?? [])];
    }

    const reserved: Array<(typeof admitted)[number] & { ids: string[] }> = [];
    for (const a of admitted) {
      const { req } = a;
      const target = manager.ensureAssetState(req.address);
      const ids: string[] = [];
      for (let i = 0; i < req.variantCount; i++) {
        const vid = manager.reserveVariantId(req.address);
        const variant = target.variants![vid]!;
        variant.definitionHash = a.definitionHash;
        if (req.deliveryTarget) variant.deliveryTarget = req.deliveryTarget;
        writeDefinitionSnapshot(videoRoot, req.address, vid, req.assetDef);
        ids.push(vid);
      }
      reserved.push({ ...a, ids });
    }
    await manager.save();

    const jobless = new Map(reserved.flatMap((r) => r.ids.map((id) => [id, r.req.address])));
    try {
      for (const { slot, req, backendKind, definitionHash, dependsOnJobs, ids } of reserved) {
        const pinnedDeps = req.pinnedDeps ?? {};
        for (const vid of ids) {
          const placed = (await req.placeSources?.(vid)) ?? {};
          await jobManager.createJob({
            address: req.address,
            variantId: vid,
            resolvedDeps: { ...req.resolvedDeps, ...placed },
            backendKind,
            comfyTarget: req.assetDef.kind === "comfy" ? (req.comfyTarget ?? null) : null,
            dependsOnAssets: [...(req.deps ?? [])],
            dependsOnJobs,
            compositionCacheKeys: req.compositionCacheKeys,
            metadata: {
              definitionHash,
              ...(Object.keys(pinnedDeps).length > 0 ? { pinnedDeps } : {}),
              ...(req.patchFinalize ? { patchFinalize: req.patchFinalize } : {}),
            },
          });
          jobless.delete(vid);
          results[slot]!.jobs.push({ variantId: vid, status: "pending" });
        }
      }
    } catch (err) {
      for (const [vid, address] of jobless) manager.removeVariant(address, vid);
      await manager.save();
      for (const [vid, address] of jobless) {
        await fs
          .rm(variantDir(videoRoot, address, vid), { recursive: true, force: true })
          .catch(() => {});
      }
      throw err;
    }
  });
  return results;
}

/** Reserve the variants and register their jobs, which the worker submits once they are ready. */
export async function registerJobs(opts: JobRegistration): Promise<AssetResult> {
  const { videoRoot, jobManager, ...req } = opts;
  return (await registerJobsBatch(videoRoot, jobManager, [req]))[0]!;
}
