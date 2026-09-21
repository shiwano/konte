import { KonteError } from "./errors.js";

// The ceiling HyperFrames' Web Audio preview and FFmpeg mixer share (`@hyperframes/core`'s
// `MAX_AUDIO_GAIN_DB`).
export const MAX_AUDIO_GAIN_DB = 12;
export const MAX_AUDIO_GAIN = 10 ** (MAX_AUDIO_GAIN_DB / 20);

export function assertAudioGain(value: unknown, where: string): void {
  if (value === undefined || value === null) return;
  const gain = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(gain) && gain >= 0 && gain <= MAX_AUDIO_GAIN) return;
  throw new KonteError(
    "AUDIO_GAIN_INVALID",
    `${where}: volume ${String(value)} is outside 0–${MAX_AUDIO_GAIN.toFixed(2)} ` +
      `(+${MAX_AUDIO_GAIN_DB} dB). 1 is unity; the preview clamps anything above the ceiling ` +
      `while the export does not, so a louder take is fixed at the source instead.`,
  );
}
