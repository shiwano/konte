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
  deploymentId: z.string().nullable().default(null),
  // A create whose answer has not been recorded yet, as it was sent: resent unchanged under the same
  // Idempotency-Key, it returns the deployment it made, if any.
  pendingCreate: z
    .object({
      key: z.string(),
      releaseId: z.string(),
      gpuClass: z.string(),
      region: z.string(),
      max: z.number(),
    })
    .nullable()
    .default(null),
  // Jobs sent under the deployment lock, by when, recorded before their POST; a replacement waits
  // for each until it settles, like for a job whose backend id is recorded.
  sentJobs: z.record(z.string(), z.string()).default({}),
  endpointUrl: z.string().nullable().default(null),
  gpuClass: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  max: z.number().nullable().default(null),
  stopped: z.boolean().default(false),
  // When the deployment last came up — idle time counts from here when no job has finished since.
  readyAt: z.string().nullable().default(null),
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

/** Every deployment konte holds ids for. Ids only — nothing here is a secret. */
export async function loadDeploymentStates(
  workspaceRoot: string,
): Promise<Record<string, DeploymentState>> {
  return (await readState(workspaceRoot)).deployments;
}

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

/** The lock one deployment's bring-up and close take, across every process of the workspace. */
export function deploymentLockPath(workspaceRoot: string, name: string): string {
  return path.join(workspaceRoot, ".konte", `comfyapi-${name}.lock`);
}
