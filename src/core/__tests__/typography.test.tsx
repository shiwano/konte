import { describe, expect, it } from "vitest";
import { Composition } from "../dsl/composition/index.js";
import { KonteError } from "../errors.js";
import { renderToHtml } from "../jsx-html.js";
import {
  LANGUAGES,
  assertFontFamilies,
  assertLanguageTag,
  fontFamilyStack,
  googleFontsHref,
} from "../typography.js";
import type { Typography } from "../types/index.js";

function head(typography: Typography): string {
  return renderToHtml(<Composition />, {
    shotId: "01",
    width: 1920,
    height: 1080,
    duration: 5,
    typography,
  });
}

describe("googleFontsHref", () => {
  it("requests every declared family in one stylesheet, spaces as +", () => {
    const href = googleFontsHref(["Inter", "Noto Sans JP"])!;

    expect(href.startsWith("https://fonts.googleapis.com/css2?")).toBe(true);
    expect(href).toContain("family=Inter:");
    expect(href).toContain("family=Noto+Sans+JP:");
    expect(href).toContain("&display=block");
  });

  it("requests the full weight axis, so a bold class lands on a real face", () => {
    const href = googleFontsHref(["Inter"])!;

    expect(href).toContain("ital,wght@0,100;");
    expect(href).toContain("0,700;");
    expect(href).toContain("1,700");
  });

  it("is null when the piece declares no fonts", () => {
    expect(googleFontsHref(undefined)).toBeNull();
    expect(googleFontsHref([])).toBeNull();
  });
});

describe("fontFamilyStack", () => {
  it("quotes each family in declaration order and closes with a generic", () => {
    expect(fontFamilyStack(["Inter", "Noto Sans JP"])).toBe('"Inter", "Noto Sans JP", sans-serif');
  });

  it("is null when the piece declares no fonts", () => {
    expect(fontFamilyStack(undefined)).toBeNull();
    expect(fontFamilyStack([])).toBeNull();
  });
});

describe("assertFontFamilies", () => {
  it("accepts plain family names", () => {
    expect(() => assertFontFamilies(["Inter", "Noto Sans JP", "M PLUS 1p"])).not.toThrow();
  });

  it.each([
    ["Inter, sans-serif"],
    ['"Inter"'],
    ["Inter\\"],
    ["Inter;"],
    ["Inter\n"],
    ["</style><img src=x>"],
    [" Inter"],
    [""],
  ])("rejects %j", (family) => {
    expect(() => assertFontFamilies([family])).toThrow(KonteError);
  });
});

describe("assertLanguageTag", () => {
  it("accepts every declared language", () => {
    for (const tag of LANGUAGES) {
      expect(() => assertLanguageTag(tag)).not.toThrow();
    }
  });

  it.each([["en-US"], ["pt-BR"], ["ja-JP"], ["zh-CN"], ["zh-TW"], ["zh-Hans-CN"]])(
    "accepts the region-qualified %j",
    (tag) => {
      expect(() => assertLanguageTag(tag)).not.toThrow();
    },
  );

  it.each([[""], ["Japanese"], ["ja_JP"], ["en-"], ["en-U"], ["xx"], ["xx-US"]])(
    "rejects %j",
    (tag) => {
      expect(() => assertLanguageTag(tag)).toThrow(KonteError);
    },
  );
});

describe("Composition head", () => {
  it("stamps the direction's language on the document root", () => {
    expect(head({ lang: "ja" })).toContain('<html lang="ja">');
  });

  it("links the declared fonts and lays them on the body", () => {
    const html = head({ lang: "ja", fonts: ["Inter", "Noto Sans JP"] });

    expect(html).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?');
    expect(html).toContain('font-family: "Inter", "Noto Sans JP", sans-serif;');
  });

  it("emits neither when the piece declares no fonts", () => {
    const html = head({ lang: "en" });

    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("font-family");
  });
});
