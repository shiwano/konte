import { describe, expect, it } from "vitest";
import type { ComfyUINodeDefinition } from "../types.js";
import { convertLitegraphToApi, flattenSubgraphs, type LitegraphWorkflow } from "../convert.js";

function makeNodeDef(
  required: Record<string, [string, ...unknown[]]> = {},
  optional: Record<string, [string, ...unknown[]]> = {},
): ComfyUINodeDefinition {
  return { input: { required, optional } };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("flattenSubgraphs", () => {
  it("returns the workflow unchanged when no subgraphs exist", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 2,
      last_link_id: 1,
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["test.png"] },
        { id: 2, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, "IMAGE"]],
    };

    const { workflow: result, subgraphMeta } = flattenSubgraphs(workflow);
    expect(result).toBe(workflow);
    expect(subgraphMeta.internalNodeIds.size).toBe(0);
    expect(subgraphMeta.inputTargetKeys.size).toBe(0);
  });

  it("expands a subgraph node with linked inputs", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 10,
      last_link_id: 20,
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["img.png"] },
        {
          id: 2,
          type: "sg-uuid-1",
          inputs: [{ name: "input", type: "IMAGE", link: 10 }],
          outputs: [{ name: "VIDEO", type: "VIDEO", links: [11] }],
          widgets_values: [],
        },
        { id: 3, type: "SaveVideo", inputs: [{ name: "video", type: "VIDEO", link: 11 }] },
      ],
      links: [
        [10, 1, 0, 2, 0, "IMAGE"],
        [11, 2, 0, 3, 0, "VIDEO"],
      ],
      definitions: {
        subgraphs: [
          {
            id: "sg-uuid-1",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [{ name: "input", type: "IMAGE", linkIds: [100] }],
            outputs: [{ name: "VIDEO", type: "VIDEO", linkIds: [101] }],
            nodes: [
              {
                id: 50,
                type: "ProcessImage",
                inputs: [{ name: "image", type: "IMAGE", link: 100 }],
                outputs: [{ name: "output", type: "IMAGE", links: [102] }],
                widgets_values: [42],
              },
              {
                id: 51,
                type: "CreateVideo",
                inputs: [{ name: "images", type: "IMAGE", link: 102 }],
                outputs: [{ name: "video", type: "VIDEO", links: [101] }],
                widgets_values: [30],
              },
            ],
            links: [
              {
                id: 100,
                origin_id: -10,
                origin_slot: 0,
                target_id: 50,
                target_slot: 0,
                type: "IMAGE",
              },
              {
                id: 102,
                origin_id: 50,
                origin_slot: 0,
                target_id: 51,
                target_slot: 0,
                type: "IMAGE",
              },
              {
                id: 101,
                origin_id: 51,
                origin_slot: 0,
                target_id: -20,
                target_slot: 0,
                type: "VIDEO",
              },
            ],
          },
        ],
      },
    };

    const { workflow: result } = flattenSubgraphs(workflow);

    expect(result.nodes.find((n) => n.type === "sg-uuid-1")).toBeUndefined();
    expect(result.nodes).toHaveLength(4);

    const processNode = result.nodes.find((n) => n.type === "ProcessImage")!;
    const createNode = result.nodes.find((n) => n.type === "CreateVideo")!;
    expect(processNode).toBeDefined();
    expect(createNode).toBeDefined();
    expect(processNode.widgets_values).toEqual([42]);
    expect(createNode.widgets_values).toEqual([30]);

    // ProcessImage's image input should link from LoadImage (node 1)
    const processImageInput = processNode.inputs!.find((i) => i.name === "image")!;
    expect(processImageInput.link).not.toBeNull();
    const processInputLink = result.links.find((l) => l[0] === processImageInput.link)!;
    expect(processInputLink[1]).toBe(1); // source is LoadImage
    expect(processInputLink[3]).toBe(processNode.id);

    // CreateVideo's images input should link from ProcessImage
    const createImagesInput = createNode.inputs!.find((i) => i.name === "images")!;
    expect(createImagesInput.link).not.toBeNull();
    const createInputLink = result.links.find((l) => l[0] === createImagesInput.link)!;
    expect(createInputLink[1]).toBe(processNode.id);
    expect(createInputLink[3]).toBe(createNode.id);

    // SaveVideo should link from CreateVideo (output remap)
    const saveVideoLink = result.links.find((l) => l[3] === 3)!;
    expect(saveVideoLink[1]).toBe(createNode.id);
  });

  it("nulls out widget proxy inputs (no parent link)", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 5,
      last_link_id: 10,
      nodes: [
        {
          id: 1,
          type: "sg-uuid-2",
          inputs: [{ name: "width", type: "INT", link: null, widget: { name: "width" } }],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [10] }],
          widgets_values: [],
        },
        { id: 2, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 10 }] },
      ],
      links: [[10, 1, 0, 2, 0, "IMAGE"]],
      definitions: {
        subgraphs: [
          {
            id: "sg-uuid-2",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [{ name: "width", type: "INT", linkIds: [200] }],
            outputs: [{ name: "IMAGE", type: "IMAGE", linkIds: [201] }],
            nodes: [
              {
                id: 30,
                type: "EmptyLatent",
                inputs: [{ name: "width", type: "INT", link: 200 }],
                outputs: [{ name: "LATENT", type: "LATENT", links: [202] }],
                widgets_values: [512, 512],
              },
              {
                id: 31,
                type: "VAEDecode",
                inputs: [{ name: "samples", type: "LATENT", link: 202 }],
                outputs: [{ name: "IMAGE", type: "IMAGE", links: [201] }],
              },
            ],
            links: [
              {
                id: 200,
                origin_id: -10,
                origin_slot: 0,
                target_id: 30,
                target_slot: 0,
                type: "INT",
              },
              {
                id: 202,
                origin_id: 30,
                origin_slot: 0,
                target_id: 31,
                target_slot: 0,
                type: "LATENT",
              },
              {
                id: 201,
                origin_id: 31,
                origin_slot: 0,
                target_id: -20,
                target_slot: 0,
                type: "IMAGE",
              },
            ],
          },
        ],
      },
    };

    const { workflow: result, subgraphMeta } = flattenSubgraphs(workflow);
    const emptyLatent = result.nodes.find((n) => n.type === "EmptyLatent")!;
    const widthInput = emptyLatent.inputs!.find((i) => i.name === "width")!;
    expect(widthInput.link).toBeNull();
    expect(emptyLatent.widgets_values).toEqual([512, 512]);
    expect(subgraphMeta.internalNodeIds).toContain(String(emptyLatent.id));
    expect(subgraphMeta.inputTargetKeys).toContain(`${emptyLatent.id}:width`);
  });

  it("handles fan-out inputs (one subgraph input → multiple internal targets)", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 5,
      last_link_id: 10,
      nodes: [
        { id: 1, type: "LoadModel" },
        {
          id: 2,
          type: "sg-fanout",
          inputs: [{ name: "model_name", type: "COMBO", link: 10 }],
          outputs: [{ name: "OUT", type: "MODEL", links: [] }],
          widgets_values: [],
        },
      ],
      links: [[10, 1, 0, 2, 0, "COMBO"]],
      definitions: {
        subgraphs: [
          {
            id: "sg-fanout",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [{ name: "model_name", type: "COMBO", linkIds: [300, 301] }],
            outputs: [],
            nodes: [
              {
                id: 40,
                type: "LoaderA",
                inputs: [{ name: "ckpt_name", type: "COMBO", link: 300 }],
              },
              {
                id: 41,
                type: "LoaderB",
                inputs: [{ name: "ckpt_name", type: "COMBO", link: 301 }],
              },
            ],
            links: [
              {
                id: 300,
                origin_id: -10,
                origin_slot: 0,
                target_id: 40,
                target_slot: 0,
                type: "COMBO",
              },
              {
                id: 301,
                origin_id: -10,
                origin_slot: 0,
                target_id: 41,
                target_slot: 0,
                type: "COMBO",
              },
            ],
          },
        ],
      },
    };

    const { workflow: result } = flattenSubgraphs(workflow);
    const loaderA = result.nodes.find((n) => n.type === "LoaderA")!;
    const loaderB = result.nodes.find((n) => n.type === "LoaderB")!;

    // Both should link from LoadModel (node 1)
    const linkA = result.links.find((l) => l[0] === loaderA.inputs![0]!.link)!;
    const linkB = result.links.find((l) => l[0] === loaderB.inputs![0]!.link)!;
    expect(linkA[1]).toBe(1);
    expect(linkB[1]).toBe(1);
  });

  it("remaps node IDs to avoid collisions", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 5,
      last_link_id: 10,
      nodes: [
        { id: 1, type: "NodeA" },
        {
          id: 2,
          type: "sg-collision",
          inputs: [],
          outputs: [{ name: "OUT", type: "DATA", links: [10] }],
          widgets_values: [],
        },
        { id: 3, type: "NodeB", inputs: [{ name: "data", type: "DATA", link: 10 }] },
      ],
      links: [[10, 2, 0, 3, 0, "DATA"]],
      definitions: {
        subgraphs: [
          {
            id: "sg-collision",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [{ name: "OUT", type: "DATA", linkIds: [500] }],
            nodes: [
              // Node IDs 1 and 3 collide with parent
              { id: 1, type: "InternalA", outputs: [{ name: "out", type: "DATA", links: [500] }] },
              { id: 3, type: "InternalB" },
            ],
            links: [
              {
                id: 500,
                origin_id: 1,
                origin_slot: 0,
                target_id: -20,
                target_slot: 0,
                type: "DATA",
              },
            ],
          },
        ],
      },
    };

    const { workflow: result } = flattenSubgraphs(workflow);
    const nodeIds = result.nodes.map((n) => n.id);
    const uniqueIds = new Set(nodeIds);
    expect(uniqueIds.size).toBe(nodeIds.length);

    // Original nodes 1, 3 should still exist
    expect(result.nodes.find((n) => n.id === 1 && n.type === "NodeA")).toBeDefined();
    expect(result.nodes.find((n) => n.id === 3 && n.type === "NodeB")).toBeDefined();

    // Internal nodes should have new IDs
    const internalA = result.nodes.find((n) => n.type === "InternalA")!;
    expect(internalA.id).toBeGreaterThan(5);
  });

  it("handles nested subgraphs", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 5,
      last_link_id: 10,
      nodes: [
        { id: 1, type: "Input" },
        {
          id: 2,
          type: "sg-outer",
          inputs: [{ name: "data", type: "DATA", link: 10 }],
          outputs: [{ name: "OUT", type: "DATA", links: [11] }],
          widgets_values: [],
        },
        { id: 3, type: "Output", inputs: [{ name: "data", type: "DATA", link: 11 }] },
      ],
      links: [
        [10, 1, 0, 2, 0, "DATA"],
        [11, 2, 0, 3, 0, "DATA"],
      ],
      definitions: {
        subgraphs: [
          {
            id: "sg-outer",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [{ name: "data", type: "DATA", linkIds: [600] }],
            outputs: [{ name: "OUT", type: "DATA", linkIds: [601] }],
            nodes: [
              {
                id: 60,
                type: "sg-inner",
                inputs: [{ name: "data", type: "DATA", link: 600 }],
                outputs: [{ name: "OUT", type: "DATA", links: [601] }],
                widgets_values: [],
              },
            ],
            links: [
              {
                id: 600,
                origin_id: -10,
                origin_slot: 0,
                target_id: 60,
                target_slot: 0,
                type: "DATA",
              },
              {
                id: 601,
                origin_id: 60,
                origin_slot: 0,
                target_id: -20,
                target_slot: 0,
                type: "DATA",
              },
            ],
          },
          {
            id: "sg-inner",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [{ name: "data", type: "DATA", linkIds: [700] }],
            outputs: [{ name: "OUT", type: "DATA", linkIds: [701] }],
            nodes: [
              {
                id: 70,
                type: "Transform",
                inputs: [{ name: "input", type: "DATA", link: 700 }],
                outputs: [{ name: "output", type: "DATA", links: [701] }],
                widgets_values: ["magic"],
              },
            ],
            links: [
              {
                id: 700,
                origin_id: -10,
                origin_slot: 0,
                target_id: 70,
                target_slot: 0,
                type: "DATA",
              },
              {
                id: 701,
                origin_id: 70,
                origin_slot: 0,
                target_id: -20,
                target_slot: 0,
                type: "DATA",
              },
            ],
          },
        ],
      },
    };

    const { workflow: result, subgraphMeta } = flattenSubgraphs(workflow);

    // No subgraph nodes should remain
    expect(result.nodes.find((n) => n.type === "sg-outer")).toBeUndefined();
    expect(result.nodes.find((n) => n.type === "sg-inner")).toBeUndefined();

    // Transform node should exist
    const transform = result.nodes.find((n) => n.type === "Transform")!;
    expect(transform).toBeDefined();
    expect(transform.widgets_values).toEqual(["magic"]);

    // Input(1) → Transform → Output(3)
    const transformInput = transform.inputs!.find((i) => i.name === "input")!;
    const inputLink = result.links.find((l) => l[0] === transformInput.link)!;
    expect(inputLink[1]).toBe(1); // source is Input node

    const outputLink = result.links.find((l) => l[3] === 3)!;
    expect(outputLink[1]).toBe(transform.id); // source is Transform node

    // Nested subgraph targets are NOT tracked (only first-level subgraph inputs)
    expect(subgraphMeta.internalNodeIds).toContain(String(transform.id));
    expect(subgraphMeta.inputTargetKeys.size).toBe(0);
  });
});

