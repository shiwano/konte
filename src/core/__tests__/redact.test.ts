import { describe, expect, it } from "vitest";
import { redactExternalBody, redactUrlSecret } from "../redact.js";

describe("redactUrlSecret", () => {
  it("drops the query where a signed token lives", () => {
    expect(redactUrlSecret("https://cdn.fal.ai/files/out.mp4?token=abc123&exp=999")).toBe(
      "https://cdn.fal.ai/files/out.mp4",
    );
  });

  it("drops the fragment too", () => {
    expect(redactUrlSecret("https://h.example/a/b#sig=xyz")).toBe("https://h.example/a/b");
  });

  it("keeps a URL with no query untouched", () => {
    expect(redactUrlSecret("https://h.example/a/b")).toBe("https://h.example/a/b");
  });

  it("truncates a non-URL string at the first query/fragment marker", () => {
    expect(redactUrlSecret("not-a-url?token=secret")).toBe("not-a-url");
  });
});

describe("redactExternalBody", () => {
  it("strips the signed query from every URL the server echoed back", () => {
    const body = JSON.stringify({
      detail: "invalid input",
      input: {
        image_url: "https://cdn.fal.ai/in/a.png?X-Amz-Signature=deadbeef",
        video_url: "https://storage.example/b.mp4?token=hunter2",
      },
    });
    const redacted = redactExternalBody(body, []);
    expect(redacted).not.toContain("deadbeef");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("https://cdn.fal.ai/in/a.png");
    expect(redacted).toContain("https://storage.example/b.mp4");
  });

  it("keeps a body with no URL intact", () => {
    expect(redactExternalBody("model not found", [])).toBe("model not found");
  });

  it("redacts a URL whose slashes the server escaped (JSON's optional \\/ form)", () => {
    const redacted = redactExternalBody(
      '{"detail":"bad input: https:\\/\\/storage.example\\/in\\/a.mp4?token=hunter2"}',
      [],
    );
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("https://storage.example/in/a.mp4");
  });

  it("caps a huge body (an HTML error page) instead of persisting it whole", () => {
    const redacted = redactExternalBody("x".repeat(5000), []);
    expect(redacted.length).toBeLessThan(600);
    expect(redacted).toContain("(truncated)");
  });

  it("reverses a resolved token value back to its placeholder", () => {
    expect(
      redactExternalBody("server rejected Bearer abc123", ["Bearer ${COMFYUI_TOKEN}"], {
        env: { COMFYUI_TOKEN: "abc123" },
      }),
    ).toBe("server rejected Bearer ${COMFYUI_TOKEN}");
  });

  it("redacts every occurrence across multiple templates and vars", () => {
    expect(
      redactExternalBody("u, p-longer, u", ["https://${USER}:${PASS}@h/"], {
        env: { USER: "u", PASS: "p-longer" },
      }),
    ).toBe("${USER}, ${PASS}, ${USER}");
  });

  it("replaces longer secrets first so a contained secret isn't left partly exposed", () => {
    expect(
      redactExternalBody("abcdef", ["${SHORT}${TOKEN}"], { env: { SHORT: "ab", TOKEN: "abcdef" } }),
    ).toBe("${TOKEN}");
  });

  it("ignores unresolved and empty vars", () => {
    expect(redactExternalBody("unchanged", ["${MISSING}${EMPTY}"], { env: { EMPTY: "" } })).toBe(
      "unchanged",
    );
  });

  it("reverses a token the truncation point would otherwise split", () => {
    const secret = "s".repeat(40);
    const redacted = redactExternalBody(`${"x".repeat(480)}${secret}`, ["${FAL_KEY}"], {
      env: { FAL_KEY: secret },
    });
    expect(redacted).not.toContain("s".repeat(10));
    expect(redacted).toContain("${FAL_KEY}");
  });

  it("reverses a token whose slashes the server escaped", () => {
    expect(redactExternalBody('{"key":"a\\/b"}', ["${K}"], { env: { K: "a/b" } })).toBe(
      '{"key":"${K}"}',
    );
  });
});
