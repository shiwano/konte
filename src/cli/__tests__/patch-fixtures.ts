import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StateManager } from "../../core/state/manager.js";
import { ctx, run, initWorkspace } from "./cli-fixtures.js";

// The patch cycle's shared fixture, split across the cli-patch-*.test.ts files so the suite runs
// them in parallel.
// Offline ffmpeg building blocks: an image to correct, and a second one the patch can pull in as
// an extra reference, so the whole patch cycle runs end-to-end without a backend. `latentA` is
// the take a correction is made against and accepted at, which is review work — hence
// `internalTestImage` rather than a shipped `local` adapter, whose takes are konte's own.
export const REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
import direction from "./direction";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage, internalTestPlate } from "konte";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latentA = asset("latentA", internalTestImage, { width: 64, height: 64 });
  const latentB = asset("latentB", internalTestPlate, { width: 48, height: 48, color: "#00ff00" });
  return { character, bgm, latentA, latentB };
});
`;

// imageResize stands in for an image-edit model: it takes the source image and emits a new one.
export const patchScript = (extra = "") => `import { asset, definePatch, adapters } from "konte";
${extra}
export default definePatch<"image">(({ source }) =>
  asset("patched", adapters.imageResize, { image: source, width: 32, height: 32 }),
);
`;

export async function initPatchProject(): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, `patchproj-${Math.random()}`));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_TS);
  return projectDir;
}

// Generates the reference pool and returns the ready variant id of `latentA`.
export async function generateSource(
  projectDir: string,
  address = "reference:latentA",
): Promise<string> {
  await run(["generate", "reference"], projectDir);
  await run(["job", "wait"], projectDir).catch(() => undefined);
  const sm = await StateManager.load(projectDir);
  const variants = sm.getState().assets[address]?.variants ?? {};
  const ready = Object.entries(variants).find(([, v]) => v.file);
  if (!ready) throw new Error(`no ready variant for ${address}`);
  return ready[0];
}

export async function writePatch(projectDir: string, variantId: string, body = patchScript()) {
  await fs.mkdir(path.join(projectDir, "patches"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "patches", `${variantId}.ts`), body);
}

export async function variantsOf(projectDir: string, address: string) {
  const sm = await StateManager.load(projectDir);
  return sm.getState().assets[address]?.variants ?? {};
}

// The patched variants a source take carries, newest last. The apply reports the chain's job, not
// this — the patched variant is registered when the returned step's take lands.
export async function patchedVariants(
  projectDir: string,
  sourceId: string,
  address = "reference:latentA",
) {
  const variants = await variantsOf(projectDir, address);
  return Object.entries(variants).filter(([, v]) => v.derivedFrom === sourceId);
}
