import * as path from "node:path";
import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { loadWorkflow, parameterizeWorkflow } from "../../comfyui/workflow.js";
import type { ComfyUIWorkflow } from "../../comfyui/types.js";
import { loadPatchStepDefinition } from "../../core/patch.js";
import { loadReference } from "../../core/loader.js";
import { StateManager } from "../../core/state/manager.js";
import type { ComfyAssetDefinition } from "../../core/types/index.js";
import { run, useTempWorkspace } from "./cli-fixtures.js";
import { generateSource, initPatchProject, writePatch } from "./patch-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

// The graph that holds the edit to the region is assembled by the generator
// (`useInpaintCropAndStitch`), so these takes read it back by class rather than by node id.
const PATCH_TS = (edges: string) => `import { asset, definePatch } from "konte";
import { imageQwenImageEdit21Inpaint } from "konte/workspace/adapters/comfy/image_qwen_image_edit_2_1_inpaint.js";

export default definePatch<"image">(({ source }) =>
  asset("patched", imageQwenImageEdit21Inpaint, {
    image1: source,
    ${edges}
    prompt: "In <image1>, replace the white mug with a small potted cactus",
  }),
);
`;

const EDGES = "left: 0.25, top: 0.1, right: 0.4, bottom: 0.6,";

async function stepDefinition(projectDir: string, sourceId: string): Promise<ComfyAssetDefinition> {
  const sm = await StateManager.load(projectDir);
  const definition = await loadPatchStepDefinition(
    projectDir,
    sm.getState(),
    `reference:patch.${sourceId}.patched`,
  );
  return definition as ComfyAssetDefinition;
}

function workflowPath(
  projectDir: string,
  filename = "image_qwen_image_edit_2_1_inpaint.json",
): string {
  return path.resolve(projectDir, "..", "..", "adapters", "comfy", filename);
}

function onlyId(workflow: ComfyUIWorkflow, classType: string): string {
  const found = Object.entries(workflow).filter(([, node]) => node.class_type === classType);
  expect(found).toHaveLength(1);
  return found[0]![0];
}

describe("shipped Qwen 2.1 inpaint adapter", () => {
  const patch = PATCH_TS;
  const model = {
    adapter: "imageQwenImageEdit21Inpaint",
    edges: ["489", "490", "491", "492"],
    source: "470",
    refs: ["475", "486"],
    save: "SaveImageAdvanced",
  };
  const workflowFile = workflowPath;
  it("samples the scaled crop under the region mask and pastes it back over the source", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId, patch(EDGES));
    const workflow = await loadWorkflow(workflowFile(projectDir));

    const patched = await stepDefinition(projectDir, sourceId);
    // The region reaches the graph as the four fractions.
    expect(patched.inputs[`${model.edges[0]}.value`]).toBe(0.25);
    expect(patched.inputs[`${model.edges[1]}.value`]).toBe(0.1);
    expect(patched.inputs[`${model.edges[2]}.value`]).toBe(0.4);
    expect(patched.inputs[`${model.edges[3]}.value`]).toBe(0.6);
    expect(patched.inputs[`${model.source}.image`]).toBe("__konte:reference:latentA__");

    // The two reference loaders go with the inputs left unset, leaving image 1's.
    expect(patched.prunedNodes).toEqual(expect.arrayContaining(model.refs));
    const graph = parameterizeWorkflow(workflow, patched.inputs, 1, undefined, patched.prunedNodes);
    const source = onlyId(graph, "LoadImage");
    const crop = onlyId(graph, "ImageCrop");
    const encode = onlyId(graph, "VAEEncode");
    const decode = onlyId(graph, "VAEDecode");
    const sampler = onlyId(graph, "KSampler");
    const noiseMask = onlyId(graph, "SetLatentNoiseMask");
    const mask = onlyId(graph, "ImageToMask");
    const composite = onlyId(graph, "ImageCompositeMasked");
    const save = onlyId(graph, model.save);

    // The scaled crop is what the model sees — both encoders and the latent it samples. A
    // frame-sized latent here would redraw the whole picture.
    expect(graph[crop]!.inputs.image).toEqual([source, 0]);
    const work = (graph[encode]!.inputs.pixels as [string, number])[0];
    expect(graph[work]!.class_type).toBe("ImageScale");
    expect(graph[work]!.inputs.image).toEqual([crop, 0]);
    for (const [, node] of Object.entries(graph)) {
      if (node.class_type === "TextEncodeQwenImage21") {
        expect(node.inputs["images.image_1"]).toEqual([work, 0]);
        expect(node.inputs.resolution).toBe(0);
        expect(node.inputs["images.image_2"]).toBeUndefined();
        expect(node.inputs["images.image_3"]).toBeUndefined();
      }
    }
    expect(graph[sampler]!.inputs.latent_image).toEqual([noiseMask, 0]);
    expect(graph[noiseMask]!.inputs).toEqual({ samples: [encode, 0], mask: [mask, 0] });

    expect(graph[save]!.inputs.images).toEqual([composite, 0]);
    expect(graph[composite]!.inputs.destination).toEqual([source, 0]);
    expect(graph[composite]!.inputs.mask).toEqual([mask, 0]);
    const restored = (graph[composite]!.inputs.source as [string, number])[0];
    expect(graph[restored]!.class_type).toBe("ImageScale");
    expect(graph[restored]!.inputs.image).toEqual([decode, 0]);
    expect(graph[composite]!.inputs.x).toEqual(graph[crop]!.inputs.x);
    expect(graph[composite]!.inputs.y).toEqual(graph[crop]!.inputs.y);
  });

  it("rounds the region's edges to whole pixels", async () => {
    const projectDir = await initPatchProject();
    const workflow = await loadWorkflow(workflowFile(projectDir));
    const expressions = Object.values(workflow)
      .filter((node) => node.class_type === "ComfyMathExpression")
      .map((node) => node.inputs.expression as string);
    expect(expressions).toContain("round(a * e)");
    expect(expressions).toContain("max(1, round(b * e) - round(a * e))");
    expect(expressions.some((e) => e.includes("ceil(b * e)"))).toBe(false);
  });

  it("refuses an edge outside 0–1 and a rectangle with no area", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);

    await writePatch(projectDir, sourceId, patch("left: 0.25, top: 0.1, right: 1.4, bottom: 0.6,"));
    await expect(stepDefinition(projectDir, sourceId)).rejects.toThrow(
      /right must be a fraction of image 1 from 0 to 1/,
    );

    await writePatch(projectDir, sourceId, patch("left: 0.5, top: 0.6, right: 0.5, bottom: 0.2,"));
    await expect(stepDefinition(projectDir, sourceId)).rejects.toThrow(
      /left \(0\.5\) must be less than right \(0\.5\)/,
    );
  });

  // The preserved pixels belong to the source take.
  it("is declared in a patch only", async () => {
    const projectDir = await initPatchProject();
    const { stdout } = await run(["adapter", "show", model.adapter], projectDir);
    expect(stdout).toContain("declared in patch only");
  });
});

