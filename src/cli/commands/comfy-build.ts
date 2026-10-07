import type { Command } from "commander";
import {
  type BuildResult,
  buildDeployment,
  buildPageUrl,
  deploymentConfig,
  routedDeploymentNames,
} from "../../comfy-api/deployment.js";
import type { PlatformDeployment } from "../../comfy-api/platform-client.js";
import { COMFY_API_KEY_ENV, comfyApiKey, ComfyRouter } from "../../comfy-api/routing.js";
import { loadKonteConfig } from "../../core/config.js";
import { missingCredentialMessage } from "../../core/credentials.js";
import { KonteError } from "../../core/errors.js";
import { requireWorkspaceRoot } from "../context.js";
import { launchBrowser } from "../page-host/launch-browser.js";
import { declareScope } from "../scope.js";

// In the Build page's own labels.
function describeCompute(d: PlatformDeployment): string {
  const c = d.computeConfig;
  if (!c) return d.status;
  return (
    `${c.gpuClass ?? "?"} in ${c.region ?? "?"}, ` +
    `Always-warm workers ${c.min ?? "?"}, Max workers ${c.max ?? "?"}`
  );
}

function printResult(name: string, result: BuildResult): void {
  const url = buildPageUrl(result.buildId);
  if (result.deployment) {
    console.log(
      `comfyapi:${name}: deployment ${result.deployment.id} is ready (${describeCompute(result.deployment)})`,
    );
  } else {
    console.log(`comfyapi:${name}: no ready deployment of release ${result.releaseId}`);
    console.log(`  Build page: ${url}`);
  }
  for (const d of result.outdated) {
    console.log(
      `  Deployment ${d.id} runs an earlier release (${d.status}) and keeps its models billed — ` +
        `delete it on ${url}`,
    );
  }
}

export function registerComfyBuildCommand(comfy: Command): void {
  const cmd = comfy
    .command("build [deployment]")
    .description("Build a Comfy API deployment's adapters and open the page that deploys them")
    .addHelpText(
      "after",
      `
Creates or updates the Comfy API Build of a deployment under comfy.comfyapi.deployments — every
workspace comfy adapter whose comfy.adapters route lands on it — cuts its release and waits until
the release is deployable (several minutes on a change; run it in the background). konte never
creates or deletes a deployment: when the release has no ready deployment, this opens the Build
page, prints its URL, and exits 1. Deploy the release there, then run this again.

With no argument, every deployment some adapter routes to is built.

Examples:
  konte adapter comfy build        Build every routed deployment
  konte adapter comfy build main   Build comfyapi:main
`,
    )
    .action(async (deployment: string | undefined) => {
      const workspaceRoot = requireWorkspaceRoot();
      const config = await loadKonteConfig(workspaceRoot);
      const apiKey = comfyApiKey();
      if (apiKey === null) {
        throw new KonteError("BACKEND_NOT_CONFIGURED", missingCredentialMessage(COMFY_API_KEY_ENV));
      }
      const router = new ComfyRouter(workspaceRoot, config);
      let names: string[];
      if (deployment !== undefined) {
        deploymentConfig(config, deployment);
        names = [deployment];
      } else {
        names = await routedDeploymentNames(workspaceRoot, config, router);
        if (names.length === 0) {
          throw new KonteError(
            "VALIDATION_FAILED",
            "No comfy adapter routes to a Comfy API deployment in comfy.adapters, so there is " +
              "nothing to build",
          );
        }
      }

      const undeployed: Array<{ name: string; result: BuildResult }> = [];
      for (const name of names) {
        const result = await buildDeployment(
          {
            workspaceRoot,
            config,
            apiKey,
            router,
            log: (line) => console.log(`comfyapi:${name}: ${line}`),
          },
          name,
        );
        printResult(name, result);
        if (!result.deployment) undeployed.push({ name, result });
      }
      if (undeployed.length === 0) return;

      for (const { result } of undeployed) {
        launchBrowser(buildPageUrl(result.buildId), { silent: true });
      }
      process.exitCode = 1;
      console.log("\nNext steps:");
      for (const { name, result } of undeployed) {
        console.log(
          `  Deploy release ${result.releaseId} on its Build page, then: konte adapter comfy build ${name}`,
        );
      }
    });

  // Adapters and the deployment state are workspace-wide.
  declareScope(cmd, { scope: "workspace" });
}
