import { isLanguageTag, scriptOf } from "./typography.js";

/**
 * What a written line takes to say, from the words alone.
 *
 * A floor-and-slope fit: `BASE_SEC` is the lead-in and the settle a spoken
 * take carries at each end — a short line is nearly all of it — and the script's `secPerUnit` the
 * steady rate after that. Punctuation adds no term of its own — the pauses are already in the slope.
 *
 * Japanese and Latin are fitted on accepted takes. `BASE_SEC` is the model's fixed cost rather than
 * the language's, so every script keeps it. Korean, Chinese, Arabic and Cyrillic are measured against
 * those on MiniMax H3 — the same lines, cast and prompt in each language, at clips as roomy as the
 * fitted rows read at. A line written for a shot carries pauses the lab lines do not, and reads 10%
 * (Japanese) to 30% (English) slower for them, so a row with no accepted takes behind it takes the
 * wider margin. A row covering several languages takes the slowest one measured — Latin is
 * Portuguese's, twice French's. Hebrew, Devanagari and Thai are a normal narration pace in their own
 * unit, a guess.
 *
 * Where a rate is uncertain it is rounded SLOW. The consumer holds the count inside the shot, so an
 * over-estimate degrades toward the shot-sized count that was the default before — while an
 * under-estimate rushes the read or cuts it.
 *
 * The consumer also lands the count on a coarse grid, so what this has to get right is the rung,
 * not the seconds.
 */

export const BASE_SEC = 0.93;

// Seconds per unit, by ISO 15924. The unit differs with the script — a mora for kana, a syllable
// for han and hangul, a character for an alphabet — so these are not comparable across rows; each
// pairs with what `unitsOf` counts for that script.
const SEC_PER_UNIT: Record<string, number> = {
  Jpan: 0.098,
  Kore: 0.174,
  Hans: 0.19,
  Hant: 0.19,
  Hani: 0.19,
  Latn: 0.085,
  Cyrl: 0.07,
  Arab: 0.106,
  Hebr: 0.08,
  Deva: 0.12,
  Thai: 0.09,
};

// A kanji in Japanese prose averages close to two morae (音読み is two, 訓読み spreads either side),
// and there is no reading to consult here: 出 is one mora and 承る is four, and both are counted the
// same.
const KANJI_MORAE = 1.8;

// A small kana is the tail of the mora before it (きょ is one), never one of its own.
const SMALL_KANA = new Set([..."ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ"]);

function isHan(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

function isKana(code: number): boolean {
  return code >= 0x3041 && code <= 0x30ff;
}

function isHangul(code: number): boolean {
  return code >= 0xac00 && code <= 0xd7a3;
}

// What one character contributes, in the unit the script is rated in. A character the script has no
// reading for — a stray latin word in Japanese prose, a space — contributes a fraction or nothing.
function unitsOf(ch: string, script: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (SMALL_KANA.has(ch)) return 0;
  if (isKana(code) || ch === "ー") return 1;
  if (isHangul(code)) return 1;
  if (isHan(code)) return script === "Jpan" ? KANJI_MORAE : 1;
  if (/\d/.test(ch)) return script === "Jpan" || script === "Kore" ? 2 : 3;
  if (/\p{L}/u.test(ch)) return script === "Jpan" || script === "Kore" ? 0.5 : 1;
  return 0;
}

/**
 * The seconds the words are estimated to take, or `null` when there is no declared language to pick
 * a rate with — the caller then keeps whatever it would have done without an estimate.
 */
export function estimateSpeechSec(text: string, lang: string | undefined): number | null {
  if (lang === undefined || !isLanguageTag(lang)) return null;
  const script = scriptOf(lang);
  const secPerUnit = SEC_PER_UNIT[script];
  if (secPerUnit === undefined) return null;

  let units = 0;
  for (const ch of text) units += unitsOf(ch, script);
  if (units === 0) return null;
  return BASE_SEC + units * secPerUnit;
}
