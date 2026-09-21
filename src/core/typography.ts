import { KonteError } from "./errors.js";

// The weight axis every declared family is requested at — the same over-request HyperFrames' own
// compiler makes when it embeds @font-face rules at export time, so the preview browser and the
// exported frames resolve the same set of faces. Google returns only the weights a family ships.
const WEIGHT_AXIS = "ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700";

// A family name is written into a quoted CSS string inside a raw-text `<style>` and into a URL query
// value, and each of those has its own way of failing quietly: a comma splits the stack, a quote or a
// trailing backslash ends the entry early, `</style>` ends the whole element. Anything outside the
// allowlist is a typo that would otherwise show up as the wrong typeface.
export const FONT_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

/**
 * What `policy.lang` offers, and the base language every accepted tag resolves to — one entry per
 * language. A script or region is written as a subtag on one of these (`zh-Hant`, `en-US`), never
 * listed here.
 */
export const LANGUAGES = [
  "ja",
  "ko",
  "zh",
  "en",
  "fr",
  "de",
  "es",
  "pt",
  "it",
  "nl",
  "pl",
  "ru",
  "uk",
  "tr",
  "ar",
  "he",
  "hi",
  "th",
  "vi",
  "id",
] as const;

type Language = (typeof LANGUAGES)[number];

// The script each language is written in when the tag names none, as an ISO 15924 code. A tag may
// override it (`zh-Hant`). `zh` alone is Simplified, and only this table says so.
const DEFAULT_SCRIPT: Record<Language, string> = {
  ja: "Jpan",
  ko: "Kore",
  zh: "Hans",
  en: "Latn",
  fr: "Latn",
  de: "Latn",
  es: "Latn",
  pt: "Latn",
  it: "Latn",
  nl: "Latn",
  pl: "Latn",
  ru: "Cyrl",
  uk: "Cyrl",
  tr: "Latn",
  ar: "Arab",
  he: "Hebr",
  hi: "Deva",
  th: "Thai",
  vi: "Latn",
  id: "Latn",
};

/**
 * Each language's English name. A model that takes a language by name rather than by tag is told
 * which one in these words, so this is the one spelling konte accepts for it.
 */
export const LANGUAGE_NAMES: Record<Language, string> = {
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  ru: "Russian",
  uk: "Ukrainian",
  tr: "Turkish",
  ar: "Arabic",
  he: "Hebrew",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
};

// An ISO 15924 script subtag is the four-letter one; a region is two letters or three digits, so the
// length alone separates them.
const SCRIPT_SUBTAG_PATTERN = /^[A-Za-z]{4}$/;

// The script a tag is actually written in — the subtag when it names one, else the language's
// default. Title-cased so a caller compares against one spelling; BCP 47 case is not significant.
export function scriptOf(lang: LanguageTag): string {
  const [base, ...rest] = lang.split("-");
  const script = rest.find((s) => SCRIPT_SUBTAG_PATTERN.test(s));
  if (script) {
    return script[0]!.toUpperCase() + script.slice(1).toLowerCase();
  }
  return DEFAULT_SCRIPT[base as Language] ?? "Latn";
}

/**
 * What `policy.lang` accepts. Wider than `LANGUAGES` on one axis: subtags may ride along (`en-US`,
 * `pt-BR`, `zh-Hans-CN`) — an unknown one renders exactly as none at all. They are kept, not
 * stripped: for Chinese a region IS a script (`zh-CN` is Simplified), so dropping it loses the glyphs.
 */
export type LanguageTag = Language | `${Language}-${string}`;

const SUBTAG_PATTERN = /^[A-Za-z0-9]{2,8}$/;

export function isLanguageTag(lang: string): lang is LanguageTag {
  const known: readonly string[] = LANGUAGES;
  if (known.includes(lang)) return true;
  const [base, ...rest] = lang.split("-");
  if (base === undefined || rest.length === 0) return false;
  return known.includes(base) && rest.every((s) => SUBTAG_PATTERN.test(s));
}

export function assertLanguageTag(lang: string): asserts lang is LanguageTag {
  if (!isLanguageTag(lang)) {
    throw new KonteError(
      "DIRECTION_LANG_INVALID",
      `Invalid \`policy.lang\` ${JSON.stringify(lang)}. Declare one of: ${LANGUAGES.join(", ")} — a script or region may ride along ("en-US", "zh-Hant").`,
    );
  }
}

export function assertFontFamilies(fonts: readonly string[]): void {
  for (const family of fonts) {
    if (!FONT_FAMILY_PATTERN.test(family)) {
      throw new KonteError(
        "FONT_FAMILY_INVALID",
        `Invalid font family ${JSON.stringify(family)}. Declare one family per entry, by its plain Google Fonts name — letters, digits, spaces and hyphens only (e.g. "Noto Sans JP").`,
      );
    }
  }
}

// The stylesheet URL covering every declared family, or null when the piece declares none.
export function googleFontsHref(fonts: readonly string[] | undefined): string | null {
  if (!fonts || fonts.length === 0) return null;
  const families = fonts.map(
    (family) => `family=${encodeURIComponent(family).replace(/%20/g, "+")}:${WEIGHT_AXIS}`,
  );
  // `display=block` matches the `font-display: block` HyperFrames injects: a frame captured before
  // the face arrives holds blank space rather than baking the fallback typeface into the video.
  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=block`;
}

// The declared families as a CSS `font-family` value, in declaration order, closed with a generic so
// a codepoint no declared family covers still lands somewhere. Null when the piece declares none.
export function fontFamilyStack(fonts: readonly string[] | undefined): string | null {
  if (!fonts || fonts.length === 0) return null;
  return [...fonts.map((family) => `"${family}"`), "sans-serif"].join(", ");
}
