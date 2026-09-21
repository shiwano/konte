import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FalBackend, encodeBackendJobId } from "../backend.js";
import type { FalStatusResponse } from "../types.js";

// The result-collection half of waitForCompletion: which fields of a model's free-form result
// body become files, what each is named, and what happens to the shapes that carry no media.
function makeBackend(): FalBackend {
  return new FalBackend({ apiKey: "test-key" }, "/tmp");
}

const jobId = encodeBackendJobId("fal-ai/some-model", "req-1");
const out = (name: string): string => path.join("/tmp/out", name);

// Drive waitForCompletion against a completed job whose result body is `result`.
async function download(result: Record<string, unknown>): Promise<{
  files: string[];
  downloads: [string, string][];
}> {
  const backend = makeBackend();
  vi.spyOn(backend.httpClient, "getStatus").mockResolvedValue({
    status: "COMPLETED",
  } as FalStatusResponse);
  vi.spyOn(backend.httpClient, "getResult").mockResolvedValue(result);
  const downloadFile = vi.spyOn(backend.httpClient, "downloadFile").mockResolvedValue();

  const outcome = await backend.waitForCompletion(jobId, "/tmp/out");
  if (outcome.kind !== "done") throw new Error("expected the job to complete");
  return {
    files: outcome.result.files,
    downloads: downloadFile.mock.calls as [string, string][],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FalBackend result download", () => {
  it("keeps every output when supplied names collide across fields and arrays", async () => {
    const { files, downloads } = await download({
      image: { url: "https://fal.media/first", file_name: "image.png" },
      images: [
        { url: "https://fal.media/second", file_name: "image.png" },
        { url: "https://fal.media/third", file_name: "1-image.png" },
        { url: "https://fal.media/fourth", file_name: "folder/image.png" },
      ],
    });
    expect(new Set(files).size).toBe(4);
    expect(files).toEqual(downloads.map(([, dest]) => dest));
    expect(downloads.map(([url]) => url)).toEqual([
      "https://fal.media/first",
      "https://fal.media/second",
      "https://fal.media/third",
      "https://fal.media/fourth",
    ]);
  });
  it("names a media field's file from its file_name", async () => {
    const { files, downloads } = await download({
      video: { url: "https://fal.media/v.mp4", file_name: "clip.mp4", content_type: "video/mp4" },
    });

    expect(files).toEqual([out("clip.mp4")]);
    expect(downloads).toEqual([["https://fal.media/v.mp4", out("clip.mp4")]]);
  });

  it("falls back to the field name plus the content_type's extension", async () => {
    const { files } = await download({
      image: { url: "https://fal.media/i", content_type: "image/png" },
    });

    expect(files).toEqual([out("image.png")]);
  });

  it("leaves the name extensionless for an unknown content_type", async () => {
    const { files } = await download({
      audio: { url: "https://fal.media/a", content_type: "audio/aiff" },
    });

    expect(files).toEqual([out("audio")]);
  });

  it("collects every media field a result carries", async () => {
    const { files } = await download({
      video: { url: "https://fal.media/v", content_type: "video/mp4" },
      audio: { url: "https://fal.media/a", content_type: "audio/wav" },
    });

    expect(files).toEqual([out("video.mp4"), out("audio.wav")]);
  });

  it("collects an array field, indexing the names it has to synthesize", async () => {
    const { files, downloads } = await download({
      images: [
        { url: "https://fal.media/0", content_type: "image/webp" },
        { url: "https://fal.media/1", file_name: "second.png", content_type: "image/png" },
      ],
    });

    expect(files).toEqual([out("images_0.webp"), out("second.png")]);
    expect(downloads.map(([url]) => url)).toEqual(["https://fal.media/0", "https://fal.media/1"]);
  });

  it("collects a media object whose optional fields are null", async () => {
    const { files } = await download({
      images: [
        {
          url: "https://fal.media/0",
          content_type: "image/png",
          file_name: null,
          file_size: null,
          width: null,
          height: null,
        },
      ],
    });

    expect(files).toEqual([out("images_0.png")]);
  });

  it("skips an array element that carries no url", async () => {
    const { files } = await download({
      images: ["https://fal.media/bare-string", { url: "https://fal.media/1" }],
    });

    // A bare string is not a media object — only the { url } entry becomes a file.
    expect(files).toEqual([out("images_1")]);
  });

  it("fails the job when the result body yields no downloadable media", async () => {
    const backend = makeBackend();
    vi.spyOn(backend.httpClient, "getStatus").mockResolvedValue({
      status: "COMPLETED",
    } as FalStatusResponse);
    vi.spyOn(backend.httpClient, "getResult").mockResolvedValue({ seed: 42, video: "not-a-media" });
    const downloadFile = vi.spyOn(backend.httpClient, "downloadFile").mockResolvedValue();

    await expect(backend.waitForCompletion(jobId, "/tmp/out")).rejects.toMatchObject({
      code: "FAL_ERROR",
    });
    expect(downloadFile).not.toHaveBeenCalled();
  });
});