describe("convertLitegraphToApi", () => {
  const objectInfo: Record<string, ComfyUINodeDefinition> = {
    LoadImage: makeNodeDef({ image: ["IMAGEUPLOAD"] }),
    SaveImage: makeNodeDef({ filename_prefix: ["STRING"], images: ["IMAGE"] }),
    KSampler: makeNodeDef({
      seed: ["INT", { max: 0xffff_ffff_ffff }],
      steps: ["INT"],
      model: ["MODEL"],
      positive: ["CONDITIONING"],
      negative: ["CONDITIONING"],
      latent_image: ["LATENT"],
    }),
    CLIPTextEncode: makeNodeDef({ text: ["STRING"], clip: ["CLIP"] }),
  };

  it("converts a simple workflow without subgraphs", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 3,
      last_link_id: 2,
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          widgets_values: ["photo.png", "image"],
        },
        {
          id: 2,
          type: "SaveImage",
          inputs: [{ name: "images", type: "IMAGE", link: 1 }],
          widgets_values: ["output"],
        },
      ],
      links: [[1, 1, 0, 2, 0, "IMAGE"]],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, objectInfo);

    expect(result["1"]).toEqual({
      class_type: "LoadImage",
      inputs: { image: "photo.png" },
    });
    expect(result["2"]).toEqual({
      class_type: "SaveImage",
      inputs: { filename_prefix: "output", images: ["1", 0] },
    });
  });

  it("skips the widgets a frontend appends after an upload combo", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      LoadImage: makeNodeDef({ image: ["COMBO", { image_upload: true }] }),
      LoadAudio: makeNodeDef({ audio: ["COMBO", { audio_upload: true }], gain: ["FLOAT"] }),
      Load3D: makeNodeDef({
        model_file: ["COMBO", { file_upload: true }],
        image: ["LOAD_3D"],
        width: ["INT"],
        height: ["INT"],
      }),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 3,
      last_link_id: 0,
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          inputs: [
            { name: "image", type: "COMBO", link: null, widget: { name: "image" } },
            { name: "upload", type: "IMAGEUPLOAD", link: null, widget: { name: "upload" } },
          ],
          widgets_values: ["photo.png", "image"],
        },
        { id: 2, type: "LoadAudio", widgets_values: ["voice.mp3", null, null, 0.5] },
        {
          id: 3,
          type: "Load3D",
          widgets_values: [
            "toy.glb",
            "upload3dmodel",
            "uploadExtraResources",
            "clear",
            "",
            1024,
            768,
          ],
        },
      ],
      links: [],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    expect(result["1"]!.inputs).toEqual({ image: "photo.png" });
    expect(result["2"]!.inputs).toEqual({ audio: "voice.mp3", gain: 0.5 });
    expect(result["3"]!.inputs).toEqual({
      model_file: "toy.glb",
      image: "",
      width: 1024,
      height: 768,
    });
  });

  it("fills a required widget the template has no value for with its default", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      ResolutionSelector: makeNodeDef(
        {
          aspect_ratio: ["COMBO", { options: ["1:1", "16:9"] }],
          megapixels: ["FLOAT"],
          multiple: ["INT", { default: 8 }],
          mode: ["COMBO", { options: ["fast", "slow"] }],
          model: ["MODEL"],
        },
        { strength: ["FLOAT", { default: 1 }] },
      ),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [{ id: 1, type: "ResolutionSelector", widgets_values: ["16:9", 2] }],
      links: [],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    expect(result["1"]!.inputs).toEqual({
      aspect_ratio: "16:9",
      megapixels: 2,
      multiple: 8,
      mode: "fast",
    });
  });

  it("names every unknown node type in one error", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 4,
      last_link_id: 2,
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["img.png", "image"] },
        {
          id: 2,
          type: "UnknownCustomNode",
          inputs: [{ name: "image", type: "IMAGE", link: 1 }],
          widgets_values: [100, "fancy"],
        },
        { id: 3, type: "OtherCustomNode", widgets_values: [] },
        { id: 4, type: "UnknownCustomNode", widgets_values: [] },
      ],
      links: [[1, 1, 0, 2, 0, "IMAGE"]],
    };

    const err = thrown(() => convertLitegraphToApi(workflow, objectInfo));
    expect(err).toMatchObject({ code: "WORKFLOW_IMPORT_FAILED" });
    expect((err as Error).message).toContain('"UnknownCustomNode", "OtherCustomNode"');
  });

  it("skips Note, MarkdownNote, Reroute, PrimitiveNode, and bypassed nodes", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 5,
      last_link_id: 0,
      nodes: [
        { id: 1, type: "Note" },
        { id: 2, type: "MarkdownNote" },
        { id: 3, type: "Reroute" },
        { id: 4, type: "PrimitiveNode" },
        { id: 5, type: "LoadImage", mode: 4, widgets_values: ["img.png", "image"] },
      ],
      links: [],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, objectInfo);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("resolves Reroute node references to the actual source", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 4,
      last_link_id: 3,
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["photo.png", "image"] },
        {
          id: 2,
          type: "Reroute",
          inputs: [{ name: "", type: "*", link: 1 }],
          outputs: [{ name: "", type: "IMAGE", links: [2] }],
        },
        {
          id: 3,
          type: "Reroute",
          inputs: [{ name: "", type: "*", link: 2 }],
          outputs: [{ name: "", type: "IMAGE", links: [3] }],
        },
        {
          id: 4,
          type: "SaveImage",
          inputs: [{ name: "images", type: "IMAGE", link: 3 }],
          widgets_values: ["output"],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, "IMAGE"],
        [2, 2, 0, 3, 0, "IMAGE"],
        [3, 3, 0, 4, 0, "IMAGE"],
      ],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, objectInfo);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["4"]!.inputs.images).toEqual(["1", 0]);
  });

  it("resolves KJNodes Set/Get virtual nodes by name to the actual source", () => {
    // SetNode stores its input under a name (widgets_values[0]); a GetNode mirrors it
    // with no litegraph link between them. The consumer links from the GetNode's output.
    const workflow: LitegraphWorkflow = {
      last_node_id: 4,
      last_link_id: 2,
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["photo.png", "image"] },
        {
          id: 2,
          type: "SetNode",
          inputs: [{ name: "IMAGE", type: "IMAGE", link: 1 }],
          outputs: [{ name: "*", type: "*", links: null }],
          widgets_values: ["my_image"],
        },
        {
          id: 3,
          type: "GetNode",
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }],
          widgets_values: ["my_image"],
        },
        {
          id: 4,
          type: "SaveImage",
          inputs: [{ name: "images", type: "IMAGE", link: 2 }],
          widgets_values: ["output"],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, "IMAGE"],
        [2, 3, 0, 4, 0, "IMAGE"],
      ],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, objectInfo);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["2"]).toBeUndefined();
    expect(result["3"]).toBeUndefined();
    expect(result["4"]!.inputs.images).toEqual(["1", 0]);
  });

  it("resolves a Get→Set chain that passes through a Reroute", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 5,
      last_link_id: 3,
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["photo.png", "image"] },
        {
          id: 2,
          type: "Reroute",
          inputs: [{ name: "", type: "*", link: 1 }],
          outputs: [{ name: "", type: "IMAGE", links: [2] }],
        },
        {
          id: 3,
          type: "SetNode",
          inputs: [{ name: "IMAGE", type: "IMAGE", link: 2 }],
          outputs: [{ name: "*", type: "*", links: null }],
          widgets_values: ["routed"],
        },
        {
          id: 4,
          type: "GetNode",
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [3] }],
          widgets_values: ["routed"],
        },
        {
          id: 5,
          type: "SaveImage",
          inputs: [{ name: "images", type: "IMAGE", link: 3 }],
          widgets_values: ["output"],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, "IMAGE"],
        [2, 2, 0, 3, 0, "IMAGE"],
        [3, 4, 0, 5, 0, "IMAGE"],
      ],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, objectInfo);
    expect(result["5"]!.inputs.images).toEqual(["1", 0]);
  });

  it("leaves a GetNode whose SetNode is missing as a dangling self-reference", () => {
    // A malformed workflow (Get with no matching Set) must not throw or loop forever.
    const workflow: LitegraphWorkflow = {
      last_node_id: 2,
      last_link_id: 1,
      nodes: [
        {
          id: 1,
          type: "GetNode",
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
          widgets_values: ["never_set"],
        },
        {
          id: 2,
          type: "SaveImage",
          inputs: [{ name: "images", type: "IMAGE", link: 1 }],
          widgets_values: ["output"],
        },
      ],
      links: [[1, 1, 0, 2, 0, "IMAGE"]],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, objectInfo);
    expect(result["2"]!.inputs.images).toEqual(["1", 0]);
  });

  it("inlines a PrimitiveNode's value into every widget it feeds", () => {
    // A single "seed" PrimitiveNode fans out to two consumers (mirrors the ACE-Step
    // split workflows): both must receive the literal value, not a dangling link.
    const workflow: LitegraphWorkflow = {
      last_node_id: 3,
      last_link_id: 2,
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          outputs: [{ name: "INT", type: "INT", links: [1, 2] }],
          widgets_values: [31, "fixed"],
        },
        {
          id: 2,
          type: "KSampler",
          inputs: [{ name: "seed", type: "INT", link: 1, widget: { name: "seed" } }],
          widgets_values: [31, "fixed", 20],
        },
        {
          id: 3,
          type: "CLIPTextEncode",
          inputs: [
            { name: "text", type: "STRING", link: null },
            { name: "seed", type: "INT", link: 2, widget: { name: "seed" } },
          ],
          widgets_values: ["a prompt", 31],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, "INT"],
        [2, 1, 0, 3, 1, "INT"],
      ],
    };

    const info: Record<string, ComfyUINodeDefinition> = {
      KSampler: makeNodeDef({ seed: ["INT", { max: 0xffff_ffff_ffff }], steps: ["INT"] }),
      CLIPTextEncode: makeNodeDef({ text: ["STRING"], seed: ["INT", { max: 0xffff_ffff_ffff }] }),
    };

    const { workflow: result, subgraphMeta } = convertLitegraphToApi(workflow, info);
    expect(result["1"]).toBeUndefined(); // PrimitiveNode itself is not emitted
    expect(result["2"]!.inputs.seed).toBe(31);
    expect(result["3"]!.inputs.seed).toBe(31);
    // The shared primitive's two consumers are recorded so the adapter can collapse them.
    expect(subgraphMeta.sharedPrimitiveGroups).toEqual([
      [
        { nodeId: "2", field: "seed" },
        { nodeId: "3", field: "seed" },
      ],
    ]);
  });

  it("inlines a PrimitiveNode value reached through a Reroute", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 3,
      last_link_id: 2,
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          outputs: [{ name: "INT", type: "INT", links: [1] }],
          widgets_values: [7, "fixed"],
        },
        {
          id: 2,
          type: "Reroute",
          inputs: [{ name: "", type: "*", link: 1 }],
          outputs: [{ name: "", type: "INT", links: [2] }],
        },
        {
          id: 3,
          type: "KSampler",
          inputs: [{ name: "seed", type: "INT", link: 2, widget: { name: "seed" } }],
          widgets_values: [7, "fixed", 20],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, "INT"],
        [2, 2, 0, 3, 0, "INT"],
      ],
    };

    const info: Record<string, ComfyUINodeDefinition> = {
      KSampler: makeNodeDef({ seed: ["INT", { max: 0xffff_ffff_ffff }], steps: ["INT"] }),
    };

    const { workflow: result, subgraphMeta } = convertLitegraphToApi(workflow, info);
    expect(result["3"]!.inputs.seed).toBe(7);
    // A primitive with a single consumer needs no collapse group.
    expect(subgraphMeta.sharedPrimitiveGroups).toEqual([]);
  });

  it("skips linked sub-widget values and maps subsequent fields correctly", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      ResizeImageMaskNode: makeNodeDef({
        input: ["IMAGE"],
        resize_type: ["COMBO", { options: ["scale dimensions", "resize to area"] }],
        crop: ["COMBO", { options: ["center", "disabled"] }],
        scale_method: ["COMBO", { options: ["lanczos", "nearest"] }],
      }),
      IntSource: makeNodeDef(),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 4,
      last_link_id: 3,
      nodes: [
        {
          id: 1,
          type: "ResizeImageMaskNode",
          inputs: [
            { name: "input", type: "IMAGE", link: 1 },
            {
              name: "resize_type.width",
              type: "INT",
              link: 2,
              widget: { name: "resize_type.width" },
            },
            {
              name: "resize_type.height",
              type: "INT",
              link: 3,
              widget: { name: "resize_type.height" },
            },
          ],
          widgets_values: ["scale dimensions", 1920, 1088, "center", "lanczos"],
        },
        { id: 2, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [2] }] },
        { id: 3, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [3] }] },
      ],
      links: [
        [1, 10, 0, 1, 0, "IMAGE"],
        [2, 2, 0, 1, 1, "INT"],
        [3, 3, 0, 1, 2, "INT"],
      ],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    const node = result["1"]!;
    expect(node.inputs.resize_type).toBe("scale dimensions");
    expect(node.inputs.scale_method).toBe("lanczos");
    expect(node.inputs.crop).toBe("center");
    expect(node.inputs["resize_type.width"]).toEqual(["2", 0]);
    expect(node.inputs["resize_type.height"]).toEqual(["3", 0]);
  });

  it("sets unlinked sub-widget values in inputs", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      ResizeImageMaskNode: makeNodeDef({
        input: ["IMAGE"],
        resize_type: ["COMBO", { options: ["scale dimensions", "resize to area"] }],
        crop: ["COMBO", { options: ["center", "disabled"] }],
        scale_method: ["COMBO", { options: ["lanczos", "nearest"] }],
      }),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 1,
      last_link_id: 1,
      nodes: [
        {
          id: 1,
          type: "ResizeImageMaskNode",
          inputs: [
            { name: "input", type: "IMAGE", link: 1 },
            {
              name: "resize_type.width",
              type: "INT",
              link: null,
              widget: { name: "resize_type.width" },
            },
            {
              name: "resize_type.height",
              type: "INT",
              link: null,
              widget: { name: "resize_type.height" },
            },
          ],
          widgets_values: ["scale dimensions", 1920, 1088, "center", "lanczos"],
        },
      ],
      links: [[1, 10, 0, 1, 0, "IMAGE"]],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    const node = result["1"]!;
    expect(node.inputs.resize_type).toBe("scale dimensions");
    expect(node.inputs["resize_type.width"]).toBe(1920);
    expect(node.inputs["resize_type.height"]).toBe(1088);
    expect(node.inputs.scale_method).toBe("lanczos");
    expect(node.inputs.crop).toBe("center");
  });

  it("handles COMFY_DYNAMICCOMBO_V3 sub-widgets from type definition", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      ResizeImageMaskNode: makeNodeDef({
        input: ["IMAGE"],
        resize_type: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              {
                key: "scale dimensions",
                inputs: {
                  required: {
                    width: ["INT", { default: 512 }],
                    height: ["INT", { default: 512 }],
                    crop: ["COMBO", { options: ["disabled", "center"] }],
                  },
                },
              },
            ],
          },
        ],
        scale_method: ["COMBO", { options: ["nearest-exact", "lanczos"] }],
      }),
      IntSource: makeNodeDef(),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 4,
      last_link_id: 3,
      nodes: [
        {
          id: 1,
          type: "ResizeImageMaskNode",
          inputs: [
            { name: "input", type: "IMAGE", link: 1 },
            {
              name: "resize_type.width",
              type: "INT",
              link: 2,
              widget: { name: "resize_type.width" },
            },
            {
              name: "resize_type.height",
              type: "INT",
              link: 3,
              widget: { name: "resize_type.height" },
            },
          ],
          widgets_values: ["scale dimensions", 1920, 1088, "center", "lanczos"],
        },
        { id: 2, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [2] }] },
        { id: 3, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [3] }] },
      ],
      links: [
        [1, 10, 0, 1, 0, "IMAGE"],
        [2, 2, 0, 1, 1, "INT"],
        [3, 3, 0, 1, 2, "INT"],
      ],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    const node = result["1"]!;
    expect(node.inputs.resize_type).toBe("scale dimensions");
    expect(node.inputs["resize_type.crop"]).toBe("center");
    expect(node.inputs.scale_method).toBe("lanczos");
    expect(node.inputs["resize_type.width"]).toEqual(["2", 0]);
    expect(node.inputs["resize_type.height"]).toEqual(["3", 0]);
  });

  it("gives a COMFY_DYNAMICCOMBO_V3 option's sockets no widget value", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      ImageNode: makeNodeDef({
        prompt: ["STRING"],
        model: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              {
                key: "pro",
                inputs: {
                  required: {
                    width: ["INT", { default: 1024 }],
                    height: ["INT", { default: 1024 }],
                    images: ["COMFY_AUTOGROW_V3", { template: {} }],
                    mask: ["MASK"],
                  },
                },
              },
            ],
          },
        ],
        seed: ["INT", { control_after_generate: true }],
      }),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [
        {
          id: 1,
          type: "ImageNode",
          widgets_values: ["a prompt", "pro", 1920, 1088, 7, "randomize"],
        },
      ],
      links: [],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    expect(result["1"]!.inputs).toEqual({
      prompt: "a prompt",
      model: "pro",
      "model.width": 1920,
      "model.height": 1088,
      seed: 7,
    });
  });

  it("maps object-form widgets_values by input name", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      VHS_VideoCombine: makeNodeDef({
        images: ["IMAGE"],
        frame_rate: ["FLOAT"],
        filename_prefix: ["STRING"],
        format: ["COMBO", { options: ["video/h264-mp4", "image/gif"] }],
      }),
      ImageSource: makeNodeDef(),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 2,
      last_link_id: 1,
      nodes: [
        {
          id: 1,
          type: "VHS_VideoCombine",
          inputs: [
            { name: "images", type: "IMAGE", link: 1 },
            { name: "frame_rate", type: "FLOAT", link: null, widget: { name: "frame_rate" } },
          ],
          widgets_values: {
            frame_rate: 24,
            filename_prefix: "out",
            format: "video/h264-mp4",
            videopreview: { hidden: false },
          },
        },
        { id: 2, type: "ImageSource", outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }] },
      ],
      links: [[1, 2, 0, 1, 0, "IMAGE"]],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    expect(result["1"]!.inputs).toEqual({
      images: ["2", 0],
      frame_rate: 24,
      filename_prefix: "out",
      format: "video/h264-mp4",
    });
  });

  it("throws on unrecognized widget input not in object_info (no dot)", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      TestNode: makeNodeDef({ known_field: ["STRING"] }),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [
        {
          id: 1,
          type: "TestNode",
          inputs: [
            { name: "mystery_widget", type: "INT", link: null, widget: { name: "mystery_widget" } },
          ],
          widgets_values: ["hello"],
        },
      ],
      links: [],
    };

    expect(thrown(() => convertLitegraphToApi(workflow, info))).toMatchObject({
      code: "WORKFLOW_IMPORT_FAILED",
    });
  });

  it("throws on sub-widget whose parent is not in object_info", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      TestNode: makeNodeDef({ known_field: ["STRING"] }),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [
        {
          id: 1,
          type: "TestNode",
          inputs: [
            {
              name: "unknown_parent.child",
              type: "INT",
              link: null,
              widget: { name: "unknown_parent.child" },
            },
          ],
          widgets_values: ["hello"],
        },
      ],
      links: [],
    };

    expect(thrown(() => convertLitegraphToApi(workflow, info))).toMatchObject({
      code: "WORKFLOW_IMPORT_FAILED",
    });
  });

  it("converts a workflow with subgraphs end-to-end", () => {
    const workflow: LitegraphWorkflow = {
      last_node_id: 10,
      last_link_id: 20,
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["photo.png", "image"] },
        {
          id: 2,
          type: "sg-process",
          inputs: [{ name: "image_in", type: "IMAGE", link: 15 }],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [16] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "SaveImage",
          inputs: [{ name: "images", type: "IMAGE", link: 16 }],
          widgets_values: ["result"],
        },
      ],
      links: [
        [15, 1, 0, 2, 0, "IMAGE"],
        [16, 2, 0, 3, 0, "IMAGE"],
      ],
      definitions: {
        subgraphs: [
          {
            id: "sg-process",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [{ name: "image_in", type: "IMAGE", linkIds: [800] }],
            outputs: [{ name: "IMAGE", type: "IMAGE", linkIds: [801] }],
            nodes: [
              {
                id: 80,
                type: "CLIPTextEncode",
                inputs: [{ name: "clip", type: "CLIP", link: 800 }],
                outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [801] }],
                widgets_values: ["a beautiful scene"],
              },
            ],
            links: [
              {
                id: 800,
                origin_id: -10,
                origin_slot: 0,
                target_id: 80,
                target_slot: 0,
                type: "IMAGE",
              },
              {
                id: 801,
                origin_id: 80,
                origin_slot: 0,
                target_id: -20,
                target_slot: 0,
                type: "IMAGE",
              },
            ],
          },
        ],
      },
    };

    const { workflow: result, subgraphMeta } = convertLitegraphToApi(workflow, objectInfo);

    expect(result["1"]).toEqual({
      class_type: "LoadImage",
      inputs: { image: "photo.png" },
    });

    // The expanded CLIPTextEncode node should be present with a remapped ID
    const clipEntry = Object.entries(result).find(([, v]) => v.class_type === "CLIPTextEncode");
    expect(clipEntry).toBeDefined();
    const [clipId, clipNode] = clipEntry!;
    expect(clipNode.inputs.text).toBe("a beautiful scene");
    expect(clipNode.inputs.clip).toEqual(["1", 0]); // linked to LoadImage

    // SaveImage should reference the expanded CLIPTextEncode node
    expect(result["3"]).toEqual({
      class_type: "SaveImage",
      inputs: { filename_prefix: "result", images: [clipId, 0] },
    });

    // Subgraph metadata: CLIPTextEncode is internal, its "clip" input is a subgraph input target
    expect(subgraphMeta.internalNodeIds).toContain(clipId);
    expect(subgraphMeta.inputTargetKeys).toContain(`${clipId}:clip`);
  });

  it("aligns widgets_values correctly when widget inputs are converted to linked inputs", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      EmptyLatentVideo: makeNodeDef({
        width: ["INT"],
        height: ["INT"],
        length: ["INT"],
        batch_size: ["INT"],
      }),
      IntSource: makeNodeDef(),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 4,
      last_link_id: 3,
      nodes: [
        {
          id: 1,
          type: "EmptyLatentVideo",
          inputs: [
            { name: "width", type: "INT", link: 1, widget: { name: "width" } },
            { name: "height", type: "INT", link: 2, widget: { name: "height" } },
            { name: "length", type: "INT", link: 3, widget: { name: "length" } },
          ],
          widgets_values: [768, 512, 97, 1],
        },
        { id: 2, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [1] }] },
        { id: 3, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [2] }] },
        { id: 4, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [3] }] },
      ],
      links: [
        [1, 2, 0, 1, 0, "INT"],
        [2, 3, 0, 1, 1, "INT"],
        [3, 4, 0, 1, 2, "INT"],
      ],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    const node = result["1"]!;
    expect(node.inputs.batch_size).toBe(1);
    expect(node.inputs.width).toEqual(["2", 0]);
    expect(node.inputs.height).toEqual(["3", 0]);
    expect(node.inputs.length).toEqual(["4", 0]);
  });

  it("skips slot-type inputs when aligning widgets_values", () => {
    const info: Record<string, ComfyUINodeDefinition> = {
      EmptyLatentAudio: makeNodeDef({
        frames_number: ["INT"],
        frame_rate: ["INT"],
        batch_size: ["INT"],
        audio_vae: ["VAE"],
      }),
      IntSource: makeNodeDef(),
      VAESource: makeNodeDef(),
    };

    const workflow: LitegraphWorkflow = {
      last_node_id: 4,
      last_link_id: 3,
      nodes: [
        {
          id: 1,
          type: "EmptyLatentAudio",
          inputs: [
            { name: "audio_vae", type: "VAE", link: 1 },
            { name: "frames_number", type: "INT", link: 2, widget: { name: "frames_number" } },
            { name: "frame_rate", type: "INT", link: 3, widget: { name: "frame_rate" } },
          ],
          widgets_values: [97, 25, 1],
        },
        { id: 2, type: "VAESource", outputs: [{ name: "VAE", type: "VAE", links: [1] }] },
        { id: 3, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [2] }] },
        { id: 4, type: "IntSource", outputs: [{ name: "INT", type: "INT", links: [3] }] },
      ],
      links: [
        [1, 2, 0, 1, 0, "VAE"],
        [2, 3, 0, 1, 1, "INT"],
        [3, 4, 0, 1, 2, "INT"],
      ],
    };

    const { workflow: result } = convertLitegraphToApi(workflow, info);
    const node = result["1"]!;
    expect(node.inputs.batch_size).toBe(1);
    expect(node.inputs.audio_vae).toEqual(["2", 0]);
    expect(node.inputs.frames_number).toEqual(["3", 0]);
    expect(node.inputs.frame_rate).toEqual(["4", 0]);
  });
});