describe("shipped Qwen Image 2.1 reference adapter", () => {
  it("loads a style conversion with source conditioning and the requested aspect ratio", async () => {
    const projectDir = await initPatchProject();
    await fs.writeFile(
      path.join(projectDir, "reference.tsx"),
      `import { asset, adapters, defineReference } from "konte";
import { imageQwenImageEdit21 } from "konte/workspace/adapters/comfy/image_qwen_image_edit_2_1.js";
import direction from "./direction";

export default defineReference(direction, () => {
  const source = asset("source", adapters.imageFile, { path: "assets/files/character.png" });
  const illustration = asset("illustration", imageQwenImageEdit21, {
    image1: source,
    prompt: "Render <image1> as a pen-and-ink illustration with fine black contours and flat muted colors.",
    width: 768,
    height: 1024,
  });
  return { illustration };
});
`,
    );
    const reference = await loadReference(projectDir);
    const definition = reference.topLevelAssets!.illustration as ComfyAssetDefinition;
    const workflow = await loadWorkflow(
      path.join(path.dirname(workflowPath(projectDir)), "image_qwen_image_edit_2_1.json"),
    );
    const graph = parameterizeWorkflow(
      workflow,
      definition.inputs,
      1,
      undefined,
      definition.prunedNodes,
    );
    expect(graph[onlyId(graph, "EmptyLatentImage")]!.inputs).toEqual({
      width: 768,
      height: 1024,
      batch_size: 1,
    });
    expect(graph[onlyId(graph, "LoadImage")]!.inputs.image).toBe("__konte:reference:source__");
    expect(graph[onlyId(graph, "SaveImageAdvanced")]!.inputs.images).toEqual([
      onlyId(graph, "VAEDecode"),
      0,
    ]);
    const { stdout } = await run(["adapter", "show", "imageQwenImageEdit21"], projectDir);
    expect(stdout).toContain("declared in reference, shot only");
    expect(stdout).toContain("qwen-image-edit-2-1.md");
  });

  it("ships only the two Qwen 2.1 replacement adapters", async () => {
    const projectDir = await initPatchProject();
    const { stdout } = await run(["adapter", "list"], projectDir);
    expect(stdout).toContain("imageQwenImageEdit21");
    expect(stdout).toContain("imageQwenImageEdit21Inpaint");
    expect(stdout).not.toContain("2511");
  });

  it("refuses the unmasked adapter even in a patch over a reference take", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(
      projectDir,
      sourceId,
      PATCH_TS("")
        .replaceAll("imageQwenImageEdit21Inpaint", "imageQwenImageEdit21")
        .replace("image_qwen_image_edit_2_1_inpaint.js", "image_qwen_image_edit_2_1.js"),
    );
    await expect(stepDefinition(projectDir, sourceId)).rejects.toThrow(
      /may only be declared in reference or shot/,
    );
  });
});
