import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KonteError } from "../core/errors.js";
import { withFileLock } from "../core/file-lock.js";
import { sleep } from "../core/sleep.js";
import type { ComfyApiDeploymentConfig, ComfyTarget, KonteConfig } from "../core/types/index.js";
import {
  adaptersRoutedTo,
  type BuildInputs,
  buildInputs,
  DEFAULT_VERSION_RESOLVERS,
  hashOf,
  resolveBuildDefinition,
  type VersionResolvers,
  workspaceComfyAdapters,
} from "./build-definition.js";
import {
  type DeploymentState,
  deploymentLockPath,
  loadDeploymentState,
  updateDeploymentState,
} from "./deploy-state.js";
import { ComfyApiHttpError } from "./http.js";
import { ComfyPlatformClient, type PlatformDeployment } from "./platform-client.js";
import { ComfyRouter } from "./routing.js";

const BUILD_PAGE = "https://platform.comfy.org/profile/builds/";

export type BuildTiming = {
  releasePollMs: number;
  releaseTimeoutMs: number;
  // Waits out another process's whole release build behind the same lock.
  lockTimeoutMs: number;
};

const DEFAULT_TIMING: BuildTiming = {
  releasePollMs: 10_000,
  releaseTimeoutMs: 60 * 60_000,
  lockTimeoutMs: 90 * 60_000,
};

export type DeploymentContext = {
  workspaceRoot: string;
  config: KonteConfig;
  apiKey: string;
  platform?: ComfyPlatformClient;
  router?: ComfyRouter;
};

export function deploymentConfig(config: KonteConfig, name: string): ComfyApiDeploymentConfig {
  const declared = config.comfy?.comfyapi?.deployments?.[name];
  if (!declared) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `No Comfy API deployment "${name}" under comfy.comfyapi.deployments in konte.config.json`,
    );
  }
  return declared;
}

export function buildPageUrl(buildId: string): string {
  return `${BUILD_PAGE}${encodeURIComponent(buildId)}`;
}

