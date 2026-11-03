import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spendGateHooks } from "../../backends/backend-policy.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import { getAssetEntry } from "../../core/address.js";
import { StateManager } from "../../core/state/manager.js";
import { loadStageDefinitions } from "../../core/stage-definitions.js";
import { ctx, useTempWorkspace, writeWorkspaceConfig, run, initWorkspace } from "./cli-fixtures.js";
import { planEntries, REFERENCE_EXPOSED_UNREFERENCED_TS } from "./generate-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("generate skip decision", () => {
  // A reviewable asset — the accepted-stale hold exists to protect a human's accept, so the
  // fixture has to be something a human accepts. (`latent` below is the deterministic twin.)
  const address = "reference:plate";
  const REFERENCE_REVIEWABLE_TS = `import { defineReference, asset, adapters, defineComfyAsset } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

const plateAdapter = defineComfyAsset({
  workflow: "plate.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineReference(direction, { references: () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latent = asset("latent", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  const plate = asset("plate", plateAdapter, {});
  return { character, bgm, latent, plate };
} });
`;

  // A variant carrying a definition hash that no longer matches reference.tsx — exactly the state
  // left behind by editing an asset's prompt/params after generating it.
  async function withDefinitionStaleVariant(accepted: boolean): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, `skipproj-${accepted}`));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_REVIEWABLE_TS);
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });

    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(address);
    const variant = sm.getAssetState(address).variants![vid]!;
    variant.file = `assets/${address}/${vid}/output.png`;
    variant.definitionHash = "hash-before-the-edit";
    if (accepted) sm.setAccepted(address, vid);
    await sm.save();
    return projectDir;
  }

  it.each([true, false])(
    "checks deployment readiness only for new generation (plan=%s)",
    async (plan) => {
      const projectDir = await withDefinitionStaleVariant(false);
      const { reference } = await loadStageDefinitions(projectDir);
      const sm = await StateManager.load(projectDir);
      const [variantId, variant] = Object.entries(sm.getAssetState(address).variants!)[0]!;
      variant.definitionHash = computeDefinitionHash(getAssetEntry(reference!, address));
      await sm.save();
      const workspaceRoot = path.resolve(projectDir, "../..");
      await fs.mkdir(path.join(workspaceRoot, "adapters/comfy"), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, "adapters/comfy/plate.json"), "{}");
      await writeWorkspaceConfig(projectDir, {
        comfy: {
          adapters: { plate: ["comfyapi:main"] },
          comfyapi: { deployments: { main: { comfyVersion: "v0.39.0" } } },
        },
      });
      vi.stubEnv("COMFY_API_KEY", "test-key");
      const readiness = vi.spyOn(spendGateHooks, "deploymentReadiness").mockResolvedValue({
        kind: "undeployed",
        buildId: "build-1",
        releaseId: "rel-1",
      });
      try {
        const args = ["generate", "reference", ...(plan ? ["--plan"] : [])];
        const { stdout } = await run(args, projectDir);
        expect(readiness).not.toHaveBeenCalled();
        if (plan) {
          expect(planEntries(stdout).find((e) => e.address === address)?.action).toBe("skip");
          expect(planEntries(stdout).find((e) => e.address === "reference:latent")?.action).toBe(
            "start",
          );
        } else {
          expect(stdout).toContain("1 started");
          expect(stdout).toContain("1 already ready");
        }

        const stale = await StateManager.load(projectDir);
        stale.getAssetState(address).variants![variantId]!.definitionHash = "changed";
        await stale.save();
        await expect(run(args, projectDir)).rejects.toMatchObject({
          stderr: expect.stringContaining("COMFY_API_DEPLOYMENT_NOT_READY"),
        });
        expect(readiness).toHaveBeenCalledOnce();
      } finally {
        readiness.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  // Regression (P1): generate compared only input fingerprints, so an edited definition left
  // the asset "ready" and the whole run was a silent no-op — the user had to reach for reroll.
  it("regenerates an unaccepted asset whose definition changed", async () => {
    const projectDir = await withDefinitionStaleVariant(false);
    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const latent = planEntries(stdout).find((e) => e.address === address);
    expect(latent?.action).toBe("start");
  });

  // generate fills holes; a rival to an accepted take is reroll's job. A variant generated under a
  // standing accept would not resolve anyway.
  it("leaves an accepted asset alone when its definition changed, and says the accept stands", async () => {
    const projectDir = await withDefinitionStaleVariant(true);
    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const latent = planEntries(stdout).find((e) => e.address === address);
    expect(latent?.action).toBe("skip");
    expect(latent?.detail).toContain("the accept stands");
  });

  // The plan gets the run's own notice, not one `skip (...)` line inside a listing of every asset
  // in the stage.
  it("names each accepted-but-stale asset on the plan too", async () => {
    const projectDir = await withDefinitionStaleVariant(true);
    const { stderr } = await run(["generate", "reference", "--plan"], projectDir);
    expect(stderr).toContain(address);
    expect(stderr).toContain("konte reroll");
  });

  it("names each accepted-but-stale asset and breaks the skip count down by reason", async () => {
    const projectDir = await withDefinitionStaleVariant(true);
    const { stdout, stderr } = await run(["generate", "reference"], projectDir);
    expect(stderr).toContain(address);
    expect(stderr).toContain("definition-stale");
    expect(stderr).toContain("the accept stands — restore the definition in reference.tsx");
    expect(stderr).toContain(`for a take of the edited definition: konte reroll ${address}`);
    expect(stdout).toContain("1 accepted but stale");
  });

  // A human accept is the human's pick; the reroll that would draw a rival beside it is spend the
  // summary line, which an agent follows, must not order.
  it("leaves the reroll off the summary line", async () => {
    const projectDir = await withDefinitionStaleVariant(true);
    const { stdout } = await run(["generate", "reference"], projectDir);
    const lastLine = stdout.trim().split("\n").at(-1);
    expect(lastLine).toContain("1 accepted but stale");
    expect(lastLine).not.toContain("reroll");
  });

  // The exception: a deterministic take has no other outcome to pick. Re-running the op IS the
  // correction.
  async function withDeterministicAccept(dir: string): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, dir));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_EXPOSED_UNREFERENCED_TS);

    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId("reference:latent");
    const variant = sm.getAssetState("reference:latent").variants![vid]!;
    variant.file = `assets/reference:latent/${vid}/output.png`;
    variant.definitionHash = "hash-before-the-edit";
    sm.setAccepted("reference:latent", vid);
    await sm.save();
    return projectDir;
  }

  const latentAction = async (projectDir: string) => {
    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    return planEntries(stdout).find((e) => e.address === "reference:latent");
  };

  it("re-runs a deterministic asset whose definition changed, without asking for a reroll", async () => {
    const projectDir = await withDeterministicAccept("skipproj-deterministic");
    expect((await latentAction(projectDir))?.action).toBe("start");
  });

  it("does not re-bake a deterministic asset already holding a take of its current definition", async () => {
    const projectDir = await withDeterministicAccept("skipproj-deterministic-rebaked");
    const sm = await StateManager.load(projectDir);
    const fresh = sm.reserveVariantId("reference:latent");
    sm.getAssetState("reference:latent").variants![fresh]!.file =
      `assets/reference:latent/${fresh}/output.png`;
    await sm.save();
    expect((await latentAction(projectDir))?.action).toBe("skip");
  });

  // A patch output sits at the SOURCE address. Generating there would make a fresh original,
  // orphaning the take the correction was built on; the refresh is the patch pass, which this same
  // run does.
  it("does not generate a fresh original under an accepted patch output gone stale", async () => {
    const projectDir = await withDefinitionStaleVariant(false);
    const sm = await StateManager.load(projectDir);
    const source = Object.keys(sm.getAssetState(address).variants ?? {})[0]!;
    const fix = sm.reserveVariantId(address);
    const variant = sm.getAssetState(address).variants![fix]!;
    variant.file = `assets/${address}/${fix}/output.png`;
    variant.definitionHash = "hash-before-the-edit";
    variant.derivedFrom = source;
    sm.setAccepted(address, fix);
    await sm.save();

    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const latent = planEntries(stdout).find((e) => e.address === address);
    expect(latent?.action).toBe("skip");
  });
});
