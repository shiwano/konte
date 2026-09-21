import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import { useTempWorkspace, run, writeWorkspaceConfig } from "./cli-fixtures.js";
import {
  REFERENCE_TS,
  initPatchProject,
  generateSource,
  writePatch,
  variantsOf,
  patchedVariants,
} from "./patch-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

describe("patch command", () => {
  describe("generate", () => {
    // A pending patch is unrealized declared work, the same status as an ungenerated asset, so
    // the command the author was already going to run picks it up.
    it("applies a pending patch as part of the run", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);

      const { stdout } = await run(["generate", "reference"], projectDir);

      expect(stdout).toContain("Patches applied:");
      expect(stdout).toContain(`reference:patch.${sourceId}.patched`);
      expect(stdout).toContain(`(patch of ${sourceId})`);
      expect(stdout).not.toContain("Patches failed:");
    });

    // A broken script means the correction the author wrote will not happen, so it is this run's
    // failure — not a warning the exit code forgets about.
    it("fails the run when a patch script in this stage is broken", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId, "export default 1;\n");

      const err = await run(["patch", "apply"], projectDir).catch((e) => e);
      expect(err.code).toBe(1);
      expect(err.stdout + err.stderr).toContain(sourceId);
    });

    // A patch's `--plan` cost must show, or the preview understates what the command will spend.
    it("lists pending patches in generate --plan", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);

      const { stdout } = await run(["generate", "reference", "--plan"], projectDir);

      expect(stdout).toContain("Patches to apply: 1");
      expect(stdout).toContain(`  reference:latentA (patch of ${sourceId})`);
    });

    it("leaves an already-current patch alone", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const { stdout } = await run(["generate", "reference"], projectDir);
      expect(stdout).not.toContain("Patches applied:");
    });

    // With nothing accepted at the source address, resolution falls through to the correction —
    // so the consumer really is built on a superseded frame, and the next run rebuilds it.
    it("puts a downstream consumer of an unaccepted source back in the work list", async () => {
      const projectDir = await initPatchProject();
      await fs.writeFile(
        path.join(projectDir, "reference.tsx"),
        REFERENCE_TS.replace(
          "return { character, bgm, latentA, latentB };",
          `const derived = asset("derived", adapters.imageResize, { image: latentA, width: 16, height: 16 });
  return { character, bgm, latentA, latentB, derived };`,
        ),
      );
      const sourceId = await generateSource(projectDir);
      // Drop any accepts — the patch output's included — to reach the unaccepted regime this covers.
      const dropAccepts = () =>
        StateManager.withLock(projectDir, async (m) => {
          for (const address of ["reference:latentA", "reference:derived"]) {
            const accepted = m.getAcceptedVariant(address);
            if (accepted) m.setUnaccepted(address, accepted);
          }
        });
      await dropAccepts();

      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);
      // The correction has to have landed for the consumer to be stale against it at all.
      expect(await patchedVariants(projectDir, sourceId)).toHaveLength(1);
      await dropAccepts();

      const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
      const planFor = (address: string) =>
        stdout.split("\n").find((line) => line.trim().startsWith(`${address}: `));

      expect(planFor("reference:derived")).not.toContain("skip");
      expect(planFor("reference:latentA")).toContain("skip (already ready)");
    });

    // The source stops being one of the choices the moment it is patched — it becomes the
    // "before" of the correction — which is what keeps the gallery at one tile per decision.
    it("takes the source out of the review candidates", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["generate", "reference"], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);

      const { stdout } = await run(["inspect", "reference:latentA"], projectDir);
      const lines = stdout.split("\n");
      const sourceAt = lines.findIndex((line) => line.trim().startsWith(`${sourceId}: `));
      const producedAt = lines.findIndex((line) => line.trim().startsWith(`patch of ${sourceId} `));

      // The source is superseded by the correction; the take the patch produced is the leaf.
      expect(lines[sourceAt + 1]).toContain("superseded by a patch (not a review candidate)");
      expect(lines[producedAt + 1]).not.toContain("superseded by a patch");
      const stepVariantId = Object.keys(
        await variantsOf(projectDir, `reference:patch.${sourceId}.patched`),
      )[0]!;
      expect(lines[producedAt]).toContain(
        `file from reference:patch.${sourceId}.patched (${stepVariantId})`,
      );
    });
  });

  describe("clean", () => {
    it("removes the patch script alongside its source variant", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);

      await run(["clean", "reference", "--delete-unaccepted", "-y"], projectDir);

      expect(await variantsOf(projectDir, "reference:latentA")).not.toHaveProperty(sourceId);
      await expect(fs.access(path.join(projectDir, "patches", `${sourceId}.ts`))).rejects.toThrow();
    });

    // Protection travels UP the lineage: the source file is the patch's input, so an accepted
    // correction must keep the take it corrected.
    // The chain is pinned to this exact take and the finalize that follows it reads the take back,
    // so cutting it mid-apply would fail that commit and leave the job unable to settle.
    it("keeps a source whose patch is still applying", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      // Unaccepted, so `clean --delete-unaccepted` would otherwise take it — acceptance protects it on its own.
      await StateManager.withLock(projectDir, async (m) => {
        m.getAssetState("reference:latentA").variants![sourceId]!.status = "none";
      });
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);

      // No `job wait`: the chain is in flight.
      const { stdout } = await run(["clean", "--delete-unaccepted", "-y"], projectDir);
      expect(stdout).not.toContain(`Removed: reference:latentA ${sourceId}`);
      expect(stdout).toContain("has a patch applying");
      expect((await variantsOf(projectDir, "reference:latentA"))[sourceId]).toBeDefined();
    });

    // Accepting a correction says nothing against the take it corrects: that take is the "before"
    // of it, and `patch remove` hands the address back to it. Dismissing it there would leave the
    // address resolving to nothing once the correction is dropped.
    it("leaves the corrected take undecided when its correction is accepted", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await run(["accept", sourceId, "--yes"], projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);
      const [producedId] = (await patchedVariants(projectDir, sourceId))[0]!;

      await run(["accept", producedId, "--yes"], projectDir);

      const variants = await variantsOf(projectDir, "reference:latentA");
      expect(variants[producedId]!.status).toBe("accepted");
      expect(variants[sourceId]!.status).toBe("none");

      // …so dropping the patch leaves a usable take behind.
      await run(["patch", "remove", sourceId, "-y"], projectDir);
      const sm = await StateManager.load(projectDir);
      expect(sm.resolveReference("reference:latentA")?.variantId).toBe(sourceId);
    });

    it("keeps a source whose correction is accepted", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);
      const [producedId] = (await patchedVariants(projectDir, sourceId))[0]!;
      await run(["accept", producedId], projectDir);

      await run(["clean", "reference", "--delete-unaccepted", "-y"], projectDir);

      const variants = await variantsOf(projectDir, "reference:latentA");
      expect(variants[sourceId]).toBeDefined();
      expect(variants[producedId]).toBeDefined();
    });
  });

  // A patch is the second definition source a spend reaches: status must report a blocked
  // correction rather than offer the command that would abort on it.

  describe("prompt gate", () => {
    const negatedPatch = `import { asset, definePatch } from "konte";
import { imageQwenImageEdit21Inpaint } from "konte/workspace/adapters/comfy/image_qwen_image_edit_2_1_inpaint.js";

export default definePatch<"image">(({ source }) =>
  asset("patched", imageQwenImageEdit21Inpaint, {
    image1: source,
    left: 0.25,
    top: 0.1,
    right: 0.4,
    bottom: 0.6,
    prompt: "redraw the cup, no chip",
  }),
);
`;

    it("reports the finding under the patch file and withholds patch apply", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId, negatedPatch);

      const { stdout } = await run(["status"], projectDir);
      const finding = stdout.split("\n").find((line) => line.includes(`patches/${sourceId}.ts`));

      expect(finding).toContain("no chip");
      expect(stdout).not.toContain("konte patch apply");
    });

    it("refuses the apply itself", async () => {
      const projectDir = await initPatchProject();
      // The backend gate is checked first, and this patch reaches for a comfy adapter — without a
      // ComfyUI URL the apply would abort on that instead, testing the wrong gate.
      await writeWorkspaceConfig(projectDir, { comfyui: { url: "http://127.0.0.1:8188" } });
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId, negatedPatch);

      await expect(run(["patch", "apply", sourceId], projectDir)).rejects.toMatchObject({
        stderr: expect.stringMatching(/PROMPT_CHECK_FAILED[\s\S]*no chip/),
      });
    });
  });
});
