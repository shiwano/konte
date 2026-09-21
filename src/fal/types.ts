import { z } from "zod";

const FalQueueStatusSchema = z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]);
export type FalQueueStatus = z.infer<typeof FalQueueStatusSchema>;

export const FalSubmitResponseSchema = z.object({
  request_id: z.string(),
});
export type FalSubmitResponse = z.infer<typeof FalSubmitResponseSchema>;

export const FalStatusResponseSchema = z.object({
  status: FalQueueStatusSchema,
  queue_position: z.number().optional(),
  logs: z.array(z.object({ message: z.string(), timestamp: z.string() })).optional(),
  error: z.string().optional(),
});
export type FalStatusResponse = z.infer<typeof FalStatusResponseSchema>;

// The result body is the model's own free-form output; only the media descriptors konte reads
// out of it are validated (see FalOutputMediaSchema).
export const FalResultResponseSchema = z.record(z.unknown());

export const FalOutputMediaSchema = z.object({
  url: z.string(),
  content_type: z.string().nullish(),
  file_name: z.string().nullish(),
});
export type FalOutputMedia = z.infer<typeof FalOutputMediaSchema>;

export const FalUploadTokenResponseSchema = z.object({
  base_url: z.string(),
  token: z.string(),
});

export const FalUploadResponseSchema = z.object({
  access_url: z.string(),
});

export type ProgressCallback = (progress: { value: number; max: number }) => void;
