import { KonteError } from "./errors.js";

// The bounds HyperFrames clamps a rate to (`@hyperframes/parsers`' `MIN_PLAYBACK_RATE` /
// `MAX_PLAYBACK_RATE`).
export const MIN_PLAYBACK_RATE = 0.1;
export const MAX_PLAYBACK_RATE = 10;

export function assertPlaybackRate(value: unknown, hasAudio: boolean, label: string): void {
  if (value === undefined || value === null) return;
  const rate = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(rate) || rate < MIN_PLAYBACK_RATE || rate > MAX_PLAYBACK_RATE) {
    throw new KonteError(
      "PLAYBACK_RATE_INVALID",
      `${label}: playbackRate ${String(value)} is outside ${MIN_PLAYBACK_RATE}–${MAX_PLAYBACK_RATE}. ` +
        `1 is the take's own speed; the render clamps anything past the bounds.`,
    );
  }
  if (hasAudio && rate !== 1) {
    throw new KonteError(
      "PLAYBACK_RATE_INVALID",
      `${label} plays at playbackRate ${rate} with hasAudio, but the mux plays the take's audio at ` +
        `its own speed. Drop one of the two.`,
    );
  }
}
