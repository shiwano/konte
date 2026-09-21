import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineFalAsset } from "../dsl/fal-asset.js";
import { inertInputs, requireOneOf } from "../dsl/validators/input-validators.js";
import { promptReferenceTags } from "../dsl/validators/prompt-tags.js";
import type { AdapterValidator } from "../dsl/validators/validator.js";

// A name the adapter does not declare is a load error, not a validator that fires on nothing.
const inputs = {
  prompt: { nodeId: "1", field: "prompt", type: "prompt" as const },
  image1: { nodeId: "2", field: "image", type: "image" as const },
  useLightning: { nodeId: "3", field: "value", type: "boolean" as const, default: false },
};

function define(validators: AdapterValidator | readonly AdapterValidator[]) {
  return defineComfyAsset({
    workflow: "w.json",
    description: "test",
    inputs,
    outputs: { image: { nodeId: "9", type: "image" as const } },
    validators,
  });
}

describe("assertValidatorInputs()", () => {
  it("accepts a validator naming only declared inputs", () => {
    expect(() => define(promptReferenceTags({ tags: { Picture: ["image1"] } }))).not.toThrow();
  });

  it("rejects a promptReferenceTags slot the adapter dropped", () => {
    expect(() => define(promptReferenceTags({ tags: { Picture: ["image1", "image2"] } }))).toThrow(
      /"image2"/,
    );
  });

  it("rejects an explicitly named prompt input that is gone", () => {
    expect(() =>
      define(promptReferenceTags({ prompt: "instruct", tags: { Picture: ["image1"] } })),
    ).toThrow(/"instruct"/);
  });

  it("rejects a stale inertInputs condition, not just its targets", () => {
    expect(() =>
      define(inertInputs({
        inputs: { prompt: "" },
        when: { useTurbo: true },
        reason: "r",
        fix: "f",
      })),
    ).toThrow(/"useTurbo"/);
    expect(() =>
      define(inertInputs({
        inputs: { prompt: "" },
        whenNot: { useTurbo: true },
        reason: "r",
        fix: "f",
      })),
    ).toThrow(/"useTurbo"/);
  });

  it("rejects a whenUnset companion that is gone", () => {
    expect(() =>
      define(inertInputs({
        inputs: { prompt: "" },
        whenUnset: { gone: "" },
        reason: "r",
        fix: "f",
      })),
    ).toThrow(/"gone"/);
  });

  it("rejects a requireOneOf candidate that is gone", () => {
    expect(() =>
      define(requireOneOf({ inputs: { prompt: "", character: "" }, reason: "r" })),
    ).toThrow(/"character"/);
  });

  it("checks every validator of an array", () => {
    expect(() =>
      define([
        promptReferenceTags({ tags: { Picture: ["image1"] } }),
        requireOneOf({ inputs: { gone: "" }, reason: "r" }),
      ]),
    ).toThrow(/"gone"/);
  });

  it("accepts a hand-written validator, which declares no names", () => {
    expect(() => define(() => undefined)).not.toThrow();
  });

  it("guards a fal adapter too, not only a comfy one", () => {
    expect(() =>
      defineFalAsset({
        endpointId: "x/y",
        description: "test",
        mediaType: "image",
        inputs: { prompt: { field: "prompt", type: "prompt" as const } },
        validators: requireOneOf({ inputs: { gone: "" }, reason: "r" }),
      }),
    ).toThrow(/"gone"/);
  });

  it("does not read an inherited property as a declared input", () => {
    const validator: AdapterValidator = () => undefined;
    validator.inputs = ["constructor"];
    expect(() => define(validator)).toThrow(/"constructor"/);
  });
});
