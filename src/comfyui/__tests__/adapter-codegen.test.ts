import { describe, expect, it } from "vitest";
import { generateAdapterCode } from "../adapter-codegen.js";
import { analyzeWorkflow, attachTemplateModels } from "../workflow-analyze.js";

describe("generateAdapterCode() `also` targets", () => {
  it("renders the `also` array alongside the primary target", () => {
    const code = generateAdapterCode("foo", "foo.json", {
      inputs: {
        seed: {
          nodeId: "3",
          field: "seed",
          type: "seed",
          default: 31,
          also: [{ nodeId: "4", field: "seed" }],
        },
      },
      outputs: { audio: { nodeId: "9", type: "audio" } },
      models: [],
    });

    expect(code).toContain(
      'seed: { nodeId: "3", field: "seed", type: "seed", default: 31, also: [{ nodeId: "4", field: "seed" }] },',
    );
  });
});

describe("generateAdapterCode() guide wiring", () => {
  const analysis = {
    inputs: { seed: { nodeId: "3", field: "seed", type: "seed" as const, default: 1 } },
    outputs: { image: { nodeId: "9", type: "image" as const } },
    models: [],
  };

  it("emits the specifier the caller gives it, verbatim", () => {
    const sibling = generateAdapterCode("foo", "foo.json", analysis, {}, [], "./foo.md");
    expect(sibling).toContain('guide: "./foo.md",');

    const bundled = generateAdapterCode("foo", "foo.json", analysis, {}, [], "konte/guides/foo.md");
    expect(bundled).toContain('guide: "konte/guides/foo.md",');
    expect(bundled).not.toContain('"./konte/guides/foo.md"');
  });

  it("omits the `guide` field when no specifier is given", () => {
    const code = generateAdapterCode("foo", "foo.json", analysis);
    expect(code).not.toMatch(/^\s*guide: "/m);
  });
});

// Everything an adapter carries beyond its schema is a hand edit, dropped by a re-emit.
describe("generateAdapterCode() hand-edit markers", () => {
  const analysis = {
    inputs: { seed: { nodeId: "3", field: "seed", type: "seed" as const, default: 1 } },
    outputs: { image: { nodeId: "9", type: "image" as const } },
    models: [],
  };

  it("marks a missing guide, validators, prompt typing and exemptions", () => {
    const code = generateAdapterCode("foo", "foo.json", analysis);
    expect(code).toContain("TODO: wire the craft guide");
    expect(code).toContain("TODO: a constraint across inputs");
    expect(code).toContain("TODO: type the model's natural-language conditioning input");
    expect(code).toContain("Negations this model is MEANT to be written with");
  });

  it("marks nothing it was given", () => {
    const code = generateAdapterCode(
      "foo",
      "foo.json",
      analysis,
      {},
      [],
      "./foo.md",
      { imports: ["promptReferenceTags"], source: "promptReferenceTags({ tags: {} })" },
      { inputs: ["seed"], exemptions: "[/x/i]" },
    );
    expect(code).not.toContain("TODO: wire the craft guide");
    expect(code).not.toContain("TODO: a constraint across inputs");
    expect(code).not.toContain("TODO: type the model's");
  });

  it("leaves the emitted adapter parseable with every marker in place", () => {
    const code = generateAdapterCode("foo", "foo.json", analysis);
    // The markers sit inside the config object literal; a misplaced one breaks the whole file.
    expect(
      () => new Function(code.replace(/^import .*$/gm, "").replace(/^export /gm, "")),
    ).not.toThrow();
  });
});

describe("generateAdapterCode() combo values", () => {
  it("renders a `values` literal-union array for a combo input", () => {
    const code = generateAdapterCode("foo", "foo.json", {
      inputs: {
        category: {
          nodeId: "69",
          field: "choice",
          type: "string",
          default: "Music",
          values: ["Music", "SFX", "Speech"],
        },
      },
      outputs: { audio: { nodeId: "9", type: "audio" } },
      models: [],
    });

    expect(code).toContain(
      'category: { nodeId: "69", field: "choice", type: "string", default: "Music", values: ["Music", "SFX", "Speech"] },',
    );
  });
});

describe("generateAdapterCode() hidden inputs", () => {
  it("renders hidden inputs as commented-out entries the curator can opt in", () => {
    const code = generateAdapterCode(
      "foo",
      "foo.json",
      {
        inputs: { positivePrompt: { nodeId: "3", field: "text", type: "string" } },
        outputs: { video: { nodeId: "9", type: "video" } },
        models: [],
      },
      {
        prompt: {
          nodeId: "361",
          field: "text",
          type: "string",
          default: "pc game, console game",
          comment: "CLIPTextEncode → LTXVConditioning.negative",
        },
      },
    );

    expect(code).toContain("// --- Hidden subgraph-internal inputs");
    expect(code).toContain("// CLIPTextEncode → LTXVConditioning.negative");
    expect(code).toContain('// prompt: { nodeId: "361", field: "text", type: "string"');
    // The active input is still emitted uncommented.
    expect(code).toContain('positivePrompt: { nodeId: "3"');
  });

  it("omits the hidden block when there are no hidden inputs", () => {
    const code = generateAdapterCode("foo", "foo.json", {
      inputs: {},
      outputs: { image: { nodeId: "9", type: "image" } },
      models: [],
    });
    expect(code).not.toContain("Hidden subgraph-internal inputs");
  });
});

describe("generateAdapterCode() model scaffold", () => {
  it("emits a commented-out models block when models are detected", () => {
    const code = generateAdapterCode("foo", "foo.json", {
      inputs: {},
      outputs: { image: { nodeId: "9", type: "image" } },
      models: [
        { filename: "ck.safetensors", type: "checkpoint", nodeId: "1", field: "ckpt_name" },
        { filename: "v.safetensors", type: "VAE", nodeId: "3", field: "vae_name" },
      ],
    });

    expect(code).toContain("// models:");
    expect(code).toContain("// models: [");
    expect(code).toContain("// ],");
    expect(code).toContain('"ck.safetensors"');
    expect(code).toContain('"checkpoint"');
    expect(code).toContain('"v.safetensors"');
    expect(code).toContain('"VAE"');
    // A gated HuggingFace URL stays plain, so the scaffold must not put HF_TOKEN in one.
    expect(code).toContain("HF_TOKEN");
    expect(code).not.toContain("${HF_TOKEN}");
    expect(code).toContain("${CIVITAI_TOKEN}");
  });

  it("fills the download and folder a template records for a model", () => {
    const models = [
      { filename: "yue2.safetensors", type: "checkpoint", nodeId: "41", field: "ckpt_name" },
      { filename: "te.safetensors", type: "checkpoint", nodeId: "42", field: "clip_name" },
      {
        filename: "ss2.safetensors",
        type: "checkpoint",
        nodeId: "56",
        field: "audio_encoder_name",
      },
      { filename: "other.safetensors", type: "VAE", nodeId: "57", field: "vae_name" },
    ];
    attachTemplateModels(
      models,
      new Map([
        ["yue2.safetensors", { url: "https://h.example/yue2", directory: "checkpoints" }],
        ["te.safetensors", { url: "https://h.example/te", directory: "text_encoders" }],
        ["ss2.safetensors", { url: "https://h.example/ss2", directory: "audio_encoders" }],
      ]),
    );
    const code = generateAdapterCode("foo", "foo.json", {
      inputs: {},
      outputs: { audio: { nodeId: "10", type: "audio" } },
      models,
    });

    expect(code).toContain(
      '//   { filename: "yue2.safetensors", type: "checkpoint", url: "https://h.example/yue2" },',
    );
    expect(code).toContain(
      '//   { filename: "te.safetensors", type: "clip", url: "https://h.example/te" },',
    );
    expect(code).toContain(
      '//   { filename: "ss2.safetensors", type: "checkpoint", savePath: "audio_encoders", url: "https://h.example/ss2" },',
    );
    expect(code).toContain('//   { filename: "other.safetensors", type: "VAE", url: "" },');
  });

  it("does not emit a models block when no models are detected", () => {
    const code = generateAdapterCode("bar", "bar.json", {
      inputs: {},
      outputs: { image: { nodeId: "9", type: "image" } },
      models: [],
    });
    expect(code).not.toContain("models:");
  });
});

describe("generateAdapterCode() node scaffold", () => {
  it("emits a commented-out nodes block listing resolved cnr_ids", () => {
    const code = generateAdapterCode(
      "foo",
      "foo.json",
      { inputs: {}, outputs: { image: { nodeId: "9", type: "image" } }, models: [] },
      {},
      ["comfy-foo", "comfy-bar"],
    );
    expect(code).toContain("// nodes: [");
    expect(code).toContain('//   { id: "comfy-foo" },');
    expect(code).toContain('//   { id: "comfy-bar" },');
    expect(code).toContain("// ],");
  });

  it("does not emit a nodes block when no packs are passed", () => {
    const code = generateAdapterCode(
      "bar",
      "bar.json",
      { inputs: {}, outputs: { image: { nodeId: "9", type: "image" } }, models: [] },
      {},
      [],
    );
    expect(code).not.toContain("nodes:");
  });
});

describe("generateAdapterCode() injection safety", () => {
  it("collapses newlines in a malicious _meta.title so it can't break out of the // comment", () => {
    const data = {
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: "hi", clip: ["1", 0] },
        _meta: { title: "evil\nexport const pwned = 1; //" },
      },
      "9": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "out" } },
    };
    const code = generateAdapterCode("foo", "foo.json", analyzeWorkflow(data));
    // The payload may appear only inside a comment/string — never as its own statement line.
    const escaped = code.split("\n").some((l) => l.trimStart().startsWith("export const pwned"));
    expect(escaped).toBe(false);
  });

  it("escapes quotes in keys, node ids, fields, and types instead of breaking out", () => {
    const code = generateAdapterCode("foo", "foo.json", {
      inputs: { bad: { nodeId: '1", evil: "x', field: 'f"f', type: "string" } },
      outputs: { good: { nodeId: '2"', type: "image" } },
      models: [],
    });
    expect(code).toContain(JSON.stringify('1", evil: "x'));
    expect(code).toContain(JSON.stringify('f"f'));
    expect(code).not.toMatch(/nodeId: "1", evil: "x"/);
  });
});

describe("generateAdapterCode() field naming", () => {
  it("emits lowerCamelCase input keys while preserving the original field", () => {
    const code = generateAdapterCode("foo", "foo.json", {
      inputs: {
        positive_prompt: { nodeId: "3", field: "text", type: "string" },
        use_lightning: { nodeId: "5", field: "value", type: "boolean", default: false },
        unet_name_0: { nodeId: "7", field: "unet_name", type: "string" },
      },
      outputs: { output_0: { nodeId: "9", type: "image" } },
      models: [],
    });

    expect(code).toContain("positivePrompt:");
    expect(code).not.toContain("positive_prompt:");
    expect(code).toContain("useLightning:");
    expect(code).toContain("unetName0:");
    expect(code).toContain("output0:");
    // The `field` property maps to the real ComfyUI node field and must stay snake_case.
    expect(code).toContain('field: "text"');
    expect(code).toContain('field: "unet_name"');
  });
});
