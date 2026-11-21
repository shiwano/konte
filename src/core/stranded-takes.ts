import { getStage, parseAddress } from "./address.js";
import { listAddresses } from "./definition-addresses.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { type DependencyGraph, listUnusedAddresses } from "./graph.js";
import { isJobTerminal } from "./job-manager.js";
import type { StateManager } from "./state/index.js";
import type {
  AnimaticDefinition,
  GenerationJob,
  JobRecord,
  VideoDefinition,
} from "./types/index.js";

/** An undecided take its shot plays only through dependents whose every job built on it failed. */
export interface StrandedTake {
  address: string;
  variantId: string;
  /** The address holds an accept, which plays in the take's place. */
  accepted: boolean;
  failed: { address: string; variantId: string; error: string | null }[];
}

function consumes(job: GenerationJob, address: string, variantId: string, file: string): boolean {
  const pinned = job.metadata.pinnedDeps;
  if (pinned && typeof pinned === "object" && address in pinned) {
    return (pinned as Record<string, string>)[address] === variantId;
  }
  if (!job.dependsOnAssets.includes(address)) return false;
  if (job.dependsOnJobs.includes(variantId)) return true;
  const attempt = job.metadata.submissionAttempt as
    | { resolvedDependencies?: Record<string, string> }
    | undefined;
  return (
    attempt?.resolvedDependencies?.[address] === file ||
    job.provenance.resolvedDependencies[address] === file
  );
}

export function findStrandedTakes(opts: {
  manager: StateManager;
  jobs: readonly JobRecord[];
  graph: DependencyGraph;
  animatic: AnimaticDefinition | null;
  video: VideoDefinition | null;
}): StrandedTake[] {
  const { manager, graph } = opts;
  const state = manager.getState();
  const view = manager.stalenessView();
  const jobsByAddress = new Map<string, GenerationJob[]>();
  for (const job of opts.jobs) {
    if (job.kind !== "generation") continue;
    const list = jobsByAddress.get(job.address);
    if (list) list.push(job);
    else jobsByAddress.set(job.address, [job]);
  }

  // A dependent job still running, or one whose take is still there to play.
  const reaches = (job: GenerationJob): boolean => {
    if (!isJobTerminal(job.status)) return true;
    if (job.status !== "completed") return false;
    const take = state.assets[job.address]?.variants?.[job.variantId];
    return take?.file != null && take.status !== "dismissed";
  };

  const unused = new Set(listUnusedAddresses(opts.video, opts.animatic, graph));
  const stranded: StrandedTake[] = [];
  for (const [stage, def] of [
    ["animatic", opts.animatic],
    ["video", opts.video],
  ] as const) {
    if (!def) continue;
    const defined = new Set(listAddresses(def, stage));
    const drawn = new Set([
      ...def.shots.flatMap((shot) => shot.compositionRefs ?? []),
      ...(def.timelineSoundtracks ?? []).map((st) => parsePlaceholder(st.src.src) ?? st.src.src),
      ...(def.overlay?.compositionRefs ?? []),
    ]);
    for (const dep of defined) {
      if (drawn.has(dep) || unused.has(dep) || parseAddress(dep).kind !== "shot") continue;
      const dependents = (graph.dependents.get(dep) ?? []).filter(
        (d) => defined.has(d) && !unused.has(d) && getStage(d) === stage,
      );
      if (dependents.length === 0) continue;
      for (const variantId of view.readyUndecided(dep)) {
        const file = state.assets[dep]?.variants?.[variantId]?.file;
        if (!file) continue;
        const built = dependents.flatMap((d) =>
          (jobsByAddress.get(d) ?? []).filter((job) => consumes(job, dep, variantId, file)),
        );
        if (built.some(reaches)) continue;
        const failed = built.filter((job) => job.status === "failed");
        if (failed.length === 0) continue;
        stranded.push({
          address: dep,
          variantId,
          accepted: manager.getAcceptedVariant(dep) !== null,
          failed: failed.map((job) => ({
            address: job.address,
            variantId: job.variantId,
            error: job.error,
          })),
        });
      }
    }
  }
  return stranded;
}
