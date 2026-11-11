import { describe, expect, it, vi } from "vitest";
import { useTempWorkspace, run } from "./cli-fixtures.js";
import {
  generateSource,
  initPatchProject,
  patchedVariants,
  variantsOf,
  writePatch,
} from "./patch-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("reroll of a patch step", () => {
  const CHAIN = `import { asset, definePatch, adapters } from "konte";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";

export default definePatch<"image">(({ source }) => {
  const card = asset("card", internalTestImage, { image: source, width: 48, height: 48 });
  return asset("patched", internalTestImage, { image: card, width: 24, height: 24 });
});
`;

  async function appliedChain(): Promise<{ projectDir: string; sourceId: string }> {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId, CHAIN);
    await run(["patch", "apply", sourceId], projectDir);
    await run(["job", "run"], projectDir).catch(() => undefined);
    return { projectDir, sourceId };
  }

  it("rolls the step and the steps after it, landing rival corrections", async () => {
    const { projectDir, sourceId } = await appliedChain();
    const cardAddress = `reference:patch.${sourceId}.card`;

    const { stdout } = await run(["reroll", cardAddress, "--count", "2"], projectDir);
    expect(stdout).toContain("2 correction(s) from 1 patch step(s) — run `konte job run`");
    await run(["job", "run"], projectDir).catch(() => undefined);

    const cards = Object.values(await variantsOf(projectDir, cardAddress)).filter((v) => v.file);
    expect(cards).toHaveLength(3);
    const corrections = await patchedVariants(projectDir, sourceId);
    expect(corrections).toHaveLength(3);
    expect(new Set(corrections.map(([, v]) => v.patchHash)).size).toBe(1);
  });

  it("refuses a step the script does not declare", async () => {
    const { projectDir, sourceId } = await appliedChain();

    await expect(run(["reroll", `reference:patch.${sourceId}.keypad`], projectDir)).rejects.toThrow(
      /declares no step "keypad" — declared: card, patched/,
    );
  });

  it("refuses a step address under a stage other than its source's", async () => {
    const { projectDir, sourceId } = await appliedChain();

    await expect(run(["reroll", `video:patch.${sourceId}.card`], projectDir)).rejects.toThrow(
      new RegExp(`chain is at reference:patch\\.${sourceId}\\.card`),
    );
  });

  it("refuses a patch step named beside another target", async () => {
    const { projectDir, sourceId } = await appliedChain();

    await expect(
      run(["reroll", `reference:patch.${sourceId}.card`, "reference:latentA"], projectDir),
    ).rejects.toThrow(/A patch step is rerolled on its own/);
  });
});
