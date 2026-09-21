import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../atomic-write.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-atomic-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("creates parent directories", async () => {
    const target = path.join(tmpDir, "nested", "deep", "out.bin");
    await writeFileAtomic(target, Buffer.from("hello"));
    expect((await fs.readFile(target)).toString()).toBe("hello");
  });

  it("never leaves a partial file under concurrent writers and cleans up temps", async () => {
    const target = path.join(tmpDir, "out.bin");
    // Two distinct buffers of identical length, like two waiters downloading the same
    // (deterministic) output. A non-atomic write could interleave into a corrupt blob.
    const size = 4 * 1024 * 1024;
    const a = Buffer.alloc(size, 0xaa);
    const b = Buffer.alloc(size, 0xbb);

    await Promise.all([
      writeFileAtomic(target, a),
      writeFileAtomic(target, b),
      writeFileAtomic(target, a),
      writeFileAtomic(target, b),
    ]);

    const result = await fs.readFile(target);
    expect(result.length).toBe(size);
    // The final file must be byte-identical to one of the inputs — not a mix.
    const isA = result.equals(a);
    const isB = result.equals(b);
    expect(isA || isB).toBe(true);

    // No leftover temp files.
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual(["out.bin"]);
  });
});
