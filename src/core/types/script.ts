import { z } from "zod";

// One spoken/narrated line of a shot's script — the literal words, tagged by who says them. The
// three variants are discriminated by which key is present (no explicit `kind`, so it reads cleanly
// inside a direction literal):
//   - { character, text }: a character speaks; `character` is a declared `characters` id (and so
//     maps to reference:<id>). Validated against the roster in validateDirectionStructure.
//   - { speaker, text }: a non-character/mob speaker named by a free label ("群衆", "受付").
//   - { narration }: narration / voiceover, no speaker.
// Shared by the direction (a shot's `script`, the source of truth) and an animatic panel's
// `script` (the subset placed on that frame).
//
// `acting` is the line's direction — how it is said, in one line of the project's working language.
// It rides on the line rather than the shot because two characters in one shot are two performances,
// and only on a character line: narration is one voice held level across the piece and a mob is a
// texture, so neither has a performance to direct. The other two branches spell the field out as
// `never` rather than omitting it — TypeScript admits a key any constituent of a union declares, so
// an omitted one would be accepted in silence.
export const ScriptLineSchema = z.union([
  z.object({ character: z.string(), text: z.string(), acting: z.string().optional() }),
  z.object({ speaker: z.string(), text: z.string(), acting: z.never().optional() }),
  z.object({ narration: z.string(), acting: z.never().optional() }),
]);

export type ScriptLine = z.infer<typeof ScriptLineSchema>;

// The words of a line, whichever variant carries them.
export const lineText = (line: ScriptLine): string =>
  "narration" in line ? line.narration : line.text;

// A script line flattened for display: the speaker's label (a resolved character name, a mob label,
// or null for narration), the words, and the line's acting note. `nameById` resolves character ids
// to names when the roster is at hand (the direction preview, `konte inspect` on a shot); an
// animatic panel has no roster to consult, so it falls back to the raw id.
export function scriptLinesToView(
  script: readonly ScriptLine[] | undefined,
  nameById?: ReadonlyMap<string, string>,
): { speaker: string | null; text: string; acting: string | null }[] {
  return (script ?? []).map((line) => {
    if ("character" in line) {
      return {
        speaker: nameById?.get(line.character) ?? line.character,
        text: line.text,
        acting: line.acting ?? null,
      };
    }
    if ("speaker" in line) return { speaker: line.speaker, text: line.text, acting: null };
    return { speaker: null, text: line.narration, acting: null };
  });
}
