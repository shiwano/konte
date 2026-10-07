import { JobManager } from "../core/job-manager.js";
import type { StateManager } from "../core/state/index.js";
import type { AnimaticDefinition, GenerationJob, JobRecord } from "../core/types/index.js";
import { staleRefreshStep } from "./stale-refresh-step.js";

export interface ResolvedTake {
  address: string;
  variantId: string;
  // The scope argument a sweep resolved this take under; its notices print as one line per scope.
  scope?: string;
}

/**
 * What to say on stderr about the take an address resolved to, or undefined when it is current.
 *
 * Both staleness axes, and an ACCEPTED take is warned about too: an accept protects a take from
 * being replaced, not from the definition moving under it.
 *
 * The step named is `staleRefreshStep`'s — the same one `inspect` prints.
 */
function staleNotice(
  manager: StateManager,
  address: string,
  variantId: string,
  animatic: AnimaticDefinition | null | undefined,
): string | undefined {
  const cache = manager.stalenessCache();
  const staleness = manager.variantStaleness(address, variantId, cache);
  if (!staleness || (!staleness.inputStale && !staleness.definitionStale)) return undefined;
  const lead = `${address} resolves to a stale take (${variantId})`;
  const step = staleRefreshStep({
    manager,
    address,
    variantId,
    patchHashes: manager.patchHashes(),
    animatic,
    cache,
  });
  switch (step.kind) {
    case "none":
      return undefined;
    case "patch-apply":
      return `${lead} — \`konte patch apply ${step.sourceVariantId}\` to re-apply its correction`;
    case "prune":
      return `${lead} — \`konte prune\` (its patch script is gone)`;
    case "accept":
      return `${lead} — \`konte accept ${step.variantId}\` is already generated and matches the current definition`;
    case "prerequisite":
      return `${lead} — ${step.variantId} matches the current definition; write ${step.missing.join("/")} in ${step.writeIn} before accepting it`;
    case "generate":
      return `${lead} — \`konte generate ${step.stage}\` to re-bake it (a deterministic take has no alternative to pick)`;
    case "review":
      return `${lead} — \`konte preview ${step.stage}\` to re-accept it (materialized by its accept)`;
    case "stands":
      return `${lead} — accepted against an older upstream; the accept stands`;
    case "restore":
      return `${lead} — accepted against a changed definition; restore it in ${step.file} to what made the take (\`konte inspect ${variantId}\`) to keep the accept`;
    case "reroll":
      return `${lead} — \`konte reroll ${address}\` to rebuild it`;
  }
}

function isActiveGeneration(job: JobRecord): job is GenerationJob {
  return (
    job.kind === "generation" &&
    (job.status === "pending" || job.status === "queued" || job.status === "running")
  );
}

export async function listActiveGenerationJobs(videoRoot: string): Promise<GenerationJob[]> {
  return (await new JobManager(videoRoot).listJobs()).filter(isActiveGeneration);
}

function generatingIds(take: ResolvedTake, activeJobs: readonly GenerationJob[]): string[] {
  return activeJobs.filter((j) => j.address === take.address).map((j) => j.variantId);
}

function inFlightNotice(
  take: ResolvedTake,
  activeJobs: readonly GenerationJob[],
): string | undefined {
  const ids = generatingIds(take, activeJobs);
  if (ids.length === 0) return undefined;
  return `${take.address}: ${ids.join(", ")} still generating — this is the earlier take ${take.variantId}; \`konte job wait\` for the new one`;
}

/** A take named by its variant id is the caller's pick and is never asked about. */
export function resolutionNotices(
  manager: StateManager,
  take: ResolvedTake,
  animatic: AnimaticDefinition | null | undefined,
  activeJobs: readonly GenerationJob[],
): string[] {
  return [
    inFlightNotice(take, activeJobs),
    staleNotice(manager, take.address, take.variantId, animatic),
  ].filter((n) => n !== undefined);
}

export async function printResolutionNotices(opts: {
  videoRoot: string;
  manager: StateManager;
  animatic: AnimaticDefinition | null | undefined;
  takes: readonly ResolvedTake[];
}): Promise<void> {
  if (opts.takes.length === 0) return;
  const activeJobs = await listActiveGenerationJobs(opts.videoRoot);
  const swept = new Map<string, ResolvedTake[]>();
  for (const take of opts.takes) {
    if (take.scope !== undefined) {
      swept.set(take.scope, [...(swept.get(take.scope) ?? []), take]);
      continue;
    }
    for (const notice of resolutionNotices(opts.manager, take, opts.animatic, activeJobs))
      console.error(notice);
  }
  for (const [scope, takes] of swept) {
    for (const notice of sweepNotices(opts.manager, scope, takes, opts.animatic, activeJobs))
      console.error(notice);
  }
}

export function sweepNotices(
  manager: StateManager,
  scope: string,
  takes: readonly ResolvedTake[],
  animatic: AnimaticDefinition | null | undefined,
  activeJobs: readonly GenerationJob[],
): string[] {
  const generating = takes.filter((t) => generatingIds(t, activeJobs).length > 0);
  const stale = takes.filter(
    (t) => staleNotice(manager, t.address, t.variantId, animatic) !== undefined,
  );
  const notices: string[] = [];
  if (generating.length > 0) {
    const ids = generating.flatMap((t) => generatingIds(t, activeJobs));
    notices.push(
      `${scope}: ${ids.join(", ")} still generating — the earlier takes are shown; \`konte job wait\` for the new ones`,
    );
  }
  if (stale.length > 0) {
    notices.push(
      `${scope}: ${stale.length} stale take(s) shown — \`konte inspect ${scope}\` lists them`,
    );
  }
  return notices;
}
