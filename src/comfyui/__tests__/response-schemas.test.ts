import { describe, expect, it } from "vitest";
import {
  ComfyUIHistoryEntrySchema,
  ComfyUIObjectInfoSchema,
  ComfyUIHistoryOutputSchema,
} from "../types.js";

describe("ComfyUIHistoryOutputSchema", () => {
  it("keeps the file-shaped entries of a node that also emits something else", () => {
    const parsed = ComfyUIHistoryOutputSchema.parse({
      images: [{ filename: "a.png", subfolder: "", type: "output" }, "not-a-file"],
      text: ["a caption"],
    });
    expect(parsed.images).toEqual([{ filename: "a.png", subfolder: "", type: "output" }]);
  });

  it("drops a file key that is not an array", () => {
    expect(ComfyUIHistoryOutputSchema.parse({ gifs: "nope" }).gifs).toBeUndefined();
  });
});

describe("ComfyUIHistoryEntrySchema", () => {
  it("parses an entry whose extra fields konte does not read", () => {
    const parsed = ComfyUIHistoryEntrySchema.parse({
      prompt: [1, "p-1", {}, {}, []],
      outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } },
      status: { status_str: "success", completed: true, messages: [] },
    });
    expect(parsed.status.completed).toBe(true);
    expect(parsed.outputs["9"]!.images).toHaveLength(1);
  });
});

describe("ComfyUIObjectInfoSchema", () => {
  it("degrades a node whose shape konte does not model instead of failing the fetch", () => {
    const parsed = ComfyUIObjectInfoSchema.parse({
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [["model.safetensors"]] } },
        python_module: "nodes",
      },
      WeirdCustomNode: { input: { required: { field: { v3: "object-shaped" } } } },
    });
    expect(parsed.CheckpointLoaderSimple!.input.required?.ckpt_name![0]).toEqual([
      "model.safetensors",
    ]);
    expect(parsed.WeirdCustomNode!.input).toEqual({});
  });
});
