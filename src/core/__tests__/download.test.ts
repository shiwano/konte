import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile } from "../download.js";
import type { KonteError } from "../errors.js";

const PAYLOAD = "managed tool bytes";
const URL_OK = "https://example.test/tool.tar.xz";
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");

vi.mock("../tool-checksums.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tool-checksums.js")>();
  return {
    ...actual,
    toolChecksum: (url: string) => (url === URL_OK ? DIGEST : actual.toolChecksum(url)),
  };
});

vi.mock("../http-retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http-retry.js")>();
  return { ...actual, fetchWithRetry: vi.fn() };
});

const { fetchWithRetry } = await import("../http-retry.js");

function respondWith(body: string): void {
  vi.mocked(fetchWithRetry).mockResolvedValue(new Response(body, { status: 200 }));
}

let dir: string;
let dest: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "konte-download-"));
  dest = path.join(dir, "tool.tar.xz");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("downloadFile", () => {
  it("writes the file when the payload matches its pinned checksum", async () => {
    respondWith(PAYLOAD);
    await downloadFile(URL_OK, dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe(PAYLOAD);
  });

  it("leaves nothing behind when the payload does not match", async () => {
    respondWith("tampered bytes");
    await expect(downloadFile(URL_OK, dest)).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
    });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a URL the manifest does not pin, before any request", async () => {
    respondWith(PAYLOAD);
    await expect(downloadFile("https://example.test/unpinned.tar.xz", dest)).rejects.toMatchObject({
      code: "CHECKSUM_UNKNOWN",
    } satisfies Partial<KonteError>);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
