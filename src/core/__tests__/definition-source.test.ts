import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDefinitionSourceFingerprint, listDefinitionSources } from "../definition-source.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

let ws: Workspace;
let videoRoot: string;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"] });
  videoRoot = ws.videos.v1!.video;
  await fs.writeFile(path.join(videoRoot, "direction.ts"), "export default { beats: [] };\n");
  await fs.writeFile(path.join(videoRoot, "animatic.tsx"), "export default { shots: [] };\n");
});

afterEach(async () => {
  await ws.cleanup();
});

describe("computeDefinitionSourceFingerprint", () => {
  it("is stable while the files are", async () => {
    const a = await computeDefinitionSourceFingerprint(videoRoot);
    const b = await computeDefinitionSourceFingerprint(videoRoot);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("moves with a stage entry's content, not its timestamp", async () => {
    const before = await computeDefinitionSourceFingerprint(videoRoot);
    const file = path.join(videoRoot, "animatic.tsx");
    const stat = await fs.stat(file);
    await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 60_000));
    expect(await computeDefinitionSourceFingerprint(videoRoot)).toBe(before);
    await fs.writeFile(file, "export default { shots: [1] };\n");
    expect(await computeDefinitionSourceFingerprint(videoRoot)).not.toBe(before);
  });

  it("covers the workspace's adapters and the video's patches, and skips dot directories", async () => {
    const base = await computeDefinitionSourceFingerprint(videoRoot);

    await fs.mkdir(path.join(ws.root, "adapters", "comfy"), { recursive: true });
    await fs.writeFile(path.join(ws.root, "adapters", "comfy", "x.ts"), "export const x = 1;\n");
    const withAdapter = await computeDefinitionSourceFingerprint(videoRoot);
    expect(withAdapter).not.toBe(base);

    await fs.mkdir(path.join(videoRoot, "patches"), { recursive: true });
    await fs.writeFile(path.join(videoRoot, "patches", "v-abc.ts"), "export default {};\n");
    const withPatch = await computeDefinitionSourceFingerprint(videoRoot);
    expect(withPatch).not.toBe(withAdapter);

    await fs.writeFile(path.join(videoRoot, ".konte", "scratch.ts"), "export const y = 2;\n");
    expect(await computeDefinitionSourceFingerprint(videoRoot)).toBe(withPatch);

    const sources = await listDefinitionSources(videoRoot);
    expect(sources.map((f) => path.relative(ws.root, f)).sort()).toEqual([
      "adapters/comfy/x.ts",
      "videos/v1/animatic.tsx",
      "videos/v1/direction.ts",
      "videos/v1/patches/v-abc.ts",
    ]);
  });
});
