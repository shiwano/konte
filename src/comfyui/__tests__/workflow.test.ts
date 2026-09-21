import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComfyUIWorkflow } from "../types.js";
import {
  computeInputHash,
  computeWorkflowHash,
  loadWorkflow,
  parameterizeWorkflow,
} from "../workflow.js";

const sampleWorkflow: ComfyUIWorkflow = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "default prompt",
      clip: ["4", 1],
    },
  },
  "9": {
    class_type: "SaveImage",
    inputs: {
      filename_prefix: "output",
      images: ["8", 0],
    },
  },
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-wf-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadWorkflow", () => {
  it("loads a valid workflow JSON", async () => {
    const workflowPath = path.join(tmpDir, "test.json");
    await fs.writeFile(workflowPath, JSON.stringify(sampleWorkflow), "utf-8");

    const result = await loadWorkflow(workflowPath);
    expect(result["3"]!.class_type).toBe("KSampler");
    expect(result["6"]!.inputs.text).toBe("default prompt");
  });

  it("throws WORKFLOW_NOT_FOUND for missing file", async () => {
    await expect(loadWorkflow("/nonexistent/path.json")).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND",
    });
  });

  it("throws WORKFLOW_INVALID for invalid JSON", async () => {
    const workflowPath = path.join(tmpDir, "bad.json");
    await fs.writeFile(workflowPath, "not json", "utf-8");

    await expect(loadWorkflow(workflowPath)).rejects.toMatchObject({
      code: "WORKFLOW_INVALID",
    });
  });

  it("throws WORKFLOW_INVALID for non-object JSON", async () => {
    const workflowPath = path.join(tmpDir, "array.json");
    await fs.writeFile(workflowPath, "[1, 2, 3]", "utf-8");

    await expect(loadWorkflow(workflowPath)).rejects.toMatchObject({
      code: "WORKFLOW_INVALID",
    });
  });
});

