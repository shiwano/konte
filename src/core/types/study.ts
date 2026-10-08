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
  // The page it was downloaded from, read off the `<stem>.info.json` yt-dlp left beside it; null
  // where there is none. Its description is `description.txt`.
  page: z
    .object({
      title: z.string(),
      uploader: z.string().nullable(),
      chapters: z.array(z.object({ startSec: z.number(), title: z.string() })),
      described: z.boolean(),
    })
    .nullable(),
  // The words of its voice, written to `heard.txt`, and the language the most of them are in: off
  // the subtitles beside it (`auto-subtitles` where the site made them), else heard off its
  // separated voice. Null where neither has words.
  heard: z
    .object({ lang: z.string(), from: z.enum(["subtitles", "auto-subtitles", "voice"]) })
    .nullable(),
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

// The `<stem>.info.json` yt-dlp writes beside a clip, as far as a study reads it.
export const ClipPageInfoSchema = z.object({
  title: z.string().optional(),
  uploader: z.string().nullish(),
  channel: z.string().nullish(),
  description: z.string().nullish(),
  language: z.string().nullish(),
  chapters: z.array(z.object({ start_time: z.number(), title: z.string() })).nullish(),
  subtitles: z.record(z.string(), z.unknown()).nullish(),
  automatic_captions: z.record(z.string(), z.unknown()).nullish(),
});

export type ClipPageInfo = z.infer<typeof ClipPageInfoSchema>;
