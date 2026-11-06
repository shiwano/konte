import { z } from "zod";

// One file of a source's original as `index.json` fingerprints it.
const SourceFileFingerprintSchema = z.object({
  path: z.string(),
  size: z.number().int(),
  mtimeMs: z.number(),
  sha256: z.string(),
});

export type SourceFileFingerprint = z.infer<typeof SourceFileFingerprintSchema>;

// What `konte source import` read off a source's original, kept as `source/chunks/index.json`:
// the original's fingerprint and its structure. The locator check reads this file alone.
export const SourceIndexSchema = z.object({
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

export type SourceIndex = z.infer<typeof SourceIndexSchema>;
