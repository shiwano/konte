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

// The record as plain JSON, so a test reads nested metadata without narrowing the union.
async function readJob(videoRoot: string, id: string): Promise<any> {
  return JSON.parse(JSON.stringify(await new JobManager(videoRoot).getJob(id)));
}

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

describe("patch command", () => {
  describe("patch apply", () => {
    it("names the patch script as the stale axis, and offers the re-apply over a reroll", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      // Stands in for editing the script: the CLI runs in-process here and the module-cache bust
      // behind a patch reload is a Bun internal, so an edited script would never be re-read.
      const sm = await StateManager.load(projectDir);
      const [patchedId] = (await patchedVariants(projectDir, sourceId))[0]!;
      sm.getAssetState("reference:latentA").variants![patchedId]!.patchHash = "0000stale000";
      await sm.save();

      const { stdout } = await run(["inspect", "reference:latentA"], projectDir);
      expect(stdout).toContain("patch-stale");
      expect(stdout).toContain(`patches/${sourceId}.ts changed since this take was produced`);
      expect(stdout).toContain(`konte patch apply ${sourceId}`);
      expect(stdout).not.toContain("konte reroll");
      expect(stdout).not.toContain("definition-stale");
    });

    // The waiter cannot look a patch's definition up by address — that is the SOURCE asset — so
    // the comfy output node and the finalize origin are snapshotted onto the job. The submit commit
    // REPLACES job metadata, so this asserts the snapshot survives it.
    it("keeps the patch's finalization snapshot on the job after submission", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      const { stdout } = await run(["patch", "apply", sourceId], projectDir);
      const producedId = stdout.match(/ → (\S+) \(patch of /)![1]!;

      const job = await readJob(projectDir, producedId);
      // `output` is what makes this step the one the patched variant comes from.
      expect(job.metadata.patchFinalize).toMatchObject({
        output: { sourceAddress: "reference:latentA", sourceVariantId: sourceId },
      });
    });

    // Otherwise a patch could run an unrelated generation and still be recorded as derived from
    // that take, giving the lineage (and the review UI's "before") a relationship that never was.
    it("rejects a patch that never passes `source` to its adapter", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(
        projectDir,
        sourceId,
        `import { asset, definePatch, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";

export default definePatch<"image">(() =>
  asset("patched", internalTestPlate, { width: 32, height: 32, color: "#000000" }),
);
`,
      );
      const err = await run(["patch", "apply", sourceId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_INVALID");
    });

    // The pre-flight source check and the child's reservation are separate operations, so the
    // reservation re-validates under the state lock — otherwise a concurrent clean between the
    // two would leave a child whose `derivedFrom` names nothing.
    it("refuses to reserve a child when the source has been removed", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await StateManager.withLock(projectDir, async (m) => {
        m.removeVariant("reference:latentA", sourceId);
      });

      const err = await run(["patch", "apply", sourceId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_SOURCE_MISSING");
      const variants = await variantsOf(projectDir, "reference:latentA");
      expect(Object.values(variants).some((v) => v.derivedFrom === sourceId)).toBe(false);
    });

    it("fails with PATCH_NOT_FOUND for a variant with no script", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      const err = await run(["patch", "apply", sourceId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_NOT_FOUND");
    });

    // `patch new` refuses to scaffold one, so loading is what makes the rule hold for a file
    // written by hand — and it reports the same code, not a generic "this script did not load".
    it("refuses a hand-written patch on a take a patch produced", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);
      const [producedId] = (await patchedVariants(projectDir, sourceId))[0]!;
      await writePatch(projectDir, producedId);

      const err = await run(["patch", "apply", producedId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_TARGET_INVALID");
    });

    // A step's take was built from the file its upstream's job is replacing, and until that job
    // lands the address still resolves to it — so "unchanged definition" is not enough to reuse.
    it("re-runs an intermediate whose own upstream is being rebuilt", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(
        projectDir,
        sourceId,
        `import { asset, definePatch, adapters } from "konte";

export default definePatch<"image">(({ source }) => {
  const wide = asset("wide", adapters.imageResize, { image: source, width: 48, height: 48 });
  const patched = asset("patched", adapters.imageResize, { image: wide, width: 32, height: 32 });
  return asset("final", adapters.imageResize, { image: patched, width: 16, height: 16 });
});
`,
      );
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);
      const wideAddress = `reference:patch.${sourceId}.wide`;

      // Drop the first step's take, so re-applying rebuilds it. `patched` is unchanged and would
      // otherwise be reused — against the file `wide` is about to replace.
      await StateManager.withLock(projectDir, async (m) => {
        for (const id of Object.keys(m.getAssetState(wideAddress).variants ?? {})) {
          m.removeVariant(wideAddress, id);
        }
      });

      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const patched = await variantsOf(projectDir, `reference:patch.${sourceId}.patched`);
      expect(Object.values(patched).filter((v) => v.file)).toHaveLength(2);
    });

    // The chain's work lives at the step addresses, so a run that finds the returned step already
    // in flight has nothing to do — the job it joins carries the finalize. Reading the chain as
    // "not applied" and then falling out of the step loop is what this pins down.
    it("joins the returned step's job instead of failing when one is in flight", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      const first = await run(["patch", "apply", sourceId], projectDir);
      const producedId = (out: string) => out.match(/ → (\S+) \(patch of /)?.[1];

      // Before `job wait`, so the returned step's job is still in flight.
      const { stdout } = await run(["patch", "apply", sourceId], projectDir);
      expect(stdout).not.toContain("Failed:");
      expect(producedId(stdout)).toBe(producedId(first.stdout));

      // …and the sweep leaves it alone rather than starting a rival chain.
      const swept = await run(["patch", "apply"], projectDir);
      expect(swept.stdout).not.toContain("(patch of");
      expect(swept.stdout).not.toContain("Failed:");
    });

    // The take an address resolves to is its newest by `createdAt`, so a clock that stepped back
    // between the source's reservation and the correction's would hand consumers the take that was
    // corrected — silently, and only sometimes.
    it("registers a patched take that outranks its source after a backwards clock step", async () => {
      const projectDir = await initPatchProject();
      const address = "reference:latentA";
      const sourceId = await generateSource(projectDir);
      const ahead = new Date(Date.now() + 60_000).toISOString();
      await StateManager.withLock(projectDir, async (m) => {
        m.getAssetState(address).variants![sourceId]!.createdAt = ahead;
      });

      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const [, patched] = (await patchedVariants(projectDir, sourceId))[0]!;
      expect(patched.createdAt > ahead).toBe(true);
    });

    it("reports nothing to do when every patch is current", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply"], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const { stdout } = await run(["patch", "apply"], projectDir);
      expect(stdout).not.toContain("(patch of");
    });
  });
});
