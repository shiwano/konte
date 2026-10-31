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
  // The page it was downloaded from, read off the `info.json` yt-dlp left in the study directory;
  // null where there is none. Its description is `description.txt`.
  page: z
    .object({
      title: z.string(),
      uploader: z.string().nullable(),
      chapters: z.array(z.object({ startSec: z.number(), title: z.string() })),
      described: z.boolean(),
    })
    .nullable(),
  // The words of its voice, written to `heard.txt`, and the language the most of them are in: off
  // its downloaded subtitles (`auto-subtitles` where the site made them), else heard off its
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

// The `info.json` yt-dlp writes for a downloaded clip, as far as a study reads it.
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

// `source.json` in the study directory of a downloaded clip: the URL it came from and its file there.
export const ClipSourceSchema = z.object({ link: z.string(), file: z.string() });

// One file of a source's original as `index.json` fingerprints it: its path under the source
// directory, size, mtime and sha256.
export const SourceFileFingerprintSchema = z.object({
  path: z.string(),
  size: z.number().int(),
  mtimeMs: z.number(),
  sha256: z.string(),
});

export type SourceFileFingerprint = z.infer<typeof SourceFileFingerprintSchema>;

// What `konte source import` read off a source's original, kept as `source/chunks/index.json`:
// the original's fingerprint and its structure. The locator check reads this file alone.
export const SourceStudyIndexSchema = z.object({
  version: z.number().int(),
  kind: z.enum(["text", "comic", "clip"]),
  // The original, relative to the source directory.
  file: z.string(),
  fingerprint: z.array(SourceFileFingerprintSchema),
  // One line of the original's size ("104,600 words · 12 stories · 31 chunks · dialogue 38%").
  summary: z.string(),
  // What the reading had to decide on its own ("no headings: split by length").
  notes: z.array(z.string()),
  // Name candidates, taken without morphological analysis.
  names: z.array(z.string()),
  // A comic's binding: which way its pages turn.
  binding: z.enum(["rtl", "ltr"]).optional(),
  // The top-level units a listing goes by (stories, chapters, bundles, windows), in order.
  units: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
  // Every chunk, in reading order: the unit it lists under, and the positions it holds, inclusive —
  // paragraphs numbered through the chapter (text), pages through the volume (comic), seconds
  // (clip). `size` is how much it holds, for a listing ("8,120 chars", "12 pages", "3:02").
  // `spokenSec`, a text's: what every quoted line in it takes to say.
  chunks: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      unit: z.string(),
      from: z.number(),
      to: z.number(),
      size: z.string(),
      spokenSec: z.number().optional(),
    }),
  ),
});

export type SourceStudyIndex = z.infer<typeof SourceStudyIndexSchema>;
