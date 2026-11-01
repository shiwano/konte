import { describe, expect, it } from "vitest";
import { KonteError } from "../../core/errors.js";
import { resolveUrlTokens } from "../token-resolver.js";

describe("resolveUrlTokens", () => {
  it("returns the URL unchanged when no placeholders are present", () => {
    const url = "https://example.com/model.safetensors";
    expect(resolveUrlTokens(url, { env: {} })).toBe(url);
  });

  it("resolves a placeholder from env", () => {
    const url = "https://civitai.com/api/download/models/123?token=${CIVITAI_TOKEN}";
    const out = resolveUrlTokens(url, { env: { CIVITAI_TOKEN: "abc123" } });
    expect(out).toBe("https://civitai.com/api/download/models/123?token=abc123");
  });

  it("treats empty-string env value as missing", () => {
    const url = "https://h.example/${TOKEN}";
    expect(() => resolveUrlTokens(url, { env: { TOKEN: "" } })).toThrowError(KonteError);
  });

  it("throws MISSING_TOKEN when a placeholder is unresolved", () => {
    const url = "https://h.example/${MISSING_VAR}";
    expect(() => resolveUrlTokens(url, { env: {} })).toThrowError(KonteError);
    try {
      resolveUrlTokens(url, { env: {} });
    } catch (err) {
      expect((err as KonteError).code).toBe("MISSING_TOKEN");
      expect((err as Error).message).toContain("MISSING_VAR");
    }
  });

  it("resolves multiple placeholders in a single URL", () => {
    const url = "https://${USER}:${PASS}@h.example/";
    const out = resolveUrlTokens(url, { env: { USER: "u", PASS: "p" } });
    expect(out).toBe("https://u:p@h.example/");
  });

  it("lists all missing vars in the error message", () => {
    const url = "https://${A}:${B}@h.example/";
    try {
      resolveUrlTokens(url, { env: {} });
    } catch (err) {
      expect((err as Error).message).toContain("A");
      expect((err as Error).message).toContain("B");
    }
  });
});
