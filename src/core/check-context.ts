import { animaticSetupState, stagingStageState } from "./board-analysis.js";
import type { CheckContext, PatchSubject } from "./checks.js";
import { isDirectionSpendGateSatisfied } from "./direction-acceptance.js";
import type { Direction } from "./dsl/direction.js";
import { buildDependencyGraph, type DependencyGraph } from "./graph.js";
import { songVariantState } from "./song-variant.js";
import { loadDirectionIfPresent, loadStageDefinitions } from "./stage-definitions.js";
import { StateManager } from "./state/index.js";
import type { AnimaticDefinition, ReferenceDefinition, VideoDefinition } from "./types/index.js";

type StageDefs = {
  reference: ReferenceDefinition | null;
  animatic: AnimaticDefinition | null;
  video: VideoDefinition | null;
};

// What the checks read, loaded once. Whatever the caller already holds is handed in; the rest is
// read here, tolerantly — a stage that will not load leaves the findings it feeds unevaluated, and
// the command that needs it fails on it in its own words.
export async function loadCheckContext(opts: {
  videoRoot: string;
  definitions?: StageDefs;
  direction?: Direction | null;
  manager?: StateManager | null;
  graph?: DependencyGraph | null;
  patches?: readonly PatchSubject[];
}): Promise<CheckContext> {
  const { videoRoot } = opts;
  const direction =
    opts.direction !== undefined ? opts.direction : await loadDirectionIfPresent(videoRoot);
  const defs = opts.definitions ?? (await loadStageDefinitions(videoRoot, { tolerant: true }));
  const manager =
    opts.manager !== undefined
      ? opts.manager
      : await StateManager.load(videoRoot).catch(() => null);
  const graph = opts.graph !== undefined ? opts.graph : tryGraph(defs);
  const { reference, animatic, video } = defs;
  return {
    videoRoot,
    direction,
    directionAccepted:
      direction !== null &&
      isDirectionSpendGateSatisfied(direction, manager?.getDirectionAcceptance() ?? null),
    directionUnlocked: direction !== null && manager?.getDirectionAcceptance()?.whole != null,
    reference,
    animatic,
    video,
    manager,
    graph,
    patches: opts.patches ?? [],
    lang: video?.typography.lang ?? direction?.policy.lang ?? null,
    ...(direction && animatic
      ? {
          animaticSetups: animaticSetupState(direction, animatic, reference, manager),
          stagingStage: stagingStageState(direction, animatic, video),
        }
      : {}),
    ...(direction && manager ? { songVariant: songVariantState(manager, direction) } : {}),
  };
}

// Over whichever stages loaded, so a board reviewed before video.tsx exists still has its edges.
function tryGraph(defs: StageDefs): DependencyGraph | null {
  if (!defs.video && !defs.animatic && !defs.reference) return null;
  try {
    return buildDependencyGraph(defs.video, defs.animatic, defs.reference);
  } catch {
    return null;
  }
}