describe("parameterizeWorkflow", () => {
  it("injects inputs into matching nodes", () => {
    const result = parameterizeWorkflow(
      sampleWorkflow,
      { "3": { seed: 42 }, "6": { text: "a cat walking" } },
      42,
    );

    expect(result["3"]!.inputs.seed).toBe(42);
    expect(result["3"]!.inputs.steps).toBe(20);
    expect(result["6"]!.inputs.text).toBe("a cat walking");
  });

  it("does not modify the original workflow", () => {
    parameterizeWorkflow(sampleWorkflow, { "3": { seed: 99 } }, 99);

    expect(sampleWorkflow["3"]!.inputs.seed).toBe(0);
  });

  it("ignores non-existent node IDs", () => {
    const result = parameterizeWorkflow(sampleWorkflow, { "999": { seed: 42 } }, 42);

    expect(result["3"]!.inputs.seed).toBe(0);
    expect(result["999"]).toBeUndefined();
  });

  it("substitutes __konte:seed__ placeholder with the given seed", () => {
    const workflow: ComfyUIWorkflow = {
      "3": {
        class_type: "KSampler",
        inputs: { seed: "__konte:seed__", steps: 20 },
      },
    };
    const result = parameterizeWorkflow(workflow, {}, 12345);
    expect(result["3"]!.inputs.seed).toBe(12345);
  });

  it("substitutes __konte:<address>__ placeholder with resolved dependency path", () => {
    const workflow: ComfyUIWorkflow = {
      "10": {
        class_type: "LoadVideo",
        inputs: { video: "__konte:video:shot.01.motion__" },
      },
    };
    const deps = { "video:shot.01.motion": "/path/to/motion.mp4" };
    const result = parameterizeWorkflow(workflow, {}, 42, deps);
    expect(result["10"]!.inputs.video).toBe("/path/to/motion.mp4");
  });

  it("substitutes placeholders in nested structures (arrays and objects)", () => {
    const workflow: ComfyUIWorkflow = {
      "5": {
        class_type: "Custom",
        inputs: {
          nested: { inner: "__konte:seed__" },
          list: ["__konte:video:timeline.bg__", "keep"],
        },
      },
    };
    const deps = { "video:timeline.bg": "/path/to/bg.png" };
    const result = parameterizeWorkflow(workflow, {}, 999, deps);
    expect((result["5"]!.inputs.nested as Record<string, unknown>).inner).toBe(999);
    expect(result["5"]!.inputs.list).toEqual(["/path/to/bg.png", "keep"]);
  });

  it("leaves unresolved placeholders unchanged", () => {
    const workflow: ComfyUIWorkflow = {
      "7": {
        class_type: "LoadVideo",
        inputs: { video: "__konte:video:shot.02.bg__" },
      },
    };
    const result = parameterizeWorkflow(workflow, {}, 42, {});
    expect(result["7"]!.inputs.video).toBe("__konte:video:shot.02.bg__");
  });

  it("does not affect non-placeholder strings", () => {
    const workflow: ComfyUIWorkflow = {
      "6": {
        class_type: "CLIPTextEncode",
        inputs: { text: "a cat walking", clip: ["4", 1] },
      },
    };
    const result = parameterizeWorkflow(workflow, {}, 42);
    expect(result["6"]!.inputs.text).toBe("a cat walking");
  });

  describe("composite keys (nodeId.field format)", () => {
    it("sets a node field via composite key", () => {
      const result = parameterizeWorkflow(sampleWorkflow, { "6.text": "a dog running" }, 42);

      expect(result["6"]!.inputs.text).toBe("a dog running");
      expect(result["6"]!.inputs.clip).toEqual(["4", 1]);
    });

    it("handles mixed composite keys and object-form overrides", () => {
      const result = parameterizeWorkflow(
        sampleWorkflow,
        { "3": { seed: 42 }, "6.text": "mixed mode" },
        42,
      );

      expect(result["3"]!.inputs.seed).toBe(42);
      expect(result["6"]!.inputs.text).toBe("mixed mode");
    });

    it("substitutes placeholders in composite key values via resolvedDependencies", () => {
      const workflow: ComfyUIWorkflow = {
        "10": {
          class_type: "LoadImage",
          inputs: { image: "default.png" },
        },
      };
      const deps = { "video:shot.09.keyframe": "/uploaded/keyframe.png" };
      const result = parameterizeWorkflow(
        workflow,
        { "10.image": "__konte:video:shot.09.keyframe__" },
        42,
        deps,
      );

      expect(result["10"]!.inputs.image).toBe("/uploaded/keyframe.png");
    });

    it("ignores composite keys with non-existent node IDs", () => {
      const result = parameterizeWorkflow(sampleWorkflow, { "999.text": "nowhere" }, 42);

      expect(result["999"]).toBeUndefined();
      expect(result["6"]!.inputs.text).toBe("default prompt");
    });
  });

  describe("prunedNodes", () => {
    const workflowWithOptionalImage: ComfyUIWorkflow = {
      "1": { class_type: "LoadImage", inputs: { image: "primary.png" } },
      "83": { class_type: "LoadImage", inputs: { image: "texture_fur.png" } },
      "201": {
        class_type: "TextEncodeQwenImageEditPlus",
        inputs: { prompt: "edit", image1: ["1", 0], image2: ["83", 0] },
      },
      "199": {
        class_type: "TextEncodeQwenImageEditPlus",
        inputs: { prompt: "", image1: ["1", 0], image2: ["83", 0] },
      },
    };

    it("removes pruned nodes and links into them", () => {
      const result = parameterizeWorkflow(workflowWithOptionalImage, {}, 42, undefined, ["83"]);
      expect(result["83"]).toBeUndefined();
      expect(result["201"]!.inputs.image2).toBeUndefined();
      expect(result["199"]!.inputs.image2).toBeUndefined();
      expect(result["201"]!.inputs.image1).toEqual(["1", 0]);
    });

    it("does not modify the original workflow", () => {
      parameterizeWorkflow(workflowWithOptionalImage, {}, 42, undefined, ["83"]);
      expect(workflowWithOptionalImage["83"]).toBeDefined();
      expect(workflowWithOptionalImage["201"]!.inputs.image2).toEqual(["83", 0]);
    });

    it("leaves the workflow untouched when nothing is pruned", () => {
      const result = parameterizeWorkflow(workflowWithOptionalImage, {}, 42);
      expect(result["83"]).toBeDefined();
      expect(result["201"]!.inputs.image2).toEqual(["83", 0]);
    });
  });

  // An optional branch that sits IN a chain rather than at its end — a ControlNet on the model
  // line. Dropping its links would leave the sampler with no model at all, so a pruned
  // pass-through hands its consumers whatever fed the named socket.
  describe("prunedPassThroughs", () => {
    const workflowWithControlNet: ComfyUIWorkflow = {
      "196": { class_type: "VAELoader", inputs: { vae_name: "vae.safetensors" } },
      "209": { class_type: "UNETLoader", inputs: { unet_name: "model.safetensors" } },
      "220": { class_type: "ModelPatchLoader", inputs: { name: "depth.safetensors" } },
      "221": { class_type: "LoadImage", inputs: { image: "example.png" } },
      "222": {
        class_type: "QwenImageDiffsynthControlnet",
        inputs: {
          model: ["209", 0],
          model_patch: ["220", 0],
          vae: ["196", 0],
          image: ["221", 0],
          strength: 1,
        },
      },
      "215": { class_type: "KSampler", inputs: { model: ["222", 0], seed: 1 } },
    };

    it("splices a pruned pass-through out, re-pointing its consumer at what fed it", () => {
      const result = parameterizeWorkflow(
        workflowWithControlNet,
        {},
        42,
        undefined,
        ["220", "221", "222"],
        { "222": "model" },
      );
      expect(result["220"]).toBeUndefined();
      expect(result["221"]).toBeUndefined();
      expect(result["222"]).toBeUndefined();
      // The sampler kept a model — the unpatched one the ControlNet was wrapping.
      expect(result["215"]!.inputs.model).toEqual(["209", 0]);
      expect(result["209"]).toBeDefined();
    });

    it("keeps the branch when the input is provided", () => {
      const result = parameterizeWorkflow(workflowWithControlNet, {}, 42);
      expect(result["215"]!.inputs.model).toEqual(["222", 0]);
      expect(result["222"]!.inputs.image).toEqual(["221", 0]);
    });

    // Without a pass-through there is nothing to fall back to, so the link goes rather than
    // pointing at a node that is no longer there.
    it("drops the link when the pruned node is not a pass-through", () => {
      const result = parameterizeWorkflow(workflowWithControlNet, {}, 42, undefined, [
        "220",
        "221",
        "222",
      ]);
      expect(result["215"]!.inputs.model).toBeUndefined();
    });

    // The hand-kept JSON and the adapter's node ids have to agree for an omitted `audioStem` to leave
    // the guider fed by the H3 node itself.
    it("splices the H3 R2V audio guide out of the conditioning line", async () => {
      const workflow = await loadWorkflow(
        path.resolve(
          import.meta.dirname,
          "../../cli/templates/workspace/adapters/comfy/video_minimax_h3_r2v.json",
        ),
      );
      expect(workflow["164"]!.class_type).toBe("MiniMaxH3AddGuide");
      expect(workflow["164"]!.inputs).toEqual({
        positive: ["136", 0],
        latent: ["136", 1],
        audio_vae: ["120", 0],
        audio: ["163", 0],
        frame_idx: 0,
      });
      expect(workflow["163"]!.class_type).toBe("LoadAudio");
      expect(workflow["166"]!.inputs).toEqual({
        positive: ["164", 0],
        latent: ["136", 1],
        vae: ["119", 0],
        image: ["165", 0],
        frame_idx: 0,
      });
      expect(workflow["168"]!.inputs).toEqual({
        positive: ["166", 0],
        latent: ["136", 1],
        vae: ["119", 0],
        image: ["167", 0],
        frame_idx: -1,
      });
      expect(workflow["126"]!.inputs.conditioning).toEqual(["168", 0]);

      const none = parameterizeWorkflow(
        workflow,
        {},
        42,
        undefined,
        ["163", "164", "165", "166", "167", "168"],
        { "164": "positive", "166": "positive", "168": "positive" },
      );
      for (const id of ["163", "164", "165", "166", "167", "168"]) {
        expect(none[id]).toBeUndefined();
      }
      expect(none["126"]!.inputs.conditioning).toEqual(["136", 0]);
      expect(none["125"]!.inputs.latent_image).toEqual(["136", 1]);

      // Only the guides that were omitted go; the chain closes over the gap.
      const startOnly = parameterizeWorkflow(
        workflow,
        {},
        42,
        undefined,
        ["163", "164", "167", "168"],
        { "164": "positive", "168": "positive" },
      );
      expect(startOnly["126"]!.inputs.conditioning).toEqual(["166", 0]);
      expect(startOnly["166"]!.inputs.positive).toEqual(["136", 0]);
    });
  });
});

describe("computeWorkflowHash", () => {
  it("returns consistent hash for the same workflow", () => {
    const hash1 = computeWorkflowHash(sampleWorkflow);
    const hash2 = computeWorkflowHash(sampleWorkflow);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hash for different workflows", () => {
    const modified = structuredClone(sampleWorkflow);
    modified["3"]!.inputs.seed = 999;
    expect(computeWorkflowHash(sampleWorkflow)).not.toBe(computeWorkflowHash(modified));
  });
});

describe("computeInputHash", () => {
  it("returns consistent hash for the same inputs", () => {
    const inputs = { "3": { seed: 42 }, "6": { text: "hello" } };
    const hash1 = computeInputHash(inputs);
    const hash2 = computeInputHash(inputs);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });
});
