import { z } from "zod";

export const HandoffNoteSchema = z.object({
  address: z.string(),
  text: z.string(),
});

export const HandoffSchema = z.object({
  stage: z.enum(["animatic", "video", "reference", "direction"]),
  summary: z.string().optional(),
  notes: z.array(HandoffNoteSchema).default([]),
});

export type HandoffNote = z.infer<typeof HandoffNoteSchema>;
export type Handoff = z.infer<typeof HandoffSchema>;
