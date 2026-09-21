import * as fs from "node:fs/promises";
import * as path from "node:path";

// A playable silent 16-bit mono WAV, for a take an accept will mix (the board's stem runs ffmpeg
// over its cues, so a name in state is not enough).
export async function writeSilentWav(file: string, seconds = 0.2): Promise<void> {
  const sampleRate = 8000;
  const samples = Math.round(sampleRate * seconds);
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(data, 40);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
}
