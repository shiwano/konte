import { describe, expect, it } from "vitest";
import { asset } from "../dsl/adapter.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { upscale } from "../dsl/delivery-upscale.js";
import { defineFalAsset } from "../dsl/fal-asset.js";
import { formatCutTime } from "../dsl/prompt-structure.js";
import { defineReference } from "../dsl/reference-builders.js";
import { KonteError } from "../errors.js";
import type { ComfyAssetDefinition, FalAssetDefinition } from "../types/index.js";
import { plainDirection } from "./helpers/direction.js";

const structured = defineComfyAsset({
  workflow: "structured.json",
  description: "a model that reads named sections",
  inputs: {
    prompt: {
      nodeId: "3",
      field: "text",
      type: "prompt",
      default: "",
      structure: {
        join: "\n\n",
        fields: {
          subjects: {
            required: true,
            description: "one line per label",
            render: (lines: string[]) => `subjects: ${lines.join("\n")}`,
          },
          summary: {
            required: true,
            render: (s: { tasks: ["a" | "b", ...("a" | "b")[]]; text: string }) =>
              `summary: [${s.tasks.join(" + ")}] ${s.text}`,
          },
          note: { render: (text: string) => `note: ${text}` },
          silence: { render: () => "silence: N/A" },
        },
      },
    },
  },
  outputs: { image: { nodeId: "9", type: "image" } },
});

function build(prompt: unknown): ComfyAssetDefinition {
  const reference = defineReference(plainDirection, () => ({
    still: asset("still", structured, prompt as Parameters<typeof asset>[2]),
  }));
  return reference.topLevelAssets!.still as ComfyAssetDefinition;
}

function buildError(prompt: unknown): KonteError {
  try {
    build(prompt);
  } catch (error) {
    return error as KonteError;
  }
  throw new Error("expected the build to throw");
}

describe("a structured prompt", () => {
  it("assembles the fields in declaration order, skipping an omitted optional one", () => {
    const def = build({
      prompt: { summary: { tasks: ["a", "b"], text: "She walks." }, subjects: ["<Subject 1>"] },
    });
    expect(def.inputs["3.text"]).toBe(
      "subjects: <Subject 1>\n\nsummary: [a + b] She walks.\n\nsilence: N/A",
    );
  });

  it("writes an optional field that is given", () => {
    const def = build({
      prompt: { subjects: [], summary: { tasks: ["a"], text: "x" }, note: "quiet" },
    });
    expect(def.inputs["3.text"]).toBe(
      "subjects: \n\nsummary: [a] x\n\nnote: quiet\n\nsilence: N/A",
    );
  });

  it("hands the prompt check the assembled string", () => {
    const reference = defineReference(plainDirection, () => ({
      still: asset("still", structured, {
        prompt: { subjects: ["<Subject 1>"], summary: { tasks: ["a"], text: "x" } },
      }),
    }));
    expect(reference.prompts?.map((o) => o.value)).toEqual([
      "subjects: <Subject 1>\n\nsummary: [a] x\n\nsilence: N/A",
    ]);
  });

  it("leaves an omitted prompt to its default", () => {
    expect(build({}).inputs["3.text"]).toBe("");
  });

  it("refuses a missing required field, saying where the asset sits", () => {
    const error = buildError({ prompt: { subjects: [] } });
    expect(error.code).toBe("MISSING_REQUIRED_INPUT");
    expect(error.message).toContain('Asset "still" in the reference stage');
    expect(error.message).toContain('Required field "summary" of input "prompt"');
  });

  it("refuses a field it does not declare, a constant one included", () => {
    const error = buildError({
      prompt: { subjects: [], summary: { tasks: ["a"], text: "x" }, silence: "loud" },
    });
    expect(error.code).toBe("INVALID_ADAPTER_INPUT");
    expect(error.message).toContain('has no field "silence"');
    expect(error.message).toContain("subjects, summary, note");
  });

  it("refuses a string", () => {
    const error = buildError({ prompt: "subjects: x" });
    expect(error.code).toBe("INVALID_ADAPTER_INPUT");
    expect(error.message).toContain('Input "prompt" takes its fields as an object');
  });

  it("names the field whose render threw", () => {
    const error = buildError({ prompt: { subjects: "not a list", summary: { tasks: ["a"] } } });
    expect(error.code).toBe("INVALID_ADAPTER_INPUT");
    expect(error.message).toContain('Field "subjects" of input "prompt" could not be rendered');
  });

  it("is assembled for a delivery upscale too", () => {
    const upscaler = defineFalAsset({
      endpointId: "fal-ai/structured-upscale",
      description: "an upscaler with a structured prompt",
      mediaType: "video",
      inputs: {
        prompt: {
          field: "prompt",
          type: "prompt",
          structure: {
            join: " | ",
            fields: {
              look: { required: true, render: (look: string) => `look=${look}` },
              grain: { render: () => "grain=none" },
            },
          },
        },
      },
    });
    const def = upscale(upscaler, { prompt: { look: "crisp" } }) as FalAssetDefinition;
    expect(def.inputs.prompt).toBe("look=crisp | grain=none");
  });

  it("lists the fields a caller passes on the meta, constants left out", () => {
    expect(structured.meta.inputs.prompt!.structure!.fields).toEqual({
      subjects: { required: true, description: "one line per label" },
      summary: { required: true },
      note: { required: false },
    });
  });

  it("is typed by the fields' render parameters", () => {
    const check = (_: Parameters<typeof asset<"x", typeof structured>>[2]) => undefined;
    check({ prompt: { subjects: [], summary: { tasks: ["a"], text: "x" } } });
    // @ts-expect-error a required field is missing
    check({ prompt: { subjects: [] } });
    // @ts-expect-error a task the render does not take
    check({ prompt: { subjects: [], summary: { tasks: ["c"], text: "x" } } });
    // @ts-expect-error a constant field is not passed
    check({ prompt: { subjects: [], summary: { tasks: ["a"], text: "x" }, silence: "x" } });
    // @ts-expect-error a structured prompt takes no string
    check({ prompt: "subjects: x" });
  });

  it("is refused on an input that is not a prompt", () => {
    expect(() =>
      defineComfyAsset({
        workflow: "bad.json",
        description: "a structure on a plain string",
        inputs: {
          // @ts-expect-error only a "prompt" input takes a structure
          text: {
            nodeId: "3",
            field: "text",
            type: "string",
            structure: { join: "\n", fields: { a: { render: () => "a" } } },
          },
        },
        outputs: { image: { nodeId: "9", type: "image" } },
      }),
    ).toThrow('Input "text" is typed "string", so it takes no structure');
  });
});

describe("formatCutTime()", () => {
  it("writes mm:ss.mmm", () => {
    expect(formatCutTime(0)).toBe("00:00.000");
    expect(formatCutTime(3.5)).toBe("00:03.500");
    expect(formatCutTime(75.25)).toBe("01:15.250");
  });

  it("rounds to the millisecond before carrying", () => {
    expect(formatCutTime(59.9996)).toBe("01:00.000");
    expect(formatCutTime(0.0004)).toBe("00:00.000");
  });

  it("refuses a time that is not a non-negative number of seconds", () => {
    for (const at of [-0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatCutTime(at)).toThrow(RangeError);
    }
  });
});
