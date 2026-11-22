// Which hearing each language is heard with.

import { englishHearing } from "./en.js";
import { loadJapaneseHearing } from "./ja.js";
import {
  type HearingProfile,
  letterUnits,
  MARKED_UNITS,
  primaryLang,
  writtenLetters,
} from "./units.js";

// Any language without one of its own: its letters.
const letterHearing: HearingProfile = {
  alignments: [{ by: "letters", units: (text) => letterUnits(writtenLetters(text)) }],
  letters: writtenLetters,
  standIn: () => 1,
  misheard: () => false,
  marked: (gap) => gap.size >= MARKED_UNITS,
};

const LANGUAGES: Record<string, () => Promise<HearingProfile>> = {
  ja: loadJapaneseHearing,
  en: async () => englishHearing,
};

/** How speech in `lang` (a BCP 47 tag) is heard, with whatever the language reads it by loaded. */
export async function loadHearing(lang: string): Promise<HearingProfile> {
  return (await LANGUAGES[primaryLang(lang)]?.()) ?? letterHearing;
}

export type { HearingProfile } from "./units.js";
