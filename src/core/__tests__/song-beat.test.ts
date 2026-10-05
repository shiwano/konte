import { describe, expect, it } from "vitest";
import {
  ANALYSIS_RATE,
  firstBeatOf,
  meterOf,
  readSongBeat,
  readSungPhrases,
} from "../song-beat.js";

// Silence for `silentSec`, then a steady tone to `durationSec`.
function take(silentSec: number, durationSec: number): Float32Array {
  const samples = new Float32Array(Math.round(durationSec * ANALYSIS_RATE));
  for (let i = Math.round(silentSec * ANALYSIS_RATE); i < samples.length; i++) {
    samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / ANALYSIS_RATE);
  }
  return samples;
}

// `count` beats `periodSec` apart from `fromSec`.
const beatsFrom = (fromSec: number, periodSec: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => Math.round((fromSec + i * periodSec) * 1000) / 1000);

describe("meterOf", () => {
  it("counts the beats between bar heads", () => {
    const beats = beatsFrom(0.5, 0.5, 24);
    expect(
      meterOf(
        beats,
        beats.filter((_, i) => i % 3 === 0),
      ),
    ).toBe(3);
    expect(
      meterOf(
        beats,
        beats.filter((_, i) => i % 4 === 0),
      ),
    ).toBe(4);
  });

  it("reads past a bar head the tracker missed", () => {
    const beats = beatsFrom(0.5, 0.5, 32);
    const heads = beats.filter((_, i) => i % 4 === 0 && i !== 12);
    expect(meterOf(beats, heads)).toBe(4);
  });

  it("takes the smaller count on a tie", () => {
    const beats = beatsFrom(0, 0.5, 20);
    expect(meterOf(beats, [beats[0]!, beats[3]!, beats[7]!])).toBe(3);
  });

  it("reads four beats to the bar with fewer than two bar heads", () => {
    const beats = beatsFrom(0, 0.5, 12);
    expect(meterOf(beats, [])).toBe(4);
    expect(meterOf(beats, [beats[2]!])).toBe(4);
  });
});

describe("firstBeatOf", () => {
  it("is the first bar head at or after the first sound", () => {
    const beats = beatsFrom(0.1, 0.5, 20);
    const heads = beats.filter((_, i) => i % 4 === 1);
    expect(firstBeatOf(beats, heads, 1.0)).toBe(5);
  });

  it("takes a bar head a hair before the first sound", () => {
    const beats = beatsFrom(0.1, 0.5, 20);
    const heads = beats.filter((_, i) => i % 4 === 1);
    expect(firstBeatOf(beats, heads, 0.65)).toBe(1);
  });

  it("falls back to the first beat when no bar head follows the sound", () => {
    const beats = beatsFrom(0.1, 0.5, 8);
    expect(firstBeatOf(beats, [], 1.0)).toBe(2);
  });
});

describe("readSongBeat", () => {
  it("keeps the beats as heard and counts beat 0 and the meter off them", () => {
    const beats = beatsFrom(0.2, 0.5, 40);
    const downbeats = beats.filter((_, i) => i % 3 === 0);
    const reading = readSongBeat(take(1.4, 20), { beats, downbeats });
    expect(reading.beats).toEqual(beats);
    expect(reading.beatsPerBar).toBe(3);
    // The bar heads fall at 0.2, 1.7, …: 1.7 is the first at or after the sound at 1.4.
    expect(reading.beats[reading.firstBeat]).toBeCloseTo(1.7, 3);
    expect(reading.durationSec).toBeCloseTo(20, 3);
  });

  it("puts each section candidate on a bar head counted from beat 0", () => {
    const samples = take(0, 24);
    // Louder from 12s on: a section boundary.
    for (let i = Math.round(12 * ANALYSIS_RATE); i < samples.length; i++) samples[i]! *= 3;
    // The tempo drifts: a beat grows from 0.5s to 0.6s.
    const beats: number[] = [];
    for (let t = 0, p = 0.5; t < 24; t += p, p += 0.002) beats.push(Math.round(t * 1000) / 1000);
    const reading = readSongBeat(samples, {
      beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
    });
    const heads = new Set(beats.filter((_, i) => (i - reading.firstBeat) % 4 === 0));
    expect(reading.sectionSecs.length).toBeGreaterThan(0);
    for (const sec of reading.sectionSecs) expect(heads.has(sec)).toBe(true);
    expect(Math.min(...reading.sectionSecs.map((sec) => Math.abs(sec - 12)))).toBeLessThan(2.5);
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
