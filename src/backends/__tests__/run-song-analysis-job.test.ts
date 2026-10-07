import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../../core/job-manager.js";
import { queueSongAnalyses, unreadSongTakes } from "../../core/song-queue.js";
import { resolveSongTake, songReadingsOf } from "../../core/song-take.js";
import { StateManager } from "../../core/state/index.js";
import type { Direction } from "../../core/dsl/direction.js";
import { directionDefaults } from "../../core/__tests__/helpers/direction.js";
import { runSongAnalysisJob } from "../run-song-analysis-job.js";

// What Beat This! hears in the click track below: a beat every half second from 0.5s, a bar head on
// every fourth.
vi.mock("../../core/beat-this.js", () => {
  const beats = Array.from({ length: 23 }, (_, k) => 0.5 + k * 0.5);
  return {
    detectBeats: async () => ({
      beats,
      downbeats: beats.filter((_, k) => k % 4 === 0),
      durationSec: 12,
    }),
  };
});

// A 16-bit mono WAV of a kick on every beat of 120 BPM from 0.5s, the bar head's louder.
async function writeClickTrack(file: string, seconds: number): Promise<void> {
  const rate = 24000;
  const samples = new Int16Array(rate * seconds);
  for (let k = 0; 0.5 + k * 0.5 < seconds; k++) {
    const from = Math.round((0.5 + k * 0.5) * rate);
    const gain = k % 4 === 0 ? 0.8 : 0.4;
    for (let i = 0; i < rate * 0.1 && from + i < samples.length; i++) {
      const t = i / rate;
      samples[from + i] = Math.round(
        32767 * gain * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 30),
      );
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
}

const direction = {
  ...directionDefaults,
  policy: { ...directionDefaults.policy, song: "song" },
  sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
} as Direction;

let videoRoot: string;

beforeEach(async () => {
  videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "konte-song-job-"));
  await writeClickTrack(path.join(videoRoot, "assets/reference/song/v-take1/song.wav"), 12);
  await fs.writeFile(
    path.join(videoRoot, "konte.state.json"),
    JSON.stringify({
      schemaVersion: 1,
      assets: {
        "reference:song": {
          variants: {
            "v-take1": {
              status: "none",
              file: "assets/reference/song/v-take1/song.wav",
              outputHash: "h1",
              createdAt: "2026-09-30T00:00:00.000Z",
            },
            "v-gone": {
              status: "dismissed",
              file: "assets/reference/song/v-take1/song.wav",
              outputHash: "h2",
              createdAt: "2026-09-29T00:00:00.000Z",
            },
          },
        },
      },
    }),
  );
});

afterEach(async () => {
  await fs.rm(videoRoot, { recursive: true, force: true });
});

// What the daemon does for a video's song-analysis jobs, in one pass.
async function runPendingSongAnalyses(jobManager: JobManager, videoRoot: string) {
  const jobs = (await jobManager.listJobs()).filter(
    (j) => j.kind === "song-analysis" && (j.status === "pending" || j.status === "running"),
  );
  const results = [];
  for (const j of jobs) results.push(await runSongAnalysisJob(jobManager, videoRoot, j.id));
  return results;
}

