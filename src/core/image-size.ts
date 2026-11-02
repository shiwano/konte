import * as fs from "node:fs/promises";
import { probeVideoDimensions } from "./video-probe.js";

type Size = { width: number; height: number };

/** The width and height of a JPEG or PNG off its header; null for any other. */
export function imageHeaderSize(bytes: Buffer): Size | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** An image file's size off its header, else ffprobe's; null where neither reads it. */
export async function imageFileSize(file: string): Promise<Size | null> {
  const bytes = await fs.readFile(file).catch(() => null);
  return (bytes && imageHeaderSize(bytes)) ?? probeVideoDimensions(file);
}
