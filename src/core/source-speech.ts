// What a source's lines take to say as the original writes them, by the rate `estimateSpeechSec`
// reads a spoken take at.

import { estimateSpeechSec } from "./speech-duration.js";

const CLOSE_OF: Record<string, string> = { "「": "」", "“": "”", '"': '"' };

/**
 * The quotations of one paragraph, marks included. One left open runs to the paragraph's end — a
 * speech over several paragraphs opens each and closes only the last.
 */
export function quotedSpans(paragraph: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < paragraph.length) {
    const close = CLOSE_OF[paragraph[i]!];
    if (close === undefined) {
      i++;
      continue;
    }
    const end = paragraph.indexOf(close, i + 1);
    const stop = end === -1 ? paragraph.length : end + 1;
    out.push(paragraph.slice(i, stop));
    i = stop;
  }
  return out;
}

const SCRIPT_LANGS: [RegExp, string][] = [
  [/\p{Script=Hangul}/u, "ko"],
  [/\p{Script=Arabic}/u, "ar"],
  [/\p{Script=Cyrillic}/u, "ru"],
  [/\p{Script=Hebrew}/u, "he"],
  [/\p{Script=Devanagari}/u, "hi"],
  [/\p{Script=Thai}/u, "th"],
  [/\p{Script=Han}/u, "zh"],
  [/\p{Script=Latin}/u, "en"],
];

/** The language a source's words are rated in: its most frequent script's, Japanese where kana show. */
export function speechLangOf(text: string): string {
  const counts = new Map<string, number>();
  let kana = 0;
  for (const ch of text) {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) {
      kana++;
      continue;
    }
    const lang = SCRIPT_LANGS.find(([re]) => re.test(ch))?.[1];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best = "en";
  let most = 0;
  for (const [lang, n] of counts) {
    if (n > most) [best, most] = [lang, n];
  }
  return kana > 0 && (best === "zh" || kana >= most) ? "ja" : best;
}

export function spokenSecOf(lines: readonly string[], lang: string): number {
  let sec = 0;
  for (const line of lines) sec += estimateSpeechSec(line, lang) ?? 0;
  return Math.round(sec * 10) / 10;
}
