import { KonteError } from "./errors.js";

export function parseTimecode(input: string): number {
  if (/^\d+(\.\d+)?s$/.test(input)) {
    return Number.parseFloat(input.slice(0, -1));
  }

  const hhmmss = /^(\d+):(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(input);
  if (hhmmss) {
    const hours = Number.parseInt(hhmmss[1]!, 10);
    const minutes = Number.parseInt(hhmmss[2]!, 10);
    return hours * 3600 + minutes * 60 + Number.parseFloat(hhmmss[3]!);
  }

  const mmss = /^(\d+):(\d{2}(?:\.\d+)?)$/.exec(input);
  if (mmss) {
    const minutes = Number.parseInt(mmss[1]!, 10);
    return minutes * 60 + Number.parseFloat(mmss[2]!);
  }

  if (/^\d+(\.\d+)?$/.test(input)) {
    return Number.parseFloat(input);
  }

  throw new KonteError(
    "INVALID_TIMECODE",
    `Invalid timecode format: "${input}". Supported: "90s", "1:30", "00:01:30", "1:30.5"`,
  );
}
