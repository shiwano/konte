import { KonteError } from "./errors.js";

export interface SrtEntry {
  index: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export function parseSrt(content: string): SrtEntry[] {
  const entries: SrtEntry[] = [];
  const blocks = content.replace(/\r\n/g, "\n").trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;

    const index = Number.parseInt(lines[0]!, 10);
    if (Number.isNaN(index)) {
      throw new KonteError("SRT_PARSE_ERROR", `Invalid SRT index: "${lines[0]}"`);
    }

    const timecodeMatch =
      /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(
        lines[1]!,
      );
    if (!timecodeMatch) {
      throw new KonteError("SRT_PARSE_ERROR", `Invalid SRT timecode: "${lines[1]}"`);
    }

    const startSeconds =
      Number.parseInt(timecodeMatch[1]!, 10) * 3600 +
      Number.parseInt(timecodeMatch[2]!, 10) * 60 +
      Number.parseInt(timecodeMatch[3]!, 10) +
      Number.parseInt(timecodeMatch[4]!, 10) / 1000;

    const endSeconds =
      Number.parseInt(timecodeMatch[5]!, 10) * 3600 +
      Number.parseInt(timecodeMatch[6]!, 10) * 60 +
      Number.parseInt(timecodeMatch[7]!, 10) +
      Number.parseInt(timecodeMatch[8]!, 10) / 1000;

    const text = lines.slice(2).join("\n");
    entries.push({ index, startSeconds, endSeconds, text });
  }

  return entries;
}
