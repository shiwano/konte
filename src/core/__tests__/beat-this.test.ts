import { describe, expect, it } from "vitest";
import {
  joinChunks,
  logMelSpectrogram,
  pickPeaks,
  snapDownbeats,
  splitChunks,
  type BeatThisFrontend,
} from "../beat-this.js";

// Each chunk's logits as the frame index it reads, so a joined frame shows which chunk won it.
function frameLogits(chunks: ReturnType<typeof splitChunks>, tag: (c: number) => number) {
  return chunks.map((chunk, c) => {
    const len = chunk.left + chunk.frames + chunk.right;
    return Float32Array.from({ length: len }, (_, i) => tag(c) * 10000 + chunk.start + i);
  });
}

describe("splitChunks", () => {
  it("reads a piece shorter than one chunk as one padded chunk", () => {
    expect(splitChunks(100)).toEqual([{ start: -6, left: 6, frames: 100, right: 6 }]);
  });

  it("reads a piece of exactly one chunk's kept span as one full chunk", () => {
    expect(splitChunks(1488)).toEqual([{ start: -6, left: 6, frames: 1488, right: 6 }]);
  });

  it("shifts the last chunk to end at the piece's end", () => {
    const chunks = splitChunks(2000);
    expect(chunks.map((c) => c.start)).toEqual([-6, 2000 - 1494]);
    const last = chunks.at(-1)!;
    expect(last.left + last.frames + last.right).toBe(1500);
    expect(last.start + last.left + last.frames).toBe(2000);
    expect(last.right).toBe(6);
  });

  it("steps by the chunk less both borders", () => {
    expect(splitChunks(4000).map((c) => c.start)).toEqual([-6, 1482, 4000 - 1494]);
  });
});

describe("joinChunks", () => {
  it("covers every frame of the piece once", () => {
    for (const total of [1, 100, 1488, 1489, 2000, 4000]) {
      const chunks = splitChunks(total);
      const joined = joinChunks(
        chunks,
        frameLogits(chunks, () => 0),
        total,
      );
      expect([...joined]).toEqual(Array.from({ length: total }, (_, t) => t));
    }
  });

  it("keeps the earlier chunk's frames where the shifted last chunk overlaps it", () => {
    const chunks = splitChunks(2000);
    const joined = joinChunks(
      chunks,
      frameLogits(chunks, (c) => c),
      2000,
    );
    expect(Math.floor(joined[1487]! / 10000)).toBe(0);
    expect(Math.floor(joined[1488]! / 10000)).toBe(1);
    expect(joined[1999]! % 10000).toBe(1999);
  });

  it("drops each chunk's borders", () => {
    const chunks = splitChunks(2000);
    // The second chunk's own first kept frame lies at its start + border.
    const joined = joinChunks(
      chunks,
      frameLogits(chunks, (c) => c),
      2000,
    );
    const second = chunks[1]!;
    expect(joined[second.start + 5]! < 10000).toBe(true);
  });
});

describe("pickPeaks", () => {
  it("takes local maxima within ±3 frames above logit 0", () => {
    const logits = new Float32Array(20).fill(-5);
    logits[2] = 3;
    logits[4] = 2; // within 3 of a higher peak
    logits[10] = -0.5; // a maximum, but under 0
    logits[15] = 1;
    expect(pickPeaks(logits)).toEqual([2, 15]);
  });

  it("averages adjacent equal maxima into one, each next frame measured from the running mean", () => {
    const logits = new Float32Array(20).fill(-5);
    logits[5] = 2;
    logits[6] = 2;
    logits[12] = 1;
    logits[13] = 1;
    logits[14] = 1;
    expect(pickPeaks(logits)).toEqual([5.5, 12.5, 14]);
  });

  it("reads a maximum at either end", () => {
    const logits = new Float32Array(10).fill(-5);
    logits[0] = 1;
    logits[9] = 1;
    expect(pickPeaks(logits)).toEqual([0, 9]);
  });
});

describe("snapDownbeats", () => {
  it("moves each bar head onto its nearest beat and drops duplicates", () => {
    expect(snapDownbeats([0.5, 1, 1.5, 2, 2.5], [0.98, 1.04, 2.46])).toEqual([1, 2.5]);
  });

  it("takes the earlier beat on a tie", () => {
    expect(snapDownbeats([1, 2], [1.5])).toEqual([1]);
  });

  it("leaves bar heads as heard when no beat is", () => {
    expect(snapDownbeats([], [2, 1, 2])).toEqual([1, 2]);
  });
});

describe("logMelSpectrogram", () => {
  const n = 16;
  const fe: BeatThisFrontend = {
    sample_rate: 22050,
    n_fft: n,
    hop_length: 4,
    n_mels: 2,
    window: Array.from({ length: n }, () => 1),
    mel_filters: [
      Array.from({ length: n / 2 + 1 }, (_, b) => (b === 0 ? 1 : 0)),
      Array.from({ length: n / 2 + 1 }, (_, b) => (b === 2 ? 1 : 0)),
    ],
  };

  it("frames a centred, reflect-padded signal every hop", () => {
    expect(logMelSpectrogram(new Float32Array(40), fe).length).toBe((1 + 10) * 2);
  });

  it("scales the STFT magnitude by 1/√n_fft before log1p(1000·x)", () => {
    const dc = logMelSpectrogram(new Float32Array(40).fill(0.5), fe);
    expect(dc[0]).toBeCloseTo(Math.log1p((1000 * 0.5 * n) / Math.sqrt(n)), 4);
    expect(dc[1]).toBeCloseTo(0, 4);
  });

  it("reads too short a signal as no frames", () => {
    expect(logMelSpectrogram(new Float32Array(8), fe).length).toBe(0);
  });
});