describe("song analysis", () => {
  it("reads every landed take once, and records what it read on the variant", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = () => StateManager.load(videoRoot).then((m) => m.getState());

    expect(
      await queueSongAnalyses({ videoRoot, direction, state: await state(), jobManager }),
    ).toEqual(["song-v-take1"]);
    const results = await runPendingSongAnalyses(jobManager, videoRoot);
    expect(results.map((r) => r.status)).toEqual(["completed"]);

    const take = resolveSongTake(videoRoot, await state(), "reference:song");
    expect(take?.variantId).toBe("v-take1");
    expect(take?.analysis.beatsPerBar).toBe(4);
    expect(take!.analysis.beats[take!.analysis.firstBeat]).toBe(0.5);
    // The separator is pinned to nothing in tests, so no line can be placed.
    expect(take?.analysis.phrases).toBeNull();
    expect(await jobManager.readLog("song-v-take1")).toMatch(/could not be separated/);

    // Read once: a second pass queues nothing.
    expect(
      await queueSongAnalyses({ videoRoot, direction, state: await state(), jobManager }),
    ).toEqual([]);
  });

  it("queues nothing for a piece cut to no song", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = (await StateManager.load(videoRoot)).getState();
    expect(
      await queueSongAnalyses({
        videoRoot,
        direction: { ...direction, policy: directionDefaults.policy } as Direction,
        state,
        jobManager,
      }),
    ).toEqual([]);
  });

  it("records nothing for a job cancelled while it read", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = () => StateManager.load(videoRoot).then((m) => m.getState());
    const [id] = await queueSongAnalyses({
      videoRoot,
      direction,
      state: await state(),
      jobManager,
    });
    const result = await runSongAnalysisJob(jobManager, videoRoot, id!, {
      onStarted: () => {
        void jobManager.updateIfNotTerminal(id!, { status: "cancelled" });
      },
    });
    expect(result.status).toBe("cancelled");
    expect((await jobManager.getJob(id!)).status).toBe("cancelled");
    expect((await state()).assets["reference:song"]?.variants?.["v-take1"]?.song).toBeUndefined();
  });

  it("keeps the reading beside the take, and reads it again once that file is gone", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = () => StateManager.load(videoRoot).then((m) => m.getState());
    await queueSongAnalyses({ videoRoot, direction, state: await state(), jobManager });
    await runPendingSongAnalyses(jobManager, videoRoot);
    const record = (await state()).assets["reference:song"]?.variants?.["v-take1"]?.song;
    expect(Object.keys(record ?? {}).sort()).toEqual(["lang", "reading"]);

    const readings = songReadingsOf(videoRoot, await state());
    await fs.rm(path.join(videoRoot, "assets/reference/song/v-take1/song.json"));
    expect(resolveSongTake(videoRoot, await state(), "reference:song")).toBeNull();
    expect(songReadingsOf(videoRoot, await state())).not.toBe(readings);
    expect(unreadSongTakes(videoRoot, direction, await state()).map((t) => t.variantId)).toEqual([
      "v-take1",
    ]);
  });

  it("reads a take again once its file is replaced", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = () => StateManager.load(videoRoot).then((m) => m.getState());
    await queueSongAnalyses({ videoRoot, direction, state: await state(), jobManager });
    await runPendingSongAnalyses(jobManager, videoRoot);
    await StateManager.withLock(videoRoot, async (m) => {
      const v = m.getState().assets["reference:song"]!.variants!["v-take1"]!;
      v.outputHash = "h1-replaced";
      delete v.song;
    });
    expect(
      await queueSongAnalyses({ videoRoot, direction, state: await state(), jobManager }),
    ).toEqual(["song-v-take1"]);
  });

  it("has the reading on disk by the time the job completes", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = () => StateManager.load(videoRoot).then((m) => m.getState());
    const [id] = await queueSongAnalyses({
      videoRoot,
      direction,
      state: await state(),
      jobManager,
    });
    const finish = jobManager.finishIfOwner.bind(jobManager);
    let onDisk: unknown = "unseen";
    jobManager.finishIfOwner = async (...args) => {
      onDisk = resolveSongTake(videoRoot, await state(), "reference:song")?.analysis;
      return finish(...args);
    };
    await runSongAnalysisJob(jobManager, videoRoot, id!);
    expect(onDisk).toMatchObject({ beats: expect.any(Array) });
  });

  it("reads a take again once the declared language changes", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = () => StateManager.load(videoRoot).then((m) => m.getState());
    await queueSongAnalyses({ videoRoot, direction, state: await state(), jobManager });
    await runPendingSongAnalyses(jobManager, videoRoot);
    expect((await state()).assets["reference:song"]?.variants?.["v-take1"]?.song?.lang).toBe(
      direction.policy.lang,
    );

    const relanged = { ...direction, policy: { ...direction.policy, lang: "ja" } } as Direction;
    expect(unreadSongTakes(videoRoot, relanged, await state()).map((t) => t.variantId)).toEqual([
      "v-take1",
    ]);
    expect(
      await queueSongAnalyses({ videoRoot, direction: relanged, state: await state(), jobManager }),
    ).toEqual(["song-v-take1"]);
    await runPendingSongAnalyses(jobManager, videoRoot);
    expect((await state()).assets["reference:song"]?.variants?.["v-take1"]?.song?.lang).toBe("ja");
  });

  it("keeps what a person set on the take over a reading taken again", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = () => StateManager.load(videoRoot).then((m) => m.getState());
    const song = () => state().then((s) => s.assets["reference:song"]?.variants?.["v-take1"]?.song);
    await queueSongAnalyses({ videoRoot, direction, state: await state(), jobManager });
    await runPendingSongAnalyses(jobManager, videoRoot);
    const lines = { "1.1": { text: "hello", startSec: 2, endSec: 3 } };
    const firstBeatSet = 2.5;
    await StateManager.withLock(videoRoot, async (m) => {
      const v = m.getState().assets["reference:song"]!.variants!["v-take1"]!;
      v.song = { ...v.song!, firstBeatSet, lines };
    });

    const relanged = { ...direction, policy: { ...direction.policy, lang: "ja" } } as Direction;
    await queueSongAnalyses({ videoRoot, direction: relanged, state: await state(), jobManager });
    await runPendingSongAnalyses(jobManager, videoRoot);
    expect(await song()).toMatchObject({ lang: "ja", firstBeatSet, lines });

    const before = (await song())!.reading;
    const job = await jobManager.ensureSongAnalysisJob({
      address: "reference:song",
      variantId: "v-take1",
      outputHash: "h1",
      lang: relanged.policy.lang,
      again: true,
    });
    expect(await runSongAnalysisJob(jobManager, videoRoot, job.id)).toMatchObject({
      status: "completed",
      ranAnalysis: true,
    });
    expect(await song()).toMatchObject({ firstBeatSet, lines });
    expect((await song())!.reading).toBe(before);
  });

  it("takes over a run whose holder died once its lease lapses", async () => {
    const jobManager = new JobManager(videoRoot);
    const state = () => StateManager.load(videoRoot).then((m) => m.getState());
    const [id] = await queueSongAnalyses({
      videoRoot,
      direction,
      state: await state(),
      jobManager,
    });
    expect(await jobManager.claimJobForRun(id!, "w-dead", -1)).toBeTruthy();
    const result = await runSongAnalysisJob(jobManager, videoRoot, id!);
    expect(result).toMatchObject({ status: "completed", ranAnalysis: true });
  });
});
