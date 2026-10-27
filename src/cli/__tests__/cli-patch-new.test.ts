import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import { useTempWorkspace, run } from "./cli-fixtures.js";
import { initPatchProject, generateSource, writePatch, patchedVariants } from "./patch-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

describe("patch command", () => {
  describe("patch new", () => {
    it("scaffolds patches/<variantId>.ts for a ready variant", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);

      const file = path.join(projectDir, "patches", `${sourceId}.ts`);
      const { stdout } = await run(["patch", "new", sourceId], projectDir);
      expect(stdout).toContain(`Created ${file}`);
      expect(stdout).toContain(`  patches reference:latentA (${sourceId})`);

      const written = await fs.readFile(file, "utf-8");
      // The source's media kind is pinned as the type argument, so the take can be fed straight to
      // a typed adapter input — the one thing the author cannot supply from the filename alone.
      expect(written).toContain(`definePatch<"image">`);
      expect(written).toContain("return source;");
      expect(written).toContain(`// import reference from "../reference";`);
    });

    // A review round hands back several takes to correct at once; scaffolding them one call at a
    // time is what pushes an author back to rerolling the whole set instead.
    it("scaffolds one file per take from a single call", async () => {
      const projectDir = await initPatchProject();
      const a = await generateSource(projectDir);
      const b = await generateSource(projectDir, "reference:latentB");

      const { stdout } = await run(["patch", "new", a, b], projectDir);
      expect([...stdout.matchAll(/ {2}patches \S+ \((\S+)\)/g)].map((m) => m[1])).toEqual([a, b]);
      for (const id of [a, b]) {
        const written = await fs.readFile(path.join(projectDir, "patches", `${id}.ts`), "utf-8");
        expect(written).toContain("return source;");
      }
    });

    // The lookup this replaces: with several takes at an address there was no way to name the
    // live one, so its id had to be dug out of the path `konte path` prints.
    it("takes an address with several takes, landing on the one it resolves to", async () => {
      const projectDir = await initPatchProject();
      const address = "reference:latentA";
      await generateSource(projectDir);

      // A second, newer take, accepted — so the address resolves to it and not to the first.
      const live = await StateManager.withLock(projectDir, async (m) => {
        const id = m.reserveVariantId(address);
        m.getAssetState(address).variants![id]!.file = "assets/latest.png";
        m.setAccepted(address, id);
        return id;
      });

      const { stdout } = await run(["patch", "new", address], projectDir);
      expect(stdout).toContain(`  patches ${address} (${live})`);
    });

    // Correcting an older take is what the id form is for, so the address form must not be the
    // only way in — naming a superseded take still scaffolds against that exact take.
    it("still patches an older take when its id is named", async () => {
      const projectDir = await initPatchProject();
      const address = "reference:latentA";
      const older = await generateSource(projectDir);
      await StateManager.withLock(projectDir, async (m) => {
        const id = m.reserveVariantId(address);
        m.getAssetState(address).variants![id]!.file = "assets/latest.png";
        m.setAccepted(address, id);
      });

      const { stdout } = await run(["patch", "new", older], projectDir);
      expect(stdout).toContain(`  patches ${address} (${older})`);
    });

    // An id and an address that resolves to it are two ways of writing one target, not two.
    it("scaffolds once when two arguments name the same take", async () => {
      const projectDir = await initPatchProject();
      const a = await generateSource(projectDir);

      const { stdout } = await run(["patch", "new", a, "reference:latentA"], projectDir);
      expect([...stdout.matchAll(/^Created /gm)]).toHaveLength(1);
    });

    // Half a batch is worse than none: a retry would have to reason about which takes already
    // carry a script. Every target is checked before the first file is written.
    it("writes nothing when a later target is rejected", async () => {
      const projectDir = await initPatchProject();
      const a = await generateSource(projectDir);

      const err = await run(["patch", "new", a, "v-nosuchvariant"], projectDir).catch((e) => e);
      expect(err.stderr).toContain("VARIANT_NOT_FOUND");
      await expect(fs.access(path.join(projectDir, "patches", `${a}.ts`))).rejects.toThrow();
    });

    // The filename IS the constraint: one patch script per take, enforced by the filesystem.
    it("refuses a second patch for the same variant", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await run(["patch", "new", sourceId], projectDir);

      const err = await run(["patch", "new", sourceId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_ALREADY_EXISTS");
    });

    // A second script would key a correction to a take its own source script replaces on the next
    // apply; the fix belongs in the chain that produced it.
    it("refuses a take that a patch produced", async () => {
      const projectDir = await initPatchProject();
      const sourceId = await generateSource(projectDir);
      await writePatch(projectDir, sourceId);
      await run(["patch", "apply", sourceId], projectDir);
      await run(["job", "wait"], projectDir).catch(() => undefined);
      const [producedId] = (await patchedVariants(projectDir, sourceId))[0]!;

      const err = await run(["patch", "new", producedId], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_TARGET_INVALID");
      expect(err.stderr).toContain(`patches/${sourceId}.ts`);
      await expect(
        fs.access(path.join(projectDir, "patches", `${producedId}.ts`)),
      ).rejects.toThrow();
    });

    // A chain step is the patch's own working material — correcting one from outside would key a
    // script to an address the script itself declares.
    it("refuses a step of a patch chain", async () => {
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

      const err = await run(["patch", "new", `reference:patch.${sourceId}.wide`], projectDir).catch(
        (e) => e,
      );
      expect(err.stderr).toContain("PATCH_TARGET_INVALID");
    });

    it("refuses a variant with no output file yet", async () => {
      const projectDir = await initPatchProject();
      await run(["generate", "reference"], projectDir);
      const sm = await StateManager.load(projectDir);
      await StateManager.withLock(projectDir, async (m) => {
        for (const v of Object.values(m.getAssetState("reference:latentA").variants ?? {})) {
          v.file = null;
        }
      });
      const pending = Object.keys(sm.getState().assets["reference:latentA"]?.variants ?? {})[0]!;

      const err = await run(["patch", "new", pending], projectDir).catch((e) => e);
      expect(err.stderr).toContain("PATCH_SOURCE_NOT_READY");
    });
  });
});
