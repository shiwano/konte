import { describe, expect, it, vi } from "vitest";
import { JobManager } from "../../core/job-manager.js";
import { useTempWorkspace, run } from "./cli-fixtures.js";
import { initPatchProject, generateSource, writePatch, variantsOf } from "./patch-fixtures.js";

// The record as plain JSON, so a test reads nested metadata without narrowing the union.
async function readJob(videoRoot: string, id: string): Promise<any> {
  return JSON.parse(JSON.stringify(await new JobManager(videoRoot).getJob(id)));
}

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

describe("patch command", () => {
  describe("patch apply", () => {
    it("registers the chain's take as a variant at the source's address", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await run(["patch", "new", sourceId], projectDir);
      await writePatch(projectDir, sourceId);

      const { stdout } = await run(["patch", "apply", sourceId], projectDir);
      expect(stdout).not.toContain("Failed:");
      // The job runs at the step's own address; the patched variant appears once it lands.
      expect(stdout).toMatch(
        new RegExp(
          `^ {2}reference:patch\\.${sourceId}\\.patched: .* \\(patch of ${sourceId}\\)$`,
          "m",
        ),
      );
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const step = Object.entries(
        await variantsOf(projectDir, `reference:patch.${sourceId}.patched`),
      ).find(([, v]) => v.file)!;
      const derived = Object.values(await variantsOf(projectDir, "reference:latentA")).filter(
        (v) => v.derivedFrom === sourceId,
      );
      expect(derived).toHaveLength(1);
      expect(derived[0]!.patchHash).toBeTruthy();
      // It points at the step's file rather than holding a copy of its own.
      expect(derived[0]!.file).toBe(step[1].file);
      expect(derived[0]!.outputHash).toBe(step[1].outputHash);
    });

    // Every step is an ordinary generated asset at its own address, the returned one included —
    // which is what keeps a step's take where it was when a later step is appended in front of it.
    it("generates each chain step at its own address", async () => {
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

      for (const name of ["wide", "patched"]) {
        const step = await variantsOf(projectDir, `reference:patch.${sourceId}.${name}`);
        expect(Object.values(step).filter((v) => v.file)).toHaveLength(1);
      }

      const variants = await variantsOf(projectDir, "reference:latentA");
      const derived = Object.values(variants).filter((v) => v.derivedFrom === sourceId);
      expect(derived).toHaveLength(1);
      // The returned step submits from the pending path, behind the earlier step's job. Its
      // definition is declared by the patch script, not by any stage definition, so a worker that
      // looked it up the ordinary way would leave this variant fileless.
      expect(derived[0]!.file).toBeTruthy();
    });

    // An intermediate keeps its take across applies — the reuse that makes appending a step cheap,
    // since the steps before the new one are intermediates by then.
    it("reuses an intermediate step's take on a re-apply", async () => {
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
      const wideTakes = await variantsOf(projectDir, `reference:patch.${sourceId}.wide`);

      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      expect(Object.keys(await variantsOf(projectDir, `reference:patch.${sourceId}.wide`))).toEqual(
        Object.keys(wideTakes),
      );
    });

    // The returned step is the correction's output, so it has no address a sibling could resolve.
    it("rejects a chain that feeds its returned step into another", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(
        projectDir,
        sourceId,
        `import { asset, definePatch, adapters } from "konte";

export default definePatch<"image">(({ source }) => {
  const patched = asset("patched", adapters.imageResize, { image: source, width: 24, height: 24 });
  asset("after", adapters.imageResize, { image: patched, width: 12, height: 12 });
  return patched;
});
`,
      );
      const err = await run(["patch", "apply", sourceId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_INVALID");
    });

    // `source` reaching *a* declaration is not enough: what gets recorded as derived from the take
    // is the returned step's output, so the chain behind that step is what must consume it.
    it("rejects a chain whose returned step does not build on the source", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(
        projectDir,
        sourceId,
        `import { asset, definePatch, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";

export default definePatch<"image">(({ source }) => {
  asset("unused", adapters.imageResize, { image: source, width: 24, height: 24 });
  return asset("patched", internalTestPlate, { width: 32, height: 32, color: "#000000" });
});
`,
      );
      const err = await run(["patch", "apply", sourceId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_INVALID");
    });

    // A step the returned one never consumes is spend with no output.
    it("rejects a step the returned one never consumes", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(
        projectDir,
        sourceId,
        `import { asset, definePatch, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";

export default definePatch<"image">(({ source }) => {
  asset("stray", internalTestPlate, { width: 8, height: 8, color: "#ffffff" });
  return asset("patched", adapters.imageResize, { image: source, width: 24, height: 24 });
});
`,
      );
      const err = await run(["patch", "apply", sourceId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_INVALID");
    });

    // A step generated by this run has no file yet, so the next step submits from the pending path
    // and resolves it by the accepted-then-newest rule. Without pinning the variant this run
    // reserved, an older accepted take at that step's address would win.
    it("pins the step it just reserved into the jobs that consume it", async () => {
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
      const { stdout } = await run(["patch", "apply", sourceId], projectDir);
      const outputVariantId = [...stdout.matchAll(/ → (\S+) \(patch of /g)].at(-1)![1]!;

      const job = await readJob(projectDir, outputVariantId);
      const poolAddress = `reference:patch.${sourceId}.wide`;
      expect(job.metadata.pinnedDeps).toMatchObject({ [poolAddress]: expect.any(String) });
      expect(job.metadata.pinnedDeps[poolAddress]).not.toBe(sourceId);
    });

    // A chain step has no node in the stage dependency graph, so reading its edges from there
    // would report every step as consuming nothing and feeding nothing.
    it("reports a chain step's own edges under inspect", async () => {
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

      const { stdout } = await run(["inspect", `reference:patch.${sourceId}.wide`], projectDir);
      const section = (heading: string) => {
        const lines = stdout
          .slice(stdout.indexOf(`${heading}:`))
          .split("\n")
          .slice(1);
        const end = lines.findIndex((line) => !line.startsWith("  "));
        return lines
          .slice(0, end === -1 ? lines.length : end)
          .map((line) => line.trim().split(" ")[0]);
      };

      expect(section("Dependencies")).toEqual(["reference:latentA"]);
      expect(section("Dependents")).toEqual([`reference:patch.${sourceId}.patched`]);
    });
  });
});
