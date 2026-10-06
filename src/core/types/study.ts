import { z } from "zod";

// What `konte study clip` read off one file, kept as `study.json` in the file's study directory
// (`<workspace>/.konte/studies/clip-<sha256>/`). `version` is the reading's own; a study written by
// another version is read again.
export const ClipStudySchema = z.object({
  version: z.number().int(),
  durationSec: z.number(),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number(),
  // Every shot between two cuts, in order, on the file's clock.
  shots: z.array(z.object({ startSec: z.number(), endSec: z.number() })),
  // The tempo its music plays at; null where no music is heard.
  tempo: z
    .union([z.object({ bpm: z.number() }), z.object({ minBpm: z.number(), maxBpm: z.number() })])
    .nullable(),
  // The language the most of its voice is heard in; null where no voice is heard. The words are
  // `heard.txt`.
  heardLang: z.string().nullable(),
  // One sheet per page, in order: its file in the study directory, the span its cells cover, and
  // how many shots it shows.
  sheets: z.array(
    z.object({
      file: z.string(),
      fromSec: z.number(),
      toSec: z.number(),
      shots: z.number().int(),
    }),
  ),
});

export type ClipStudy = z.infer<typeof ClipStudySchema>;
