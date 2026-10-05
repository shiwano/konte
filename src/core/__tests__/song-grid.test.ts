import { describe, expect, it } from "vitest";
import { type SongGridSource, songBeatAt, songBeatSec, songTempo } from "../song-grid.js";

// `count` beats `periodSec` apart from `fromSec`.
const beatsFrom = (fromSec: number, periodSec: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => fromSec + i * periodSec);

const grid = (beats: number[], firstBeat: number, firstBeatSet?: number): SongGridSource => ({
  beats,
  firstBeat,
  beatsPerBar: 4,
  ...(firstBeatSet !== undefined ? { firstBeatSet } : {}),
});

describe("songBeatSec", () => {
  it("counts the read beats from beat 0", () => {
    const g = grid([1, 1.5, 2, 2.5, 3], 1);
    expect(songBeatSec(g, 0)).toBe(1.5);
    expect(songBeatSec(g, 1)).toBe(2);
    expect(songBeatSec(g, -1)).toBe(1);
    expect(songBeatSec(g, 0.5)).toBeCloseTo(1.75, 9);
  });

  it("follows a tempo that changes between beats", () => {
    const g = grid([0, 0.5, 1, 1.6, 2.2], 0);
    expect(songBeatSec(g, 2.5)).toBeCloseTo(1.3, 9);
    expect(songBeatSec(g, 4)).toBeCloseTo(2.2, 9);
  });

  it("runs on past the last beat at the last interval, and before the first at the first", () => {
    const g = grid([1, 1.5, 2, 2.6], 0);
    expect(songBeatSec(g, 5)).toBeCloseTo(3.8, 9);
    expect(songBeatSec(g, -2)).toBeCloseTo(0, 9);
  });

  it("counts from the read beat a person made beat 0, nearest the second they set", () => {
    const g = grid([1, 1.5, 2, 2.5, 3], 1, 2.1);
    expect(songBeatSec(g, 0)).toBe(2);
    expect(songBeatSec(g, -2)).toBe(1);
    expect(songBeatSec(g, 2)).toBe(3);
  });
});

describe("songBeatAt", () => {
  it("is songBeatSec's inverse, inside and outside the read beats", () => {
    const g = grid([0.3, 0.8, 1.35, 1.9, 2.4, 3.0], 1, 1.3);
    for (const beat of [-3, -1.5, -0.25, 0, 0.5, 1, 1.75, 2, 3.2, 4, 6.5]) {
      expect(songBeatAt(g, songBeatSec(g, beat))).toBeCloseTo(beat, 9);
    }
    for (const sec of [0, 0.3, 1, 2.45, 3.5, 10]) {
      expect(songBeatSec(g, songBeatAt(g, sec))).toBeCloseTo(sec, 9);
    }
  });
});

describe("songTempo", () => {
  it("reads one tempo off steady beats", () => {
    expect(songTempo(grid(beatsFrom(0, 0.5, 33), 0))).toEqual({ bpm: 120 });
  });

  it("reads a range off beats whose tempo moves", () => {
    const beats: number[] = [];
    for (let t = 0, p = 60 / 92; beats.length < 65; t += p, p = Math.max(60 / 118, p - 0.004)) {
      beats.push(t);
    }
    const tempo = songTempo(grid(beats, 0));
    expect(tempo).toHaveProperty("minBpm");
    expect(tempo).toHaveProperty("maxBpm");
  });
});
