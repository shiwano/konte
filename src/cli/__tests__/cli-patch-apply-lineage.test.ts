import { describe, expect, it, vi } from "vitest";
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

describe("patch command", () => {
  describe("patch apply", () => {
    it("feeds a stage file's asset into a step as an ordinary upstream", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(
        projectDir,
        sourceId,
        `import { asset, definePatch } from "konte";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";
import reference from "../reference";

export default definePatch<"image">(({ source }) =>
  asset("patched", internalTestImage, {
    image: source,
    reference: reference.latentB,
    width: 32,
    height: 32,
  }),
);
`,
      );
      const { stdout: applied } = await run(["patch", "apply", sourceId], projectDir);
      expect(applied).not.toContain("Failed:");
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const { stdout } = await run(["inspect", `reference:patch.${sourceId}.patched`], projectDir);
      const deps = stdout
        .slice(stdout.indexOf("Dependencies:"))
        .split("\n")
        .slice(1)
        .filter((line) => line.startsWith("  "))
        .map((line) => line.trim().split(" ")[0]);
      expect(deps).toEqual(expect.arrayContaining(["reference:latentA", "reference:latentB"]));
      expect((await patchedVariants(projectDir, sourceId))[0]?.[1].file).toBeTruthy();
    });

    // A fresh scaffold type-checks so it never breaks the video it belongs to, but it describes no
    // correction — applying it must say so rather than record the take as its own patch.
    it("rejects a scaffold that still returns the source unchanged", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await run(["patch", "new", sourceId], projectDir);

      const err = await run(["patch", "apply", sourceId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_INVALID");
    });

    // Inheriting the source's definitionHash is what keeps an address-level edit staling the
    // whole lineage at once; hashing the patch's own definition would leave the output
    // definition-stale from birth.
    it("inherits the source's definitionHash", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const variants = await variantsOf(projectDir, "reference:latentA");
      const [, patched] = (await patchedVariants(projectDir, sourceId))[0]!;
      expect(patched.definitionHash).toBe(variants[sourceId]!.definitionHash);
    });

    // A patch's source is pinned at its own address, so recording that fingerprint would make
    // the variant input-stale against itself.
    it("never records its own address in inputFingerprints", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const [, patched] = (await patchedVariants(projectDir, sourceId))[0]!;
      expect(Object.keys(patched.inputFingerprints)).not.toContain("reference:latentA");
    });

    // Re-running always feeds the same source — that is what lets the prompt be refined without
    // ever compounding one edit onto another.
    it("re-applies to the same source, adding a second attempt", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      await writePatch(
        projectDir,
        sourceId,
        `import { asset, definePatch, adapters } from "konte";

export default definePatch<"image">(({ source }) =>
  asset("patched", adapters.imageResize, { image: source, width: 24, height: 24 }),
);
`,
      );
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      // Applying again is how another attempt at the same correction is asked for, so the returned
      // step rolls again where an intermediate would have been reused.
      const derived = await patchedVariants(projectDir, sourceId);
      expect(derived).toHaveLength(2);
      expect(new Set(derived.map(([, v]) => v.file)).size).toBe(2);
    });
  });
});
