import { describe, expect, it } from "vitest";
import { recognizesSpeechIn } from "../sherpa-binary.js";

describe("recognizesSpeechIn", () => {
  it("recognizes SenseVoice's languages and Parakeet's", () => {
    for (const lang of [
      "ja",
      "en-US",
      "zh-Hans",
      "ko",
      "yue",
      "fr",
      "de-CH",
      "es",
      "pt-BR",
      "ru",
    ]) {
      expect(recognizesSpeechIn(lang), lang).toBe(true);
    }
  });

  it("recognizes neither's other languages", () => {
    for (const lang of ["hi", "ar", "th", "tr"]) {
      expect(recognizesSpeechIn(lang), lang).toBe(false);
    }
  });
});
