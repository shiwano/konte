import { describe, expect, it } from "vitest";
import { ANALYSIS_RATE, readSongBeat, readSungPhrases } from "../song-beat.js";

// A synthetic take: a kick on every beat of a `bpm` grid starting at `firstBeatSec`, the bar head's
// kick louder and carrying a bass note, a hi-hat between beats, and silence before the first beat.
function drumTake(opts: {
  bpm: number;
  firstBeatSec: number;
  beatsPerBar: number;
  durationSec: number;
}): Float32Array {
  const samples = new Float32Array(Math.round(opts.durationSec * ANALYSIS_RATE));
  const beat = 60 / opts.bpm;
  const add = (atSec: number, lengthSec: number, fn: (t: number) => number) => {
    const from = Math.round(atSec * ANALYSIS_RATE);
    const to = Math.min(samples.length, from + Math.round(lengthSec * ANALYSIS_RATE));
    for (let i = Math.max(0, from); i < to; i++) samples[i]! += fn((i - from) / ANALYSIS_RATE);
  };
  let noise = 1;
  const hiss = () => {
    noise = (noise * 16807) % 2147483647;
    return noise / 2147483647 - 0.5;
  };
  for (let k = 0; opts.firstBeatSec + k * beat < opts.durationSec; k++) {
    const at = opts.firstBeatSec + k * beat;
    const head = k % opts.beatsPerBar === 0;
    add(at, 0.12, (t) => (head ? 0.8 : 0.4) * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 30));
    if (head) add(at, beat * 0.9, (t) => 0.3 * Math.sin(2 * Math.PI * 110 * t));
    add(at + beat / 2, 0.03, () => 0.1 * hiss());
  }
  return samples;
}

describe("readSongBeat", () => {
  it("reads the tempo near the declared one and the first bar head at the first sound", () => {
    const reading = readSongBeat(
      drumTake({ bpm: 120, firstBeatSec: 0.3, beatsPerBar: 4, durationSec: 20 }),
      { bpm: 120, beatsPerBar: 4 },
    );
    expect(reading.bpm).toBeCloseTo(120, 0);
    expect(Math.abs(reading.downbeatSec - 0.3)).toBeLessThan(0.03);
  });

  it("reads a take that drifted off the declared tempo", () => {
    const reading = readSongBeat(
      drumTake({ bpm: 116, firstBeatSec: 0.5, beatsPerBar: 4, durationSec: 24 }),
      { bpm: 120, beatsPerBar: 4 },
    );
    expect(Math.abs(reading.bpm - 116)).toBeLessThan(0.2);
  });

  it("finds the bar head by its accent, not by the first beat", () => {
    // Two pickup beats before the first bar head at 1.3s: 0.3 and 0.8 carry no accent.
    const take = drumTake({ bpm: 120, firstBeatSec: 1.3, beatsPerBar: 4, durationSec: 20 });
    const pickup = drumTake({ bpm: 120, firstBeatSec: 0.3, beatsPerBar: 1000, durationSec: 1.3 });
    take.set(pickup.subarray(0, Math.round(1.25 * ANALYSIS_RATE)));
    const reading = readSongBeat(take, { bpm: 120, beatsPerBar: 4 });
    expect(Math.abs(reading.downbeatSec - 1.3)).toBeLessThan(0.03);
  });
});

describe("readSongBeat on a take that opens on its bar head", () => {
  it("reads the bar head at 0, never before the take", () => {
    // The first bar head 10ms before the cut: its attack is all that is left of it.
    const take = drumTake({ bpm: 120, firstBeatSec: 0.3, beatsPerBar: 4, durationSec: 20 });
    const reading = readSongBeat(take.subarray(Math.round(0.31 * ANALYSIS_RATE)), {
      bpm: 120,
      beatsPerBar: 4,
    });
    expect(reading.downbeatSec).toBeGreaterThanOrEqual(0);
    expect(reading.downbeatSec).toBeLessThan(0.03);
  });
});

describe("readSungPhrases", () => {
  // A tone for each [start, end), silence between.
  const sung = (spans: [number, number][], durationSec: number): Float32Array => {
    const samples = new Float32Array(Math.round(durationSec * ANALYSIS_RATE));
    for (const [from, to] of spans) {
      for (let i = Math.round(from * ANALYSIS_RATE); i < Math.round(to * ANALYSIS_RATE); i++) {
        samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / ANALYSIS_RATE);
      }
    }
    return samples;
  };

  it("reads each sung stretch off the vocal track", () => {
    const phrases = readSungPhrases(
      sung(
        [
          [1, 3],
          [4, 5.5],
        ],
        8,
      ),
    );
    expect(phrases.map((p) => [p.startSec, p.endSec])).toEqual([
      [1, 3],
      [4, 5.5],
    ]);
  });

  it("splits at a breath and drops a blip under 150ms", () => {
    const phrases = readSungPhrases(
      sung(
        [
          [1, 2],
          [2.1, 3],
          [5, 5.05],
        ],
        8,
      ),
    );
    expect(phrases.map((p) => [p.startSec, p.endSec])).toEqual([
      [1, 2],
      [2.1, 3],
    ]);
  });
});
