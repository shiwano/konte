import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { shortHash } from "./content-hash.js";
import { workspaceRootOrNull } from "./workspace-context.js";

const cache = new Map<string, { mtimeMs: number; size: number; hash: string | undefined }>();

/**
 * The hash of the graph a comfy adapter's workflow file holds, read from the workspace's
 * `adapters/comfy/`, without each node's `_meta` (its display title). Undefined when no workspace is entered or the file is missing or not JSON.
 */
export function workflowContentHash(workflow: string): string | undefined {
  const root = workspaceRootOrNull();
  if (root === null) return undefined;
  const file = path.join(root, "adapters", "comfy", workflow);
  let stat: import("node:fs").Stats;
  try {
    stat = statSync(file);
  } catch {
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.hash;
  let hash: string | undefined;
  try {
    const graph = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    hash = shortHash(
      Object.fromEntries(
        Object.entries(graph).map(([id, node]) => {
          if (typeof node !== "object" || node === null) return [id, node];
          const { _meta: _, ...rest } = node as Record<string, unknown>;
          return [id, rest];
        }),
      ),
    );
  } catch {
    hash = undefined;
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}