function buildName(workspaceRoot: string, name: string): string {
  return `konte-${path.basename(workspaceRoot)}-${name}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** The declared deployments some workspace comfy adapter routes to, by name. */
export async function routedDeploymentNames(
  workspaceRoot: string,
  config: KonteConfig,
  router: ComfyRouter = new ComfyRouter(workspaceRoot, config),
): Promise<string[]> {
  const names: string[] = [];
  const adapters = await workspaceComfyAdapters(workspaceRoot);
  for (const name of Object.keys(config.comfy?.comfyapi?.deployments ?? {})) {
    if ((await adaptersRoutedTo(adapters, `comfyapi:${name}`, router)).length > 0) {
      names.push(name);
    }
  }
  return names;
}

async function inputsFor(ctx: DeploymentContext, name: string): Promise<BuildInputs> {
  const declared = deploymentConfig(ctx.config, name);
  const router = ctx.router ?? new ComfyRouter(ctx.workspaceRoot, ctx.config);
  const target: ComfyTarget = `comfyapi:${name}`;
  const adapters = await adaptersRoutedTo(
    await workspaceComfyAdapters(ctx.workspaceRoot),
    target,
    router,
  );
  if (adapters.length === 0) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `No comfy adapter routes to ${target} in comfy.adapters, so there is nothing to build`,
    );
  }
  return buildInputs(adapters, declared.comfyVersion);
}

/** Whether the recorded release was cut from what routes to the deployment now. */
function releaseIsCurrent(state: DeploymentState, inputs: BuildInputs): boolean {
  return (
    state.releaseId !== null &&
    state.inputsHash === hashOf(inputs) &&
    state.releaseDefinitionHash === state.definitionHash
  );
}

/** A deployment of `releaseId` that takes jobs: listed, `ready`, with an endpoint. */
export function usableDeployment(
  deployments: readonly PlatformDeployment[],
  releaseId: string,
): PlatformDeployment | null {
  const usable = deployments.filter(
    (d) => d.releaseId === releaseId && d.status === "ready" && d.endpointUrl,
  );
  return usable[0] ?? null;
}

export type DeploymentReadiness =
  | { kind: "ready"; deployment: PlatformDeployment; endpointUrl: string }
  // No release, or one cut from adapters or settings that have moved since.
  | { kind: "unbuilt" }
  | { kind: "undeployed"; buildId: string; releaseId: string };

/** Whether the deployment's current release has a deployment to run jobs on. */
export async function deploymentReadiness(
  ctx: DeploymentContext,
  name: string,
): Promise<DeploymentReadiness> {
  const inputs = await inputsFor(ctx, name);
  const state = await loadDeploymentState(ctx.workspaceRoot, name);
  if (!releaseIsCurrent(state, inputs)) return { kind: "unbuilt" };
  const platform = ctx.platform ?? new ComfyPlatformClient(ctx.apiKey);
  const deployment = usableDeployment(await platform.listDeployments(), state.releaseId!);
  if (!deployment) {
    return { kind: "undeployed", buildId: state.buildId!, releaseId: state.releaseId! };
  }
  return { kind: "ready", deployment, endpointUrl: deployment.endpointUrl! };
}

export type BuildResult = {
  buildId: string;
  releaseId: string;
  deployment: PlatformDeployment | null;
  // Deployments of this Build's earlier releases, left for the human to delete.
  outdated: PlatformDeployment[];
};

/**
 * Bring a deployment's Build and release up to date with what routes to it, and wait for the
 * release to be deployable. Deployments are the human's to create and delete; this only finds one.
 */
export async function buildDeployment(
  ctx: DeploymentContext & {
    log: (line: string) => void;
    resolvers?: VersionResolvers;
    timing?: Partial<BuildTiming>;
  },
  name: string,
): Promise<BuildResult> {
  const timing = { ...DEFAULT_TIMING, ...ctx.timing };
  await fs.mkdir(path.join(ctx.workspaceRoot, ".konte"), { recursive: true });
  return withFileLock(
    deploymentLockPath(ctx.workspaceRoot, name),
    async () => {
      const { workspaceRoot, log } = ctx;
      const platform = ctx.platform ?? new ComfyPlatformClient(ctx.apiKey);
      const inputs = await inputsFor(ctx, name);
      let state = await loadDeploymentState(workspaceRoot, name);
      const resolved = await resolveBuildDefinition(
        inputs,
        state,
        ctx.resolvers ?? DEFAULT_VERSION_RESOLVERS,
      );
      const definitionHash = hashOf(resolved.definition);
      const pins = {
        inputsHash: resolved.inputsHash,
        registryVersions: resolved.registryVersions,
      };

      if (!state.buildId) {
        log(`Creating Build ${buildName(workspaceRoot, name)}`);
        const build = await platform.createBuild(
          buildName(workspaceRoot, name),
          resolved.definition,
        );
        state = await updateDeploymentState(workspaceRoot, name, () => ({
          buildId: build.id,
          definitionHash,
          ...pins,
        }));
      } else if (state.definitionHash !== definitionHash) {
        log(`Updating Build ${state.buildId} (ComfyUI ${inputs.comfyVersion})`);
        const current = await platform.getBuild(state.buildId);
        await platform.updateBuild(state.buildId, resolved.definition, current.updatedAt ?? null);
        state = await updateDeploymentState(workspaceRoot, name, () => ({
          definitionHash,
          ...pins,
        }));
      }

      if (!state.releaseId || state.releaseDefinitionHash !== definitionHash) {
        log(`Cutting a release of Build ${state.buildId}`);
        let releaseId: string;
        try {
          releaseId = await platform.createRelease(state.buildId!);
        } catch (err) {
          throw releaseFailure(err);
        }
        state = await updateDeploymentState(workspaceRoot, name, (current) => ({
          releaseId,
          releaseDefinitionHash: definitionHash,
          pastReleaseIds: [
            ...current.pastReleaseIds.filter((id) => id !== releaseId),
            ...(current.releaseId && current.releaseId !== releaseId ? [current.releaseId] : []),
          ],
        }));
      }
      await waitForRelease(platform, state.releaseId!, timing, log);

      const deployments = await platform.listDeployments();
      return {
        buildId: state.buildId!,
        releaseId: state.releaseId!,
        deployment: usableDeployment(deployments, state.releaseId!),
        outdated: deployments.filter(
          (d) => d.releaseId != null && state.pastReleaseIds.includes(d.releaseId),
        ),
      };
    },
    { timeoutMs: timing.lockTimeoutMs },
  );
}

function releaseFailure(err: unknown): unknown {
  if (err instanceof ComfyApiHttpError && err.status === 400) {
    return new KonteError(
      "COMFY_API_RELEASE_FAILED",
      `The release was refused: ${err.message}. A gated or private model cannot be fetched by the ` +
        `builder; route the adapter that declares it to comfyui or comfycloud.`,
    );
  }
  return err;
}

async function waitForRelease(
  platform: ComfyPlatformClient,
  releaseId: string,
  timing: BuildTiming,
  log: (line: string) => void,
): Promise<void> {
  const deadline = Date.now() + timing.releaseTimeoutMs;
  let lastStatus = "";
  while (true) {
    const release = await platform.getRelease(releaseId);
    if (release.deployable === true) return;
    const failures = (release.artifacts ?? [])
      .map((a) => a.failureReason)
      .filter((r): r is string => typeof r === "string" && r !== "");
    if (failures.length > 0 || (release.status === "complete" && release.deployable === false)) {
      const logText = await platform.getReleaseLog(releaseId);
      const tail = logText ? `\n${logText.split("\n").slice(-30).join("\n")}` : "";
      throw new KonteError(
        "COMFY_API_RELEASE_FAILED",
        `Release ${releaseId} did not build${failures.length > 0 ? ` (${failures.join(", ")})` : ""}${tail}`,
      );
    }
    if (release.status && release.status !== lastStatus) {
      lastStatus = release.status;
      log(`Release ${releaseId}: ${release.status}`);
    }
    if (Date.now() > deadline) {
      throw new KonteError(
        "COMFY_API_RELEASE_FAILED",
        `Release ${releaseId} was not deployable after ${Math.round(timing.releaseTimeoutMs / 60_000)}m`,
      );
    }
    await sleep(timing.releasePollMs);
  }
}
