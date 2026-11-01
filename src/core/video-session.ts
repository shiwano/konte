import type { AssetStage } from "./address.js";
import { applyResolutionDefinitions } from "./definition-hashes.js";
import { syncFileAssets } from "./file-sync.js";
import { buildDependencyGraph, type DependencyGraph } from "./graph.js";
import type { LoadedDefinitions } from "./select-definition.js";
import { type LoadOptions, loadStageDefinitions } from "./stage-definitions.js";
import { StateManager } from "./state/index.js";

export type VideoSession = {
  definitions: LoadedDefinitions;
  graph: DependencyGraph;
  manager: StateManager;
};

export type VideoSessionOptions = LoadOptions & {
  // `locked` persists the file-asset sync under the state lock, `memory` applies it to this
  // session's manager alone.
  sync?: "locked" | "memory" | "none";
  // The last stage whose file assets are synced; every stage when absent.
  through?: AssetStage;
  measure?: boolean;
};

// A video's stage entries loaded strictly, its dependency graph, its file assets synced, and its
// definitions registered for resolution — what a command reads before resolving any address.
export async function openVideoSession(
  videoRoot: string,
  opts: VideoSessionOptions = {},
): Promise<VideoSession> {
  const definitions = await loadStageDefinitions(videoRoot, { reload: opts.reload });
  const { reference, animatic, video } = definitions;
  const graph = buildDependencyGraph(video, animatic, reference);

  const targets =
    opts.through === "reference"
      ? { reference }
      : opts.through === "animatic"
        ? { reference, animatic }
        : { reference, animatic, video };
  const sync = (m: StateManager) => syncFileAssets(targets, m, { measure: opts.measure });
  const mode = opts.sync ?? "locked";
  const manager =
    mode === "locked"
      ? await StateManager.withLock(videoRoot, async (m) => {
          await sync(m);
          return m;
        })
      : await StateManager.load(videoRoot);
  if (mode === "memory") await sync(manager);

  await applyResolutionDefinitions({ videoRoot, definitions, state: manager.getState() });
  return { definitions, graph, manager };
}
