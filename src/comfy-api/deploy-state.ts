import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/atomic-write.js";
import { withFileLock } from "../core/file-lock.js";

const STATE_FILE = path.join(".konte", "comfyapi.json");

const DeploymentStateSchema = z.object({
  buildId: z.string().nullable().default(null),
  // What the definition was built from before any version was resolved; while it holds, the pins
  // below stand.
  inputsHash: z.string().nullable().default(null),
  baseComfyVersion: z.string().nullable().default(null),
  registryVersions: z.record(z.string(), z.string()).default({}),
  definitionHash: z.string().nullable().default(null),
  releaseId: z.string().nullable().default(null),
  releaseDefinitionHash: z.string().nullable().default(null),
  // Releases this Build had before the current one; a deployment of one is outdated.
  pastReleaseIds: z.array(z.string()).default([]),
});
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

const StateSchema = z.object({
  deployments: z.record(z.string(), DeploymentStateSchema).default({}),
});
type State = z.infer<typeof StateSchema>;

function statePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, STATE_FILE);
}

export function emptyDeploymentState(): DeploymentState {
  return DeploymentStateSchema.parse({});
}

async function readState(workspaceRoot: string): Promise<State> {
  try {
    const parsed = StateSchema.safeParse(
      JSON.parse(await fs.readFile(statePath(workspaceRoot), "utf-8")),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or unreadable: start from nothing; the platform keeps the real resources.
  }
  return { deployments: {} };
}

/** Ids only — nothing here is a secret. */
export async function loadDeploymentState(
  workspaceRoot: string,
  name: string,
): Promise<DeploymentState> {
  return (await readState(workspaceRoot)).deployments[name] ?? emptyDeploymentState();
}

/** Read-modify-write one deployment's record under the workspace's state lock. */
export async function updateDeploymentState(
  workspaceRoot: string,
  name: string,
  update: (current: DeploymentState) => Partial<DeploymentState>,
): Promise<DeploymentState> {
  const file = statePath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, async () => {
    const state = await readState(workspaceRoot);
    const current = state.deployments[name] ?? emptyDeploymentState();
    const next = { ...current, ...update(current) };
    state.deployments[name] = next;
    await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    return next;
  });
}

/** The lock one deployment's Build and release are made under, across the workspace. */
export function deploymentLockPath(workspaceRoot: string, name: string): string {
  return path.join(workspaceRoot, ".konte", `comfyapi-${name}.lock`);
}
