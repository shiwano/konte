import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("patch command", () => {
  describe("patch list", () => {
    it("reports a written-but-unapplied patch as pending, and an applied one as applied", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);

      const { stdout: before } = await run(["patch", "list"], projectDir);
      expect(before.trim().split("\n")).toEqual([expect.stringContaining(`pending  ${sourceId}`)]);

      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const { stdout: after } = await run(["patch", "list"], projectDir);
      expect(after).toContain(`applied  ${sourceId}`);
    });

    // "Edited since applied" reads as pending too, but that needs a fresh module load per run —
    // which the in-process harness cannot do — so it is covered in `core/__tests__/patch.test.ts`.

    // A stray file in patches/ is not a patch. Before, `patchFilePath` rejected it and took every
    // catalog consumer (status, preview, inspect, generate) down with it.
    it("ignores a file whose name is not a variant id", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await fs.writeFile(path.join(projectDir, "patches", "notes.draft.ts"), "export default 1;\n");

      const { stdout } = await run(["patch", "list"], projectDir);
      expect(stdout.trim().split("\n")).toEqual([expect.stringContaining(sourceId)]);
      await run(["status"], projectDir);
    });

    it("reports a patch whose source variant is gone as orphaned", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await StateManager.withLock(projectDir, async (m) => {
        m.removeVariant("reference:latentA", sourceId);
      });

      const { stdout } = await run(["patch", "list"], projectDir);
      expect(stdout).toContain(`orphaned ${sourceId}`);
    });

    // A clone: the unaccepted source variant is in state, but git never tracked its media.
    describe("a patch whose source is an absent variant", () => {
      async function cloneLikeProject(): Promise<{ projectDir: string; sourceId: string }> {
        const projectDir = await initPatchProject();
        const sourceId = await generateSource(projectDir);
        await writePatch(projectDir, sourceId);
        await fs.rm(path.join(projectDir, "assets", "reference", "latentA", sourceId), {
          recursive: true,
        });
        return { projectDir, sourceId };
      }

      it("is listed as absent, not orphaned", async () => {
        const { projectDir, sourceId } = await cloneLikeProject();

        const { stdout } = await run(["patch", "list"], projectDir);
        expect(stdout).toMatch(new RegExp(`absent\\s+${sourceId}`));
      });

      it("is kept by prune", async () => {
        const { projectDir, sourceId } = await cloneLikeProject();

        await run(["prune", "--yes"], projectDir);

        await fs.access(path.join(projectDir, "patches", `${sourceId}.ts`));
      });

      it("refuses apply with PATCH_SOURCE_ABSENT", async () => {
        const { projectDir, sourceId } = await cloneLikeProject();

        const err = await run(["patch", "apply", sourceId], projectDir).catch((e) => e);
        expect(err.stderr).toContain("PATCH_SOURCE_ABSENT");
      });
    });
  });

  describe("patch remove", () => {
    it("drops the script and the variants it produced", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);
      const [producedId] = (await patchedVariants(projectDir, sourceId))[0]!;

      const { stdout } = await run(["patch", "remove", sourceId, "-y"], projectDir);
      expect(stdout).toContain(`  removed variant ${producedId}`);

      const variants = await variantsOf(projectDir, "reference:latentA");
      expect(variants[producedId]).toBeUndefined();
      expect(variants[sourceId]).toBeDefined();
      await expect(fs.access(path.join(projectDir, "patches", `${sourceId}.ts`))).rejects.toThrow();
    });

    // "every variant it produced" is the whole chain, not just the patched take: the steps are the
    // spend this patch made, and nothing else declares them once the script is gone.
    it("removes the chain's step variants too", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(
        projectDir,
        sourceId,
        `import { asset, definePatch, adapters } from "konte";

export default definePatch<"image">(({ source }) => {
  const wide = asset("wide", adapters.imageResize, { image: source, width: 48, height: 48 });
  return asset("patched", adapters.imageResize, { image: wide, width: 24, height: 24 });
});
`,
      );
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      await run(["patch", "remove", sourceId, "-y"], projectDir);

      for (const name of ["wide", "patched"]) {
        expect(await variantsOf(projectDir, `reference:patch.${sourceId}.${name}`)).toEqual({});
      }
      await expect(
        fs.access(path.join(projectDir, "assets", "reference", `patch.${sourceId}.wide`)),
      ).rejects.toThrow();
      expect(await patchedVariants(projectDir, sourceId)).toEqual([]);
    });

    // The guard refuses to scaffold or load a script named after a produced take, not to write one
    // by hand. It names a take about to stop existing, so it goes with it rather than being left
    // for `prune`.
    it("also drops a hand-written script named after a variant it produced", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);
      const [producedId] = (await patchedVariants(projectDir, sourceId))[0]!;
      await writePatch(projectDir, producedId);

      await run(["patch", "remove", sourceId, "-y"], projectDir);

      await expect(
        fs.access(path.join(projectDir, "patches", `${producedId}.ts`)),
      ).rejects.toThrow();
    });

    // The argument reaches the path join straight from the CLI and the result is passed to
    // deletion, so it has to be a single safe segment.
    it("refuses a variant id that would escape patches/", async () => {
      const projectDir = await initPatchProject();
      const outside = path.join(projectDir, "reference.tsx");
      const err = await run(["patch", "remove", "../reference", "-y"], projectDir).catch((e) => e);
      expect(err.stderr).toContain("INVALID_ADDRESS");
      await fs.access(outside);
    });

    it("fails with PATCH_NOT_FOUND when there is no script", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      const err = await run(["patch", "remove", sourceId, "-y"], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_NOT_FOUND");
    });
  });
});
