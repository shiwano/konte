import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assetSkipReason, inFlightVariantIds } from "../../core/generation-selection.js";
import { JobManager, jobsDbPath } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/index.js";
import type { AssetDefinition } from "../../core/types/index.js";
import { registerJobsBatch, skipWhileActive } from "../job-registration.js";

const comfyDef = { kind: "comfy" } as unknown as AssetDefinition;
const NO_JOBS: ReadonlySet<string> = new Set();

describe("registerJobsBatch", () => {
  async function setup(): Promise<{ dir: string; jobManager: JobManager }> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-genorch-"));
    await StateManager.init(dir);
    return { dir, jobManager: new JobManager(dir) };
  }
  const request = (address: string) => ({
    address,
    assetDef: comfyDef,
    variantCount: 1,
    skip: skipWhileActive,
  });

  it("skips an address a concurrent run already registered a job at", async () => {
    const { dir, jobManager } = await setup();

    const [first] = await registerJobsBatch(dir, jobManager, [request("video:shot.01.clip")]);
    const [second, other] = await registerJobsBatch(dir, jobManager, [
      request("video:shot.01.clip"),
      request("video:shot.02.clip"),
    ]);

    expect(first!.jobs).toHaveLength(1);
    expect(jobManager.hasJob(first!.jobs[0]!.variantId)).toBe(true);
    expect(second).toMatchObject({ status: "skipped", skipReason: "active", jobs: [] });
    expect(other!.jobs).toHaveLength(1);
  });

  it("skips an address a concurrent run's take became ready at after the caller judged it", async () => {
    const { dir, jobManager } = await setup();
    const address = "video:shot.01.clip";
    const judged = await StateManager.load(dir);
    const skip = (m: StateManager, live: ReadonlySet<string>, a: string) =>
      assetSkipReason(m, live, a);
    expect(skip(judged, NO_JOBS, address)).toBeNull();

    const [rival] = await registerJobsBatch(dir, jobManager, [request(address)]);
    const rivalId = rival!.jobs[0]!.variantId;
    await StateManager.withLock(dir, async (m) => {
      m.getAssetState(address).variants![rivalId]!.file = "out.png";
    });
    await jobManager.updateJob(rivalId, { status: "completed" });

    const [result] = await registerJobsBatch(dir, jobManager, [{ ...request(address), skip }]);

    expect(result).toMatchObject({ status: "skipped", skipReason: "ready", jobs: [] });
    const variants = (await StateManager.load(dir)).getAssetState(address).variants!;
    expect(Object.keys(variants)).toEqual([rivalId]);
  });

  it("creates prereq jobs only for an address it registers", async () => {
    const { dir, jobManager } = await setup();
    const address = "video:shot.01.clip";
    await registerJobsBatch(dir, jobManager, [request(address)]);
    const calls: string[] = [];
    const prereqJobs = (a: string) => async () => {
      calls.push(a);
      return ["comfy-model-x"];
    };

    const [skipped, registered] = await registerJobsBatch(dir, jobManager, [
      { ...request(address), prereqJobs: prereqJobs(address) },
      { ...request("video:shot.02.clip"), prereqJobs: prereqJobs("video:shot.02.clip") },
    ]);

    expect(skipped).toMatchObject({ status: "skipped", skipReason: "active" });
    expect(calls).toEqual(["video:shot.02.clip"]);
    const job = await jobManager.getJob(registered!.jobs[0]!.variantId);
    expect(job.kind === "generation" && job.dependsOnJobs).toEqual(["comfy-model-x"]);
  });

  it("registers nothing of the batch when a prereq job cannot be created", async () => {
    const { dir, jobManager } = await setup();

    await expect(
      registerJobsBatch(dir, jobManager, [
        request("video:shot.01.clip"),
        {
          ...request("video:shot.02.clip"),
          prereqJobs: async () => {
            throw new Error("missing token");
          },
        },
      ]),
    ).rejects.toThrow("missing token");
    expect(await jobManager.listJobs()).toEqual([]);
    const state = (await StateManager.load(dir)).getState();
    expect(state.assets["video:shot.01.clip"]?.variants ?? {}).toEqual({});
  });

  it("marks a reservation whose job was never created failed, and registers anew", async () => {
    const { dir, jobManager } = await setup();
    const stranded = await StateManager.withLock(dir, async (m) =>
      m.reserveVariantId("video:shot.01.clip"),
    );

    const [result] = await registerJobsBatch(dir, jobManager, [request("video:shot.01.clip")]);

    expect(result!.jobs).toHaveLength(1);
    const manager = await StateManager.load(dir);
    const active = new Set([result!.jobs[0]!.variantId]);
    expect(inFlightVariantIds(manager.getState(), "video:shot.01.clip", active)).toEqual([
      result!.jobs[0]!.variantId,
    ]);
    expect(
      manager.getAssetState("video:shot.01.clip").variants![stranded]!.metadata?.error,
    ).toBeDefined();
  });

  it("registers past a reserved take whose job record is corrupt", async () => {
    const { dir, jobManager } = await setup();
    const vid = await StateManager.withLock(dir, async (m) =>
      m.reserveVariantId("video:shot.01.clip"),
    );
    await jobManager.createJob({
      address: "video:shot.01.clip",
      variantId: vid,
      resolvedDeps: {},
      backendKind: "comfy",
    });
    new Database(jobsDbPath(dir)).run("UPDATE jobs SET data = ? WHERE id = ?", ["{", vid]);

    const [result] = await registerJobsBatch(dir, jobManager, [request("video:shot.01.clip")]);

    expect(result!.jobs).toHaveLength(1);
  });

  it("refuses a rival that registered after the caller listed jobs", async () => {
    const { dir, jobManager } = await setup();
    const listedBefore = await jobManager.listJobs();
    await registerJobsBatch(dir, jobManager, [request("video:patch.v-src.edit")]);

    await expect(
      registerJobsBatch(dir, jobManager, [
        {
          ...request("video:patch.v-src.edit"),
          skip: undefined,
          rivals: (jobs) => {
            expect(jobs.length).toBeGreaterThan(listedBefore.length);
            return new Set(jobs.map((j) => j.id));
          },
        },
      ]),
    ).rejects.toMatchObject({ code: "PATCH_ALREADY_APPLYING" });
  });

  it("leaves no reservation behind when a job cannot be created", async () => {
    const { dir, jobManager } = await setup();
    jobManager.createJob = async () => {
      throw new Error("disk full");
    };

    await expect(
      registerJobsBatch(dir, jobManager, [request("video:shot.01.clip")]),
    ).rejects.toThrow("disk full");
    const manager = await StateManager.load(dir);
    expect(manager.tryGetAssetState("video:shot.01.clip")?.variants ?? {}).toEqual({});
  });
});
