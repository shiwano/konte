import { z } from "zod";

export type ComfyUINodeInput = Record<string, unknown>;

export type ComfyUINode = {
  class_type: string;
  inputs: ComfyUINodeInput;
  _meta?: Record<string, unknown>;
};

export type ComfyUIWorkflow = Record<string, ComfyUINode>;

export type ComfyUIPromptRequest = {
  prompt: ComfyUIWorkflow;
  client_id?: string;
};

const ComfyUIErrorDetailSchema = z.object({
  type: z.string(),
  message: z.string(),
  details: z.string().default(""),
  extra_info: z.record(z.unknown()).default({}),
});

const ComfyUINodeErrorSchema = z.object({
  errors: z.array(ComfyUIErrorDetailSchema),
  class_type: z.string(),
});

export const ComfyUIPromptResponseSchema = z.object({
  prompt_id: z.string(),
  number: z.number(),
  node_errors: z.record(ComfyUINodeErrorSchema).default({}),
  error: ComfyUIErrorDetailSchema.optional(),
});
export type ComfyUIPromptResponse = z.infer<typeof ComfyUIPromptResponseSchema>;

// A /prompt validation failure arrives as HTTP 400 carrying only the error keys (no prompt_id),
// so the error surface is read with its own tolerant schema before the success shape is enforced.
export const ComfyUIPromptErrorBodySchema = z.object({
  node_errors: z.record(ComfyUINodeErrorSchema).optional().catch(undefined),
  error: ComfyUIErrorDetailSchema.optional().catch(undefined),
});
export type ComfyUIPromptErrorBody = z.infer<typeof ComfyUIPromptErrorBodySchema>;

const ComfyUIOutputFileSchema = z.object({
  filename: z.string(),
  subfolder: z.string(),
  type: z.string(),
});
export type ComfyUIOutputFile = z.infer<typeof ComfyUIOutputFileSchema>;

// A node's outputs are whatever it chose to emit; only the file-shaped entries konte downloads are
// kept. Filtering per entry (rather than validating the array as a whole) keeps a node that mixes
// files with something else — a custom node's text, tags, … — from dropping its real files.
const outputFileList = z
  .array(z.unknown())
  .optional()
  .catch(undefined)
  .transform((items) =>
    items
      ?.map((item) => ComfyUIOutputFileSchema.safeParse(item))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : [])),
  );

export const ComfyUIHistoryOutputSchema = z.object({
  images: outputFileList,
  gifs: outputFileList,
  audio: outputFileList,
});
export type ComfyUIHistoryOutput = z.infer<typeof ComfyUIHistoryOutputSchema>;

export const ComfyUIHistoryEntrySchema = z.object({
  outputs: z.record(ComfyUIHistoryOutputSchema).default({}),
  status: z.object({
    status_str: z.string(),
    completed: z.boolean(),
    messages: z.array(z.tuple([z.string(), z.record(z.unknown())])).default([]),
  }),
});
export type ComfyUIHistoryEntry = z.infer<typeof ComfyUIHistoryEntrySchema>;

export const ComfyUIHistoryResponseSchema = z.record(ComfyUIHistoryEntrySchema);

export const ComfyUIQueueInfoSchema = z.object({
  queue_running: z.array(z.unknown()),
  queue_pending: z.array(z.unknown()),
});
export type ComfyUIQueueInfo = z.infer<typeof ComfyUIQueueInfoSchema>;

export const ComfyUIUploadResultSchema = z.object({
  name: z.string(),
  subfolder: z.string().default(""),
  type: z.string().default("input"),
});
export type ComfyUIUploadResult = z.infer<typeof ComfyUIUploadResultSchema>;

export const ComfyUISystemStatsSchema = z.object({
  devices: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      vram_total: z.number(),
      vram_free: z.number(),
    }),
  ),
});
export type ComfyUISystemStats = z.infer<typeof ComfyUISystemStatsSchema>;

export type ComfyUIWsMessage =
  | { type: "status"; data: { sid?: string; status: { exec_info: { queue_remaining: number } } } }
  | { type: "execution_start"; data: { prompt_id: string } }
  | { type: "execution_cached"; data: { prompt_id: string; nodes: string[] } }
  | { type: "executing"; data: { prompt_id: string; node: string | null } }
  | { type: "progress"; data: { prompt_id: string; value: number; max: number } }
  | { type: "executed"; data: { prompt_id: string; node: string; output: ComfyUIHistoryOutput } }
  | {
      type: "execution_error";
      data: {
        prompt_id: string;
        node_id: string;
        exception_message: string;
        exception_type: string;
      };
    };

// An input spec is `[type, config?]`. `type` is a type-name string for a scalar
// input (e.g. "INT", "STRING") or the array of choices for a combo (enum) input.
const ComfyUIInputSpecSchema = z
  .tuple([z.union([z.string(), z.array(z.unknown())])])
  .rest(z.unknown());
export type ComfyUIInputSpec = z.infer<typeof ComfyUIInputSpecSchema>;

const ComfyUINodeDefinitionSchema = z.object({
  input: z
    .object({
      required: z.record(ComfyUIInputSpecSchema).optional(),
      optional: z.record(ComfyUIInputSpecSchema).optional(),
    })
    .catch({}),
  // Source module of the node. Core nodes report "nodes" / "comfy_extras.*" /
  // "comfy_api_nodes.*"; custom nodes report "custom_nodes.<pack>".
  python_module: z.string().optional(),
});
export type ComfyUINodeDefinition = z.infer<typeof ComfyUINodeDefinitionSchema>;

// /object_info spans every installed node, custom packs included, so one pack declaring a shape
// konte doesn't model must not sink the whole fetch: an unparseable node degrades to "no inputs"
// (it contributes no combo choices and no model-presence hit) instead of throwing.
export const ComfyUIObjectInfoSchema = z.record(ComfyUINodeDefinitionSchema.catch({ input: {} }));

export const ComfyUIModelFilesSchema = z.array(z.string());

// One entry per `folder_paths` root ComfyUI serves. `folders` is that root's registered
// directories as ABSOLUTE paths, in `folder_names_and_paths` order — an `extra_model_paths.yaml`
// install lists several, and ComfyUI-Manager writes to the first, so konte does too.
const ComfyUIModelFolderSchema = z.object({
  name: z.string(),
  folders: z.array(z.string()),
  extensions: z.array(z.string()).default([]),
});
export type ComfyUIModelFolder = z.infer<typeof ComfyUIModelFolderSchema>;

export const ComfyUIModelFoldersSchema = z.array(ComfyUIModelFolderSchema);

export type ProgressCallback = (progress: { value: number; max: number; node?: string }) => void;
