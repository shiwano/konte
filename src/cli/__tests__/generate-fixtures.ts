// "  <address>: <action>[ (<detail>)][ [deps: …]]" — one plan line per asset the run would touch.
type PlanEntry = { address: string; action: string; detail: string };
export const planEntries = (stdout: string): PlanEntry[] =>
  [...stdout.matchAll(/^ {2}(\S+): (\w+)(.*)$/gm)].map((m) => ({
    address: m[1]!,
    action: m[2]!,
    detail: m[3]!,
  }));

// `latent` is exposed (returned) but not yet consumed by any panel/composition — a
// work-in-progress building block. The reference pool is generated to be referenced later,
// so `generate reference` must still plan it.
export const REFERENCE_EXPOSED_UNREFERENCED_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, { references: () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latent = asset("latent", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  return { character, bgm, latent };
} });
`;
