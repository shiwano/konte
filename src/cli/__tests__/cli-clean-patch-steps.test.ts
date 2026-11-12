import { describe, expect, it, vi } from "vitest";
import { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/manager.js";
import { useTempWorkspace, run } from "./cli-fixtures.js";
import {
  initPatchProject,
  generateSource,
  writePatch,
  variantsOf,
  patchedVariants,
} from "./patch-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

const SOURCE = "reference:latentA";

const twoStepPatch = `import { asset, definePatch, adapters } from "konte";

export default definePatch<"image">(({ source }) => {
  const wide = asset("wide", adapters.imageResize, { image: source, width: 48, height: 48 });
  return asset("patched", adapters.imageResize, { image: wide, width: 32, height: 32 });
});
`;

const threeStepPatch = `import { asset, definePatch, adapters } from "konte";

export default definePatch<"image">(({ source }) => {
  const wide = asset("wide", adapters.imageResize, { image: source, width: 48, height: 48 });
  const mid = asset("mid", adapters.imageResize, { image: wide, width: 40, height: 40 });
  return asset("patched", adapters.imageResize, { image: mid, width: 32, height: 32 });
});
`;

async function apply(projectDir: string, sourceId: string): Promise<void> {
  await run(["patch", "apply", sourceId], projectDir);
  await run(["job", "run"], projectDir).catch(() => undefined);
}

async function patchedIds(projectDir: string, sourceId: string): Promise<string[]> {
  return (await patchedVariants(projectDir, sourceId)).map(([id]) => id);
}

async function stepIds(projectDir: string, sourceId: string, name: string): Promise<string[]> {
  return Object.keys(await variantsOf(projectDir, `reference:patch.${sourceId}.${name}`));
}

describe("clean command: patch steps", () => {
  it("removes the step take of a correction an accept dismissed", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId);
    await apply(projectDir, sourceId);
    await apply(projectDir, sourceId);
    const [first, second] = await patchedIds(projectDir, sourceId);
    const [firstStep, secondStep] = await stepIds(projectDir, sourceId, "patched");
    const sm = await StateManager.load(projectDir);
    sm.setAccepted(SOURCE, second!, { dismiss: [first!] });
    await sm.save();

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(stdout).toMatch(/patch step nothing kept uses \(has media\)\s+1/);
    const remaining = await stepIds(projectDir, sourceId, "patched");
    expect(remaining).toEqual([secondStep]);
    expect(remaining).not.toContain(firstStep);
    expect(Object.keys(await variantsOf(projectDir, SOURCE))).toContain(second);
  });

  it("keeps the step take of a correction still awaiting review", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId);
    await apply(projectDir, sourceId);

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(stdout).toContain("Nothing to clean.");
    expect(stdout).toMatch(/holds the file of a kept take\s+1/);
    expect(await stepIds(projectDir, sourceId, "patched")).toHaveLength(1);
  });

  it("keeps an earlier step the next apply reuses, and removes one it does not", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId, twoStepPatch);
    await apply(projectDir, sourceId);
    const [patched] = await patchedIds(projectDir, sourceId);
    const sm = await StateManager.load(projectDir);
    sm.setAccepted(SOURCE, sourceId, { dismiss: [patched!] });
    await sm.save();

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(stdout).toMatch(/patch step nothing kept uses \(has media\)\s+1/);
    expect(stdout).toMatch(/patch step the next apply reuses\s+1/);
    expect(await stepIds(projectDir, sourceId, "wide")).toHaveLength(1);
    expect(await stepIds(projectDir, sourceId, "patched")).toHaveLength(0);
  });

  it("removes an earlier step the edited script no longer declares as it was", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId, twoStepPatch);
    await apply(projectDir, sourceId);
    const [patched] = await patchedIds(projectDir, sourceId);
    const [wide] = await stepIds(projectDir, sourceId, "wide");
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(`reference:patch.${sourceId}.wide`).variants![wide!]!.definitionHash =
      "an-older-definition";
    sm.setAccepted(SOURCE, sourceId, { dismiss: [patched!] });
    await sm.save();

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(stdout).toMatch(/patch step nothing kept uses \(has media\)\s+2/);
    expect(await stepIds(projectDir, sourceId, "wide")).toHaveLength(0);
  });

  it("removes an earlier step built from an upstream take the next apply would not use", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId, threeStepPatch);
    await apply(projectDir, sourceId);
    const [patched] = await patchedIds(projectDir, sourceId);
    const [mid] = await stepIds(projectDir, sourceId, "mid");
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(`reference:patch.${sourceId}.mid`).variants![mid!]!.inputFingerprints = {
      [`reference:patch.${sourceId}.wide`]: "an-older-wide-take",
    };
    sm.setAccepted(SOURCE, sourceId, { dismiss: [patched!] });
    await sm.save();

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(stdout).toMatch(/patch step nothing kept uses \(has media\)\s+2/);
    expect(stdout).toMatch(/patch step the next apply reuses\s+1/);
    expect(await stepIds(projectDir, sourceId, "mid")).toHaveLength(0);
    expect(await stepIds(projectDir, sourceId, "wide")).toHaveLength(1);
  });

  it("keeps an earlier step while a later step of its chain has an active job", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId, twoStepPatch);
    await apply(projectDir, sourceId);
    const [patched] = await patchedIds(projectDir, sourceId);
    const [wide] = await stepIds(projectDir, sourceId, "wide");
    const outputAddress = `reference:patch.${sourceId}.patched`;
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(`reference:patch.${sourceId}.wide`).variants![wide!]!.definitionHash =
      "an-older-definition";
    sm.setAccepted(SOURCE, sourceId, { dismiss: [patched!] });
    const pending = sm.reserveVariantId(outputAddress);
    await sm.save();
    await new JobManager(projectDir).createJob({
      address: outputAddress,
      variantId: pending,
      resolvedDeps: {},
      backendKind: "local",
    });

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(stdout).toMatch(/has a patch applying\s+\d+/);
    expect(await stepIds(projectDir, sourceId, "wide")).toEqual([wide]);
  });

  it("keeps an earlier step a kept step was made from, however stale", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId, twoStepPatch);
    await apply(projectDir, sourceId);
    const [wide] = await stepIds(projectDir, sourceId, "wide");
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(`reference:patch.${sourceId}.wide`).variants![wide!]!.definitionHash =
      "an-older-definition";
    await sm.save();

    const { stdout } = await run(["clean", "--yes"], projectDir);

    expect(stdout).toContain("Nothing to clean.");
    expect(stdout).toMatch(/input of a kept take\s+1/);
    expect(await stepIds(projectDir, sourceId, "wide")).toEqual([wide]);
  });
});
