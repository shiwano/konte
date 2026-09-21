import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tagDeliverable } from "../ffmpeg.js";

const execFileAsync = promisify(execFile);

function hasFfmpeg(): boolean {
  try {
    execFileSync("which", ["ffmpeg"]);
    execFileSync("which", ["ffprobe"]);
    return true;
  } catch {
    return false;
  }
}

async function containerTags(file: string): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "quiet",
    "-show_entries",
    "format_tags",
    "-of",
    "json",
    file,
  ]);
  return (JSON.parse(stdout) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {};
}

async function makeDeliverable(file: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=2:size=320x240:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
}

// A custom key needs `-movflags use_metadata_tags`; without it the mov muxer drops it with no
// error at all. Only a real round-trip catches that regression.
describe.skipIf(!hasFfmpeg())("tagDeliverable", () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-tag-"));
    file = path.join(dir, "video.mp4");
    await makeDeliverable(file);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("burns konte's custom keys into the container and leaves the streams alone", async () => {
    const before = await execFileAsync("ffprobe", [
      "-v",
      "quiet",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
      file,
    ]);

    await tagDeliverable({
      file,
      tags: {
        konte_version: "0.0.1",
        konte_manifest: "mf-Ab12Cd34",
        konte_export_signature: "sig-abc123",
      },
    });

    expect(await containerTags(file)).toMatchObject({
      konte_version: "0.0.1",
      konte_manifest: "mf-Ab12Cd34",
      konte_export_signature: "sig-abc123",
    });

    const after = await execFileAsync("ffprobe", [
      "-v",
      "quiet",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
      file,
    ]);
    expect(after.stdout).toBe(before.stdout);
    expect(after.stdout).toContain("h264");
    expect(after.stdout).toContain("aac");
  });

  it("replaces the file in place, leaving no temp behind", async () => {
    await tagDeliverable({ file, tags: { konte_manifest: "mf-Zz99Yy88" } });

    expect(await fs.readdir(dir)).toEqual(["video.mp4"]);
    expect((await containerTags(file)).konte_manifest).toBe("mf-Zz99Yy88");
  });
});
