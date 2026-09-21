import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace, run, runCapture } from "../../__tests__/harness.js";

let tmpDir: string;
let workspaceDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-adapter-show-"));
  ({ workspace: workspaceDir } = await initWorkspace(path.join(tmpDir, "ws")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("adapter show command", () => {
  it("resolves a prebuilt adapter by export name, bare or `adapters.`-prefixed", async () => {
    const bare = await runCapture(["adapter", "show", "imageResize"], workspaceDir);
    const prefixed = await runCapture(["adapter", "show", "adapters.imageResize"], workspaceDir);

    expect(bare.stdout).toContain("adapters.imageResize");
    expect(bare.stdout).toContain("(local,");
    expect(prefixed.stdout).toContain("adapters.imageResize");
  });

  it("resolves a workspace vendor adapter bare, and not through `adapters.`", async () => {
    const { stdout } = await runCapture(["adapter", "show", "falSeedance25T2v"], workspaceDir);

    expect(stdout).toContain("(fal,");
    expect(stdout).toContain("konte/workspace/adapters/fal/seedance-2-5.js");
    expect(stdout).not.toContain("adapters.falSeedance25T2v");

    await expect(
      run(["adapter", "show", "adapters.falSeedance25T2v"], workspaceDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("ADAPTER_NOT_FOUND") });
  });

  it("resolves a workspace comfy adapter by its workflow filename, .json optional", async () => {
    const noExt = await runCapture(["adapter", "show", "video_minimax_h3_r2v"], workspaceDir);
    const withExt = await runCapture(
      ["adapter", "show", "video_minimax_h3_r2v.json"],
      workspaceDir,
    );

    expect(noExt.stdout).toMatch(/^videoMinimaxH3R2v {2}\(comfy, video\)/m);
    expect(withExt.stdout).toMatch(/^videoMinimaxH3R2v {2}\(comfy, video\)/m);
  });

  it("resolves an adapter by its ref basename, path stripped", async () => {
    const { stdout } = await runCapture(["adapter", "show", "video-upscaler"], workspaceDir);
    expect(stdout).toContain("ref     fal-ai/video-upscaler");
  });

  it("prefers an export-name match over a ref match", async () => {
    // The export name wins even if some other adapter's ref happens to look similar.
    const { stdout } = await runCapture(["adapter", "show", "videoMinimaxH3R2v"], workspaceDir);
    expect(stdout).not.toContain("adapters match");
    expect(stdout).toContain("ref     video_minimax_h3_r2v.json");
  });

  it("does not fall back to the model reference for an explicit `adapters.` query", async () => {
    await expect(
      run(["adapter", "show", "adapters.video_minimax_h3_r2v"], workspaceDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("ADAPTER_NOT_FOUND") });
  });

  it("errors ADAPTER_NOT_FOUND on an unknown name", async () => {
    await expect(run(["adapter", "show", "no_such_thing"], workspaceDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(/ADAPTER_NOT_FOUND.*No adapter matching/s),
    });
  });

  it("prints every adapter a shared ref matches, each pointing at the shared guide", async () => {
    const twin = (name: string) => `import { defineComfyAsset } from "konte";
export const ${name} = defineComfyAsset({
  workflow: "shared_ref.json",
  description: "wraps ${name}",
  guide: "./shared.md",
  inputs: {},
  outputs: { image: { nodeId: "9", type: "image" } },
});
`;
    const comfyDir = path.join(workspaceDir, "adapters", "comfy");
    await fs.writeFile(path.join(comfyDir, "shared.md"), "PROMPT GUIDE BODY\n");
    await fs.writeFile(path.join(comfyDir, "ref_a.ts"), twin("refA"));
    await fs.writeFile(path.join(comfyDir, "ref_b.ts"), twin("refB"));

    const { stdout } = await runCapture(["adapter", "show", "shared_ref"], workspaceDir);

    expect(stdout).toContain('2 adapters match "shared_ref"');
    expect(stdout).toContain("refA");
    expect(stdout).toContain("refB");
    // The guide is named, never inlined — the body costs nothing however many adapters front it.
    expect(stdout).not.toContain("PROMPT GUIDE BODY");
    expect(stdout.split(path.join(comfyDir, "shared.md")).length - 1).toBe(2);
  });

  it.each([
    ["imageMinimaxH3R2i", ["minimax-h3.md", "minimax-h3-picture.md", "minimax-h3-r2i.md"]],
    [
      "videoMinimaxH3R2v",
      ["minimax-h3.md", "minimax-h3-picture.md", "minimax-h3-sound.md", "minimax-h3-r2v.md"],
    ],
    ["audioMinimaxH3R2a", ["minimax-h3.md", "minimax-h3-sound.md", "minimax-h3-r2a.md"]],
  ])("points %s at its konte-managed guides, in order", async (adapter, guides) => {
    const { stdout } = await runCapture(["adapter", "show", adapter], workspaceDir);
    const guideLines = stdout.split("\n").filter((line) => line.startsWith("guide   "));
    const guidePaths = guides.map((guide) => path.join(workspaceDir, ".konte", "guides", guide));
    expect(guideLines.map((line) => line.split(/\s{2,}/)[1])).toEqual(guidePaths);
    expect(guideLines[0]).toContain("(read each, in order, before writing a prompt)");
    for (const guidePath of guidePaths) await fs.access(guidePath);
  });

  it("marks a guide whose file is gone, and keeps printing the schema", async () => {
    const source = `import { defineComfyAsset } from "konte";
export const missingGuide = defineComfyAsset({
  workflow: "missing_guide.json",
  description: "names a guide that is not there",
  guide: "konte/guides/no-such-guide.md",
  inputs: {},
  outputs: { image: { nodeId: "9", type: "image" } },
});
`;
    await fs.writeFile(path.join(workspaceDir, "adapters", "comfy", "missing_guide.ts"), source);

    const { stdout } = await runCapture(["adapter", "show", "missingGuide"], workspaceDir);
    expect(stdout).toContain("konte/guides/no-such-guide.md  (missing)");
    expect(stdout).toContain("names a guide that is not there");
  });

  it("lists required inputs first, keeping declaration order within each group", async () => {
    const source = `import { defineComfyAsset } from "konte";
export const ordered = defineComfyAsset({
  workflow: "ordered.json",
  description: "declares its required inputs last",
  inputs: {
    steps: { type: "number", default: 20 },
    cfg: { type: "number", default: 3 },
    startImage: { type: "image", required: true },
    seed: { type: "number", default: 0 },
    endImage: { type: "image", required: true },
  },
  outputs: { image: { nodeId: "9", type: "image" } },
});
`;
    await fs.writeFile(path.join(workspaceDir, "adapters", "comfy", "ordered.ts"), source);

    const { stdout } = await runCapture(["adapter", "show", "ordered"], workspaceDir);
    const rows = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0]!)
      .filter((name) => ["steps", "cfg", "startImage", "seed", "endImage"].includes(name));

    // Required first, so cutting the table short never hides an input the asset() call must pass.
    expect(rows).toEqual(["startImage", "endImage", "steps", "cfg", "seed"]);
  });

  it("prints every adapter a ref matches, under a count of them", async () => {
    const twin = (name: string) => `import { defineComfyAsset } from "konte";
export const ${name} = defineComfyAsset({
  workflow: "shared_ref.json",
  description: "wraps ${name}",
  inputs: {},
  outputs: { image: { nodeId: "9", type: "image" } },
});
`;
    await fs.writeFile(path.join(workspaceDir, "adapters", "comfy", "ref_a.ts"), twin("refA"));
    await fs.writeFile(path.join(workspaceDir, "adapters", "comfy", "ref_b.ts"), twin("refB"));

    const { stdout } = await runCapture(["adapter", "show", "shared_ref"], workspaceDir);

    expect(stdout).toContain('2 adapters match "shared_ref":');
    expect(stdout).toMatch(/^refA {2}\(comfy, image\)/m);
    expect(stdout).toMatch(/^refB {2}\(comfy, image\)/m);
  });

  // A fresh workspace's konte.config.json carries a ComfyUI URL and no credential file, so comfy is
  // configured and fal is not.
  it("reports whether the adapter's backend is configured", async () => {
    const show = async (name: string) => {
      const { stdout } = await runCapture(["adapter", "show", name], workspaceDir);
      return stdout.includes("(not configured)");
    };

    expect(await show("videoMinimaxH3R2v")).toBe(false);
    expect(await show("falSeedance25I2v")).toBe(true);
    // `file`/`local` need no backend, so there is nothing to be unconfigured about.
    expect(await show("adapters.imageResize")).toBe(false);
  });

  it("claims nothing about the backend when konte.config.json cannot be read", async () => {
    await fs.writeFile(path.join(workspaceDir, "konte.config.json"), "{ not valid json");

    const { stdout } = await runCapture(["adapter", "show", "falSeedance25I2v"], workspaceDir);

    expect(stdout).toContain("falSeedance25I2v");
    expect(stdout).not.toContain("(not configured)");
  });

  it("marks a number's grid and a frame count's clock in the TYPE column", async () => {
    const { stdout } = await runCapture(["adapter", "show", "videoMinimaxH3R2v"], workspaceDir);
    expect(stdout).toMatch(/width\s+×32/);
    expect(stdout).toMatch(/frames@24\s+×17\+5/);
  });

  it("quotes each allowed value in the VALUES column", async () => {
    const source = `import { defineComfyAsset } from "konte";
export const banded = defineComfyAsset({
  workflow: "banded.json",
  description: "takes a labelled band",
  inputs: {
    loudnessLufs: {
      nodeId: "3",
      field: "loudness_lufs",
      type: "string",
      default: "default",
      values: ["default", "8: -18.5--14"],
    },
  },
  outputs: { audio: { nodeId: "9", type: "audio" } },
});
`;
    await fs.writeFile(path.join(workspaceDir, "adapters", "comfy", "banded.ts"), source);

    const { stdout } = await runCapture(["adapter", "show", "banded"], workspaceDir);
    // The whole band string is the value — unquoted, `8: -18.5--14` reads as an index and a gloss.
    expect(stdout).toContain('"default", "8: -18.5--14"');
  });

  it("lists a structured prompt's fields under it, constant ones left out", async () => {
    const { stdout } = await runCapture(["adapter", "show", "imageMinimaxH3R2i"], workspaceDir);
    const lines = stdout.split("\n");
    const at = lines.findIndex((line) => /^prompt\s+prompt\b/.test(line));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 5).map((line) => line.trim().split(/\s+/)[0])).toEqual([
      "subjectDefinitions",
      "summary",
      "retentionAnalysis",
      "detailedDescription",
    ]);
    expect(lines[at + 1]).toMatch(/^ {2}subjectDefinitions\s+yes\s+one line per label/);
    expect(stdout).not.toContain("overallSoundscape");
  });
});
