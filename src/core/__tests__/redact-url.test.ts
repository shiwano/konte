import { describe, expect, it } from "vitest";
import { redactErrorBody, redactUrlSecret } from "../redact-url.js";

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

describe("redactErrorBody", () => {
  it("strips the signed query from every URL the server echoed back", () => {
    const body = JSON.stringify({
      detail: "invalid input",
      input: {
        image_url: "https://cdn.fal.ai/in/a.png?X-Amz-Signature=deadbeef",
        video_url: "https://storage.example/b.mp4?token=hunter2",
      },
    });
    const redacted = redactErrorBody(body);
    expect(redacted).not.toContain("deadbeef");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("https://cdn.fal.ai/in/a.png");
    expect(redacted).toContain("https://storage.example/b.mp4");
  });

  it("keeps a body with no URL intact", () => {
    expect(redactErrorBody("model not found")).toBe("model not found");
  });

  it("redacts a URL whose slashes the server escaped (JSON's optional \\/ form)", () => {
    const redacted = redactErrorBody(
      '{"detail":"bad input: https:\\/\\/storage.example\\/in\\/a.mp4?token=hunter2"}',
    );
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("https://storage.example/in/a.mp4");
  });

  it("caps a huge body (an HTML error page) instead of persisting it whole", () => {
    const redacted = redactErrorBody("x".repeat(5000));
    expect(redacted.length).toBeLessThan(600);
    expect(redacted).toContain("(truncated)");
  });
});
